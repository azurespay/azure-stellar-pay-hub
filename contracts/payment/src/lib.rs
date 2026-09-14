#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PaymentError {
    Unauthorized = 1,
    InvalidAmount = 2,
    Paused = 3,
    TokenNotAllowed = 4,
    NotInitialized = 5,
    EmptyRecipients = 6,
    AlreadyInitialized = 7,
}

// ─── TTL budget ──────────────────────────────────────────────────────────────
// Ledgers close roughly every 5 seconds, so 17_280 ledgers ≈ 1 day and
// 518_400 ledgers ≈ 30 days. The instance entry holds the admin and the pause
// flag; each allowlist entry is its own persistent row (previously they all
// shared the instance entry — `Allowed(token)` was already per key, but stored
// in instance storage). Both are bumped on access and by the permissionless
// `bump_instance_ttl` / `bump_token_ttl` helpers.
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;
const ALLOWED_TTL_THRESHOLD: u32 = 17_280;
const ALLOWED_TTL_EXTEND_TO: u32 = 518_400;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Admin,
    Paused,
    Allowed(Address),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PaymentEventData {
    pub from: Address,
    pub to: Address,
    pub token: Address,
    pub amount: i128,
    pub memo: String,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct BatchPaymentData {
    pub from: Address,
    pub token: Address,
    pub recipients: u32,
    pub total: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PausedData {
    pub by: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct UnpausedData {
    pub by: Address,
}

#[contract]
pub struct PaymentContract;

#[contractimpl]
impl PaymentContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), PaymentError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(PaymentError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn set_allowed(env: Env, admin: Address, token: Address, allowed: bool) -> Result<(), PaymentError> {
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&DataKey::Allowed(token.clone()), &allowed);
        Self::bump_allowed(&env, &token);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Read whether a token is allowlisted. Extends the entry's TTL so an
    /// actively-used allowlist entry can never be archived out from under a
    /// payment; if it had been archived, including it in the footprint lets the
    /// host restore it.
    pub fn is_allowed(env: Env, token: Address) -> bool {
        let allowed = env.storage().persistent().get(&DataKey::Allowed(token.clone())).unwrap_or(false);
        if env.storage().persistent().has(&DataKey::Allowed(token.clone())) {
            Self::bump_allowed(&env, &token);
        }
        allowed
    }

    pub fn pause(env: Env, admin: Address) -> Result<(), PaymentError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("paused"),), PausedData { by: admin });
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), PaymentError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("unpaused"),), UnpausedData { by: admin });
        Ok(())
    }

    pub fn send(
        env: Env,
        from: Address,
        to: Address,
        token: Address,
        amount: i128,
        memo: Option<String>,
    ) -> Result<(), PaymentError> {
        Self::check_send(&env, &from, &token, amount)?;
        from.require_auth();
        token::Client::new(&env, &token).transfer(&from, &to, &amount);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("payment"),), PaymentEventData {
            from,
            to,
            token,
            amount,
            memo: memo.unwrap_or(String::from_str(&env, "")),
        });
        Ok(())
    }

    pub fn send_batch(
        env: Env,
        from: Address,
        token: Address,
        recipients: Vec<(Address, i128)>,
    ) -> Result<(), PaymentError> {
        Self::check_send(&env, &from, &token, 1)?;
        if recipients.is_empty() {
            return Err(PaymentError::EmptyRecipients);
        }
        from.require_auth();
        let mut total: i128 = 0;
        for (to, amount) in recipients.iter() {
            if amount <= 0 {
                return Err(PaymentError::InvalidAmount);
            }
            total += amount;
            token::Client::new(&env, &token).transfer(&from, &to, &amount);
        }
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("batch"),), BatchPaymentData {
            from,
            token,
            recipients: recipients.len() as u32,
            total,
        });
        Ok(())
    }

    pub fn balance(env: Env, account: Address, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&account)
    }

    // ─── Permissionless TTL maintenance ──────────────────────────────────────

    /// Extend the contract's instance entry (admin + pause flag). Anyone may
    /// call this and pay the rent, so an idle contract is never silently
    /// archived.
    pub fn bump_instance_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend one allowlist entry's TTL, restoring it if it was archived. Fails
    /// with `TokenNotAllowed` when the token was never configured.
    pub fn bump_token_ttl(env: Env, token: Address) -> Result<(), PaymentError> {
        if !env.storage().persistent().has(&DataKey::Allowed(token.clone())) {
            return Err(PaymentError::TokenNotAllowed);
        }
        Self::bump_allowed(&env, &token);
        Ok(())
    }

    // ─── internal ────────────────────────────────────────────────────────────

    fn require_admin(env: &Env, admin: &Address) -> Result<(), PaymentError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin).ok_or(PaymentError::NotInitialized)?;
        stored.require_auth();
        if admin != &stored { return Err(PaymentError::Unauthorized); }
        Ok(())
    }

    fn check_send(env: &Env, _from: &Address, token: &Address, amount: i128) -> Result<(), PaymentError> {
        if amount <= 0 { return Err(PaymentError::InvalidAmount); }
        if env.storage().instance().get::<_, bool>(&DataKey::Paused).unwrap_or(false) { return Err(PaymentError::Paused); }
        if !env.storage().persistent().get::<_, bool>(&DataKey::Allowed(token.clone())).unwrap_or(false) {
            return Err(PaymentError::TokenNotAllowed);
        }
        Ok(())
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn bump_allowed(env: &Env, token: &Address) {
        env.storage().persistent().extend_ttl(&DataKey::Allowed(token.clone()), ALLOWED_TTL_THRESHOLD, ALLOWED_TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
