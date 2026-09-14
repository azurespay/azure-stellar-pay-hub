#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    Unauthorized = 1, InvalidAmount = 2, EscrowNotFound = 3, TooEarly = 4,
    Expired = 5, NotExpired = 6, AlreadyReleased = 7, AlreadyRefunded = 8, NotInitialized = 9,
    AlreadyInitialized = 10,
}

// ─── TTL budget ──────────────────────────────────────────────────────────────
// Ledgers close roughly every 5 seconds, so 17_280 ledgers ≈ 1 day and
// 518_400 ledgers ≈ 30 days. Extending to 30 days keeps the budget well inside
// the network's maximum entry TTL on every network (mainnet, testnet, futurenet)
// while still being long enough that an actively-used contract is never at risk.
//
// The instance entry holds the admin and the id counter; escrow records are
// persistent entries of their own. Both are bumped on every access, and the
// permissionless `bump_instance_ttl` / `bump_escrow_ttl` entry points exist so
// anyone can pay to keep an idle contract (or a single escrow) alive.
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;
const ESCROW_TTL_THRESHOLD: u32 = 17_280;
const ESCROW_TTL_EXTEND_TO: u32 = 518_400;

/// Largest page a listing entry point will return in one call. Bounds the
/// footprint (and therefore the resource cost) of a single read.
const MAX_PAGE_SIZE: u32 = 100;

/// Refund window applied when an escrow is created with `expiry: None`.
///
/// Previously "no expiry" was stored as `u64::MAX`, so `refund` — which needs
/// `now > expiry` — could never succeed once `release_time` had passed: if the
/// counterparty never released, the initiator's funds were locked forever.
/// A bounded default gives the counterparty a full 30 days after `release_time`
/// to release, after which the initiator can always reclaim.
const DEFAULT_REFUND_WINDOW: u64 = 30 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Admin,
    NextId,
    /// One persistent entry per escrow, instead of a single instance `Map`.
    Escrow(u64),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Escrow {
    pub id: u64, pub initiator: Address, pub counterparty: Address,
    pub arbiter: Option<Address>,
    pub token: Address, pub amount: i128, pub release_time: u64,
    pub expiry: u64, pub released: bool, pub refunded: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowCreated { pub id: u64, pub initiator: Address, pub counterparty: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowReleased { pub id: u64, pub to: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowRefunded { pub id: u64, pub to: Address, pub amount: i128 }

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) { return Err(EscrowError::AlreadyInitialized); }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn create(env: Env, initiator: Address, counterparty: Address, arbiter: Option<Address>, token: Address, amount: i128, release_time: u64, expiry: Option<u64>) -> Result<u64, EscrowError> {
        if amount <= 0 { return Err(EscrowError::InvalidAmount); }
        if expiry.map_or(false, |e| e <= release_time) { return Err(EscrowError::InvalidAmount); }
        initiator.require_auth();
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        token::Client::new(&env, &token).transfer(&initiator, &env.current_contract_address(), &amount);
        // An escrow with no explicit expiry still gets a bounded refund window,
        // so the initiator always has a way to reclaim the funds.
        let refund_deadline = expiry.unwrap_or_else(|| release_time.saturating_add(DEFAULT_REFUND_WINDOW));
        let escrow = Escrow { id: next_id, initiator: initiator.clone(), counterparty: counterparty.clone(), arbiter: arbiter.clone(), token: token.clone(), amount, release_time, expiry: refund_deadline, released: false, refunded: false };
        env.storage().persistent().set(&DataKey::Escrow(next_id), &escrow);
        Self::bump_escrow(&env, next_id);
        env.storage().instance().set(&DataKey::NextId, &(next_id + 1));
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("created"),), EscrowCreated { id: escrow.id, initiator, counterparty, amount });
        Ok(escrow.id)
    }

    pub fn release(env: Env, id: u64, caller: Address) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, id)?;
        if escrow.released { return Err(EscrowError::AlreadyReleased); }
        if escrow.refunded { return Err(EscrowError::AlreadyRefunded); }
        // The initiator, counterparty, or an appointed arbiter may release.
        let is_arbiter = escrow.arbiter.as_ref().map_or(false, |a| a == &caller);
        if caller != escrow.counterparty && caller != escrow.initiator && !is_arbiter {
            return Err(EscrowError::Unauthorized);
        }
        caller.require_auth();
        if env.ledger().timestamp() < escrow.release_time { return Err(EscrowError::TooEarly); }
        let to = escrow.counterparty.clone();
        token::Client::new(&env, &escrow.token).transfer(&env.current_contract_address(), &to, &escrow.amount);
        escrow.released = true;
        Self::store(&env, id, &escrow);
        env.events().publish((symbol_short!("released"),), EscrowReleased { id, to: to.clone(), amount: escrow.amount });
        Ok(())
    }

    pub fn refund(env: Env, id: u64, caller: Address) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, id)?;
        if escrow.released { return Err(EscrowError::AlreadyReleased); }
        if escrow.refunded { return Err(EscrowError::AlreadyRefunded); }
        // Either the initiator or the counterparty may initiate a refund after expiry.
        if caller != escrow.initiator && caller != escrow.counterparty { return Err(EscrowError::Unauthorized); }
        caller.require_auth();
        let now = env.ledger().timestamp();
        if now >= escrow.release_time && now <= escrow.expiry { return Err(EscrowError::NotExpired); }
        let to = escrow.initiator.clone();
        token::Client::new(&env, &escrow.token).transfer(&env.current_contract_address(), &to, &escrow.amount);
        escrow.refunded = true;
        Self::store(&env, id, &escrow);
        env.events().publish((symbol_short!("refund"),), EscrowRefunded { id, to: to.clone(), amount: escrow.amount });
        Ok(())
    }

    /// Read one escrow. Also restores and extends its TTL: if the entry was
    /// archived, including it in the call's footprint lets the host restore it,
    /// and the budget below then keeps it live.
    pub fn get(env: Env, id: u64) -> Option<Escrow> {
        let stored = env.storage().persistent().get(&DataKey::Escrow(id));
        if stored.is_some() { Self::bump_escrow(&env, id); }
        stored
    }

    /// Highest id assigned so far (0 when no escrow exists yet). Combined with
    /// `list_ids` this is the pagination envelope: ids are assigned from 1 and
    /// never reused, so a caller walks `(0, count]` in pages.
    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextId).unwrap_or(1) - 1
    }

    /// Paginated replacement for the previous unbounded `all_ids()`.
    ///
    /// Returns up to `limit` (capped at [`MAX_PAGE_SIZE`]) live escrow ids at or
    /// after `start`. Because ids are dense and monotonic this needs no index
    /// entry — cost is proportional to the page, not to the number of escrows.
    pub fn list_ids(env: Env, start: u64, limit: u32) -> Vec<u64> {
        let next: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let mut ids = Vec::new(&env);
        let mut id = if start < 1 { 1 } else { start };
        while id < next && ids.len() < page {
            if env.storage().persistent().has(&DataKey::Escrow(id)) { ids.push_back(id); }
            id += 1;
        }
        ids
    }

    /// Paginated listing that returns the records themselves.
    pub fn list(env: Env, start: u64, limit: u32) -> Vec<Escrow> {
        let ids = Self::list_ids(env.clone(), start, limit);
        let mut out = Vec::new(&env);
        for id in ids.iter() {
            if let Some(escrow) = Self::get(env.clone(), id) { out.push_back(escrow); }
        }
        out
    }

    // ─── Permissionless TTL maintenance ──────────────────────────────────────

    /// Extend the contract's instance entry (admin + id counter). Anyone may
    /// call this and pay the rent, so an idle contract is never silently
    /// archived.
    pub fn bump_instance_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend one escrow's TTL, restoring it first if it was archived. Fails with
    /// `EscrowNotFound` when the id was never used.
    pub fn bump_escrow_ttl(env: Env, id: u64) -> Result<(), EscrowError> {
        if !env.storage().persistent().has(&DataKey::Escrow(id)) {
            return Err(EscrowError::EscrowNotFound);
        }
        Self::bump_escrow(&env, id);
        Ok(())
    }

    // ─── internal ────────────────────────────────────────────────────────────

    fn load(env: &Env, id: u64) -> Result<Escrow, EscrowError> {
        let escrow = env.storage().persistent().get(&DataKey::Escrow(id)).ok_or(EscrowError::EscrowNotFound)?;
        Self::bump_escrow(env, id);
        Ok(escrow)
    }

    fn store(env: &Env, id: u64, escrow: &Escrow) {
        env.storage().persistent().set(&DataKey::Escrow(id), escrow);
        Self::bump_escrow(env, id);
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn bump_escrow(env: &Env, id: u64) {
        env.storage().persistent().extend_ttl(&DataKey::Escrow(id), ESCROW_TTL_THRESHOLD, ESCROW_TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
