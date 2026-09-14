#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum InvoiceError {
    Unauthorized = 1, InvalidAmount = 2, InvoiceNotFound = 3,
    AlreadyPaid = 4, AlreadyCancelled = 5, Expired = 6, PayerMismatch = 7,
}

// ─── TTL budget ──────────────────────────────────────────────────────────────
// Ledgers close roughly every 5 seconds, so 17_280 ledgers ≈ 1 day and
// 518_400 ledgers ≈ 30 days. Each invoice is now its own persistent entry
// (previously every invoice lived in one instance-storage Map, so issuing any
// invoice rewrote every invoice). The per-merchant index is a key per position
// rather than a `Map<Address, Vec<u64>>` that grew without bound.
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;
const INVOICE_TTL_THRESHOLD: u32 = 17_280;
const INVOICE_TTL_EXTEND_TO: u32 = 518_400;
const INDEX_TTL_THRESHOLD: u32 = 17_280;
const INDEX_TTL_EXTEND_TO: u32 = 518_400;

/// Largest page a listing entry point will return in one call.
const MAX_PAGE_SIZE: u32 = 100;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    NextInvoice,
    /// One persistent entry per invoice.
    Invoice(u64),
    /// Position (1-based) → invoice id, for one merchant. Paginating over this
    /// replaces the previous unbounded `Vec<u64>` per merchant.
    MerchantInvoiceIndex(Address, u64),
    /// How many invoices a merchant has issued, so `invoices_of` knows its
    /// upper bound without scanning.
    MerchantInvoiceCount(Address),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub id: u64, pub merchant: Address, pub customer: Address, pub token: Address,
    pub amount: i128, pub description: String, pub due: u64, pub paid: bool, pub cancelled: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct IssuedEvent { pub id: u64, pub merchant: Address, pub customer: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct PaidEvent { pub id: u64, pub payer: Address, pub merchant: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct CancelledEvent { pub id: u64, pub merchant: Address }

#[contract]
pub struct InvoicesContract;

#[contractimpl]
impl InvoicesContract {
    pub fn create(env: Env, merchant: Address, customer: Address, token: Address, amount: i128, description: String, due: u64) -> Result<u64, InvoiceError> {
        if amount <= 0 { return Err(InvoiceError::InvalidAmount); }
        merchant.require_auth();
        let next: u64 = env.storage().instance().get(&DataKey::NextInvoice).unwrap_or(1);
        let invoice = Invoice { id: next, merchant: merchant.clone(), customer: customer.clone(), token: token.clone(), amount, description, due, paid: false, cancelled: false };
        env.storage().persistent().set(&DataKey::Invoice(next), &invoice);
        Self::bump_invoice(&env, next);

        // Append to the merchant's index: position = count + 1.
        let count_key = DataKey::MerchantInvoiceCount(merchant.clone());
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let position = count + 1;
        env.storage().persistent().set(&DataKey::MerchantInvoiceIndex(merchant.clone(), position), &next);
        Self::bump_index(&env, &merchant, position);
        env.storage().persistent().set(&count_key, &position);
        Self::bump_count(&env, &merchant);

        env.storage().instance().set(&DataKey::NextInvoice, &(next + 1));
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("issued"),), IssuedEvent { id: invoice.id, merchant, customer, amount });
        Ok(invoice.id)
    }

    pub fn pay(env: Env, payer: Address, invoice_id: u64) -> Result<(), InvoiceError> {
        let mut invoice = Self::load(&env, invoice_id)?;
        if invoice.paid { return Err(InvoiceError::AlreadyPaid); }
        if invoice.cancelled { return Err(InvoiceError::AlreadyCancelled); }
        if invoice.due > 0 && env.ledger().timestamp() > invoice.due { return Err(InvoiceError::Expired); }
        if payer != invoice.customer { return Err(InvoiceError::PayerMismatch); }
        payer.require_auth();
        let to = invoice.merchant.clone();
        token::Client::new(&env, &invoice.token).transfer(&payer, &to, &invoice.amount);
        invoice.paid = true;
        Self::store(&env, invoice_id, &invoice);
        env.events().publish((symbol_short!("paid"),), PaidEvent { id: invoice_id, payer, merchant: to, amount: invoice.amount });
        Ok(())
    }

    pub fn cancel(env: Env, merchant: Address, invoice_id: u64) -> Result<(), InvoiceError> {
        let mut invoice = Self::load(&env, invoice_id)?;
        if invoice.merchant != merchant { return Err(InvoiceError::Unauthorized); }
        merchant.require_auth();
        if invoice.paid { return Err(InvoiceError::AlreadyPaid); }
        if invoice.cancelled { return Err(InvoiceError::AlreadyCancelled); }
        invoice.cancelled = true;
        Self::store(&env, invoice_id, &invoice);
        env.events().publish((symbol_short!("cancel"),), CancelledEvent { id: invoice_id, merchant });
        Ok(())
    }

    /// Read one invoice, restoring/extending its TTL.
    pub fn get_invoice(env: Env, id: u64) -> Option<Invoice> {
        let invoice = env.storage().persistent().get(&DataKey::Invoice(id));
        if invoice.is_some() { Self::bump_invoice(&env, id); }
        invoice
    }

    /// Total number of invoices issued (the highest id assigned).
    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextInvoice).unwrap_or(1) - 1
    }

    /// Paginated listing of every live invoice id at or after `start`.
    pub fn list_ids(env: Env, start: u64, limit: u32) -> Vec<u64> {
        let next: u64 = env.storage().instance().get(&DataKey::NextInvoice).unwrap_or(1);
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let mut ids = Vec::new(&env);
        let mut id = if start < 1 { 1 } else { start };
        while id < next && ids.len() < page {
            if env.storage().persistent().has(&DataKey::Invoice(id)) { ids.push_back(id); }
            id += 1;
        }
        ids
    }

    /// Paginated listing of one merchant's invoices, replacing the previous
    /// unbounded `invoices_of(merchant)`.
    ///
    /// `start` is a 1-based position in the merchant's own history (not an
    /// invoice id). Read `invoices_of_count` for the upper bound; a page past
    /// the end returns empty.
    pub fn invoices_of(env: Env, merchant: Address, start: u64, limit: u32) -> Vec<u64> {
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let count: u64 = env.storage().persistent().get(&DataKey::MerchantInvoiceCount(merchant.clone())).unwrap_or(0);
        let mut ids = Vec::new(&env);
        let mut position = if start < 1 { 1 } else { start };
        while position <= count && ids.len() < page {
            if let Some(id) = env.storage().persistent().get::<_, u64>(&DataKey::MerchantInvoiceIndex(merchant.clone(), position)) {
                ids.push_back(id);
            }
            position += 1;
        }
        ids
    }

    /// How many invoices a merchant has issued (the pagination envelope for
    /// `invoices_of`).
    pub fn invoices_of_count(env: Env, merchant: Address) -> u64 {
        env.storage().persistent().get(&DataKey::MerchantInvoiceCount(merchant)).unwrap_or(0)
    }

    // ─── Permissionless TTL maintenance ──────────────────────────────────────

    /// Extend the contract's instance entry (id counter). Anyone may call this.
    pub fn bump_instance_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend one invoice's TTL, restoring it if it was archived.
    pub fn bump_invoice_ttl(env: Env, id: u64) -> Result<(), InvoiceError> {
        if !env.storage().persistent().has(&DataKey::Invoice(id)) {
            return Err(InvoiceError::InvoiceNotFound);
        }
        Self::bump_invoice(&env, id);
        Ok(())
    }

    /// Extend one merchant's index entries (including its count) so an idle
    /// merchant's history is not archived. Pages through the index in bounded
    /// chunks; call repeatedly with increasing `start` for a large history.
    pub fn bump_merchant_index_ttl(env: Env, merchant: Address, start: u64, limit: u32) -> u64 {
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let count: u64 = env.storage().persistent().get(&DataKey::MerchantInvoiceCount(merchant.clone())).unwrap_or(0);
        let mut position = if start < 1 { 1 } else { start };
        let mut bumped: u64 = 0;
        while position <= count && bumped < page as u64 {
            Self::bump_index(&env, &merchant, position);
            position += 1;
            bumped += 1;
        }
        if count > 0 { Self::bump_count(&env, &merchant); }
        bumped
    }

    // ─── internal ────────────────────────────────────────────────────────────

    fn load(env: &Env, id: u64) -> Result<Invoice, InvoiceError> {
        let invoice = env.storage().persistent().get(&DataKey::Invoice(id)).ok_or(InvoiceError::InvoiceNotFound)?;
        Self::bump_invoice(env, id);
        Ok(invoice)
    }

    fn store(env: &Env, id: u64, invoice: &Invoice) {
        env.storage().persistent().set(&DataKey::Invoice(id), invoice);
        Self::bump_invoice(env, id);
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn bump_invoice(env: &Env, id: u64) {
        env.storage().persistent().extend_ttl(&DataKey::Invoice(id), INVOICE_TTL_THRESHOLD, INVOICE_TTL_EXTEND_TO);
    }

    fn bump_index(env: &Env, merchant: &Address, position: u64) {
        env.storage().persistent().extend_ttl(&DataKey::MerchantInvoiceIndex(merchant.clone(), position), INDEX_TTL_THRESHOLD, INDEX_TTL_EXTEND_TO);
    }

    fn bump_count(env: &Env, merchant: &Address) {
        env.storage().persistent().extend_ttl(&DataKey::MerchantInvoiceCount(merchant.clone()), INDEX_TTL_THRESHOLD, INDEX_TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
