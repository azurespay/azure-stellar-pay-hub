#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MerchantError {
    Unauthorized = 1, InvalidAmount = 2, MerchantNotFound = 3, InactiveMerchant = 4,
    NotInitialized = 5, InvalidCommission = 6, NoBalance = 7,
    AlreadyInitialized = 8,
}

// ─── TTL budget ──────────────────────────────────────────────────────────────
// Ledgers close roughly every 5 seconds, so 17_280 ledgers ≈ 1 day and
// 518_400 ledgers ≈ 30 days. Profiles and their held balances were previously
// members of two instance-storage Maps, so any merchant's activity rewrote
// every merchant. They are now per-key persistent entries, bumped on access and
// by the permissionless bump helpers below.
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;
const MERCHANT_TTL_THRESHOLD: u32 = 17_280;
const MERCHANT_TTL_EXTEND_TO: u32 = 518_400;
/// Held balances are funds the contract owes a merchant: they get the same
/// budget as the profile so an idle merchant cannot have its ledger entry
/// archived while the contract still holds the tokens.
const BALANCE_TTL_THRESHOLD: u32 = 17_280;
const BALANCE_TTL_EXTEND_TO: u32 = 518_400;

/// Largest page a listing entry point will return in one call.
const MAX_PAGE_SIZE: u32 = 100;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Admin,
    NextMerchant,
    /// One persistent entry per merchant profile.
    Merchant(u64),
    /// One persistent entry per (merchant, token) held balance, instead of a
    /// `Map<u64, Map<Address, i128>>` in instance storage.
    Balance(u64, Address),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct MerchantProfile { pub id: u64, pub owner: Address, pub name: String, pub settlement: Address, pub commission_bps: u32, pub active: bool }

#[contracttype]
#[derive(Clone, Debug)]
pub struct RegisteredEvent { pub id: u64, pub owner: Address, pub name: String }
#[contracttype]
#[derive(Clone, Debug)]
pub struct SaleRecordedEvent { pub id: u64, pub token: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct SettledEvent { pub id: u64, pub token: Address, pub amount: i128, pub commission: i128, pub to: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct ProfileUpdatedEvent { pub id: u64 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct ActivatedEvent { pub id: u64, pub active: bool }

#[contract]
pub struct MerchantContract;

#[contractimpl]
impl MerchantContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), MerchantError> {
        if env.storage().instance().has(&DataKey::Admin) { return Err(MerchantError::AlreadyInitialized); }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextMerchant, &1u64);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn register(env: Env, owner: Address, name: String, settlement: Address, commission_bps: u32) -> Result<u64, MerchantError> {
        if commission_bps > 10_000 { return Err(MerchantError::InvalidCommission); }
        owner.require_auth();
        let next: u64 = env.storage().instance().get(&DataKey::NextMerchant).unwrap_or(1);
        let profile = MerchantProfile { id: next, owner: owner.clone(), name: name.clone(), settlement, commission_bps, active: true };
        env.storage().persistent().set(&DataKey::Merchant(next), &profile);
        Self::bump_merchant(&env, next);
        env.storage().instance().set(&DataKey::NextMerchant, &(next + 1));
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("reg"),), RegisteredEvent { id: profile.id, owner, name });
        Ok(profile.id)
    }

    pub fn update_profile(env: Env, owner: Address, id: u64, name: String, settlement: Address) -> Result<(), MerchantError> {
        let mut profile = Self::load(&env, id)?;
        if profile.owner != owner { return Err(MerchantError::Unauthorized); }
        owner.require_auth(); profile.name = name; profile.settlement = settlement;
        Self::store(&env, id, &profile);
        env.events().publish((symbol_short!("upd"),), ProfileUpdatedEvent { id });
        Ok(())
    }

    pub fn set_commission(env: Env, admin: Address, id: u64, commission_bps: u32) -> Result<(), MerchantError> {
        if commission_bps > 10_000 { return Err(MerchantError::InvalidCommission); }
        Self::require_admin(&env, &admin)?;
        let mut profile = Self::load(&env, id)?;
        profile.commission_bps = commission_bps;
        Self::store(&env, id, &profile);
        Ok(())
    }

    pub fn set_active(env: Env, admin: Address, id: u64, active: bool) -> Result<(), MerchantError> {
        Self::require_admin(&env, &admin)?;
        let mut profile = Self::load(&env, id)?;
        profile.active = active;
        Self::store(&env, id, &profile);
        env.events().publish((symbol_short!("active"),), ActivatedEvent { id, active });
        Ok(())
    }

    /// Record a sale where the caller (payer) sends tokens to the contract.
    /// Tokens are transferred from the payer to the contract, then credited to the
    /// merchant's internal balance. The payer must authorize the token transfer.
    pub fn record_sale(env: Env, payer: Address, id: u64, token: Address, amount: i128) -> Result<(), MerchantError> {
        if amount <= 0 { return Err(MerchantError::InvalidAmount); }
        payer.require_auth();
        let profile = Self::load(&env, id)?;
        if !profile.active { return Err(MerchantError::InactiveMerchant); }
        // Transfer tokens from the payer into the contract.
        token::Client::new(&env, &token).transfer(&payer, &env.current_contract_address(), &amount);
        // Credit the merchant's internal balance (its own ledger entry).
        let key = DataKey::Balance(id, token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
        Self::bump_balance(&env, id, &token);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("sale"),), SaleRecordedEvent { id, token, amount });
        Ok(())
    }

    pub fn settle(env: Env, owner: Address, id: u64, token: Address) -> Result<(), MerchantError> {
        let profile = Self::load(&env, id)?;
        if profile.owner != owner { return Err(MerchantError::Unauthorized); }
        owner.require_auth();
        let key = DataKey::Balance(id, token.clone());
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount <= 0 { return Err(MerchantError::NoBalance); }
        let commission = (amount * profile.commission_bps as i128) / 10_000;
        let net = amount - commission;
        // Clearing the balance removes the row rather than storing a zero.
        env.storage().persistent().remove(&key);
        Self::bump_instance(&env);
        let to = profile.settlement.clone();
        // Safety: verify the contract actually holds enough tokens (defense-in-depth).
        let contract_balance = token::Client::new(&env, &token).balance(&env.current_contract_address());
        if contract_balance < net + commission { return Err(MerchantError::NoBalance); }
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &to, &net);
        if commission > 0 {
            let admin: Address = env.storage().instance().get(&DataKey::Admin).ok_or(MerchantError::NotInitialized)?;
            token::Client::new(&env, &token).transfer(&env.current_contract_address(), &admin, &commission);
        }
        env.events().publish((symbol_short!("settle"),), SettledEvent { id, token, amount: net, commission, to });
        Ok(())
    }

    /// Read one merchant profile, restoring/extending its TTL.
    pub fn get(env: Env, id: u64) -> Option<MerchantProfile> {
        let profile = env.storage().persistent().get(&DataKey::Merchant(id));
        if profile.is_some() { Self::bump_merchant(&env, id); }
        profile
    }

    /// Read the contract-held balance for one (merchant, token) pair.
    pub fn held_balance(env: Env, id: u64, token: Address) -> i128 {
        let key = DataKey::Balance(id, token.clone());
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount != 0 { Self::bump_balance(&env, id, &token); }
        amount
    }

    /// Highest merchant id assigned so far (0 when none exist yet).
    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextMerchant).unwrap_or(1) - 1
    }

    /// Paginated listing of live merchant ids at or after `start`. Ids are dense
    /// and monotonic, so this costs O(page), not O(merchants).
    pub fn list_ids(env: Env, start: u64, limit: u32) -> Vec<u64> {
        let next: u64 = env.storage().instance().get(&DataKey::NextMerchant).unwrap_or(1);
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let mut ids = Vec::new(&env);
        let mut id = if start < 1 { 1 } else { start };
        while id < next && ids.len() < page {
            if env.storage().persistent().has(&DataKey::Merchant(id)) { ids.push_back(id); }
            id += 1;
        }
        ids
    }

    /// Paginated listing of merchant profiles.
    pub fn list(env: Env, start: u64, limit: u32) -> Vec<MerchantProfile> {
        let ids = Self::list_ids(env.clone(), start, limit);
        let mut out = Vec::new(&env);
        for id in ids.iter() {
            if let Some(profile) = Self::get(env.clone(), id) { out.push_back(profile); }
        }
        out
    }

    // ─── Permissionless TTL maintenance ──────────────────────────────────────

    /// Extend the contract's instance entry (admin + id counter). Anyone may
    /// call this and pay the rent.
    pub fn bump_instance_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend one merchant profile's TTL, restoring it if it was archived.
    pub fn bump_merchant_ttl(env: Env, id: u64) -> Result<(), MerchantError> {
        if !env.storage().persistent().has(&DataKey::Merchant(id)) {
            return Err(MerchantError::MerchantNotFound);
        }
        Self::bump_merchant(&env, id);
        Ok(())
    }

    /// Extend one held-balance entry's TTL, restoring it if it was archived.
    /// Fails with `NoBalance` when there is nothing held for that token.
    pub fn bump_balance_ttl(env: Env, id: u64, token: Address) -> Result<(), MerchantError> {
        let key = DataKey::Balance(id, token.clone());
        if env.storage().persistent().get::<_, i128>(&key).unwrap_or(0) <= 0 {
            return Err(MerchantError::NoBalance);
        }
        Self::bump_balance(&env, id, &token);
        Ok(())
    }

    // ─── internal ────────────────────────────────────────────────────────────

    fn load(env: &Env, id: u64) -> Result<MerchantProfile, MerchantError> {
        let profile = env.storage().persistent().get(&DataKey::Merchant(id)).ok_or(MerchantError::MerchantNotFound)?;
        Self::bump_merchant(env, id);
        Ok(profile)
    }

    fn store(env: &Env, id: u64, profile: &MerchantProfile) {
        env.storage().persistent().set(&DataKey::Merchant(id), profile);
        Self::bump_merchant(env, id);
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), MerchantError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin).ok_or(MerchantError::NotInitialized)?;
        stored.require_auth();
        if admin != &stored { return Err(MerchantError::Unauthorized); }
        Ok(())
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn bump_merchant(env: &Env, id: u64) {
        env.storage().persistent().extend_ttl(&DataKey::Merchant(id), MERCHANT_TTL_THRESHOLD, MERCHANT_TTL_EXTEND_TO);
    }

    fn bump_balance(env: &Env, id: u64, token: &Address) {
        env.storage().persistent().extend_ttl(&DataKey::Balance(id, token.clone()), BALANCE_TTL_THRESHOLD, BALANCE_TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
