#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SubscriptionError {
    Unauthorized = 1, InvalidAmount = 2, PlanNotFound = 3, SubscriptionNotFound = 4,
    NotDue = 5, AlreadyCancelled = 6, AlreadySubscribed = 7, TransferFailed = 8,
}

// ─── TTL budget ──────────────────────────────────────────────────────────────
// Ledgers close roughly every 5 seconds, so 17_280 ledgers ≈ 1 day and
// 518_400 ledgers ≈ 30 days. Plans and subscriptions are now per-key persistent
// entries (previously both lived in instance-storage Maps, so a renewal rewrote
// every subscription in the contract).
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;
const PLAN_TTL_THRESHOLD: u32 = 17_280;
const PLAN_TTL_EXTEND_TO: u32 = 518_400;
const SUB_TTL_THRESHOLD: u32 = 17_280;
const SUB_TTL_EXTEND_TO: u32 = 518_400;
const INDEX_TTL_THRESHOLD: u32 = 17_280;
const INDEX_TTL_EXTEND_TO: u32 = 518_400;

/// Largest page a listing entry point will return in one call.
const MAX_PAGE_SIZE: u32 = 100;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    NextPlan,
    NextSubscription,
    /// One persistent entry per plan.
    Plan(u64),
    /// One persistent entry per subscription.
    Subscription(u64),
    /// `(plan, subscriber)` → subscription id, present only while that
    /// subscription is active. Replaces the previous "iterate every
    /// subscription to see whether this subscriber already exists" scan, which
    /// grew linearly with the contract's total subscriptions.
    ActiveSub(u64, Address),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Plan { pub id: u64, pub merchant: Address, pub token: Address, pub amount: i128, pub interval_seconds: u64, pub active: bool }
#[contracttype]
#[derive(Clone, Debug)]
pub struct Subscription { pub id: u64, pub subscriber: Address, pub plan_id: u64, pub next_payment_at: u64, pub active: bool }

#[contracttype]
#[derive(Clone, Debug)]
pub struct PlanCreatedEvent { pub id: u64, pub merchant: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct SubscribedEvent { pub id: u64, pub subscriber: Address, pub plan_id: u64 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct RenewedEvent { pub id: u64, pub plan_id: u64, pub amount: i128, pub merchant: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct CancelledEvent { pub id: u64, pub by: Address }

#[contract]
pub struct SubscriptionsContract;

#[contractimpl]
impl SubscriptionsContract {
    pub fn create_plan(env: Env, merchant: Address, token: Address, amount: i128, interval_seconds: u64) -> Result<u64, SubscriptionError> {
        if amount <= 0 { return Err(SubscriptionError::InvalidAmount); }
        merchant.require_auth();
        let next: u64 = env.storage().instance().get(&DataKey::NextPlan).unwrap_or(1);
        let plan = Plan { id: next, merchant: merchant.clone(), token, amount, interval_seconds, active: true };
        env.storage().persistent().set(&DataKey::Plan(next), &plan);
        Self::bump_plan(&env, next);
        env.storage().instance().set(&DataKey::NextPlan, &(next + 1));
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("plan"),), PlanCreatedEvent { id: plan.id, merchant, amount });
        Ok(plan.id)
    }

    pub fn subscribe(env: Env, subscriber: Address, plan_id: u64) -> Result<u64, SubscriptionError> {
        subscriber.require_auth();
        let plan = Self::load_plan(&env, plan_id)?;
        if !plan.active { return Err(SubscriptionError::PlanNotFound); }
        // O(1) duplicate check via the index key, instead of scanning every
        // subscription in the contract.
        let active_key = DataKey::ActiveSub(plan_id, subscriber.clone());
        if env.storage().persistent().has(&active_key) { return Err(SubscriptionError::AlreadySubscribed); }
        let now = env.ledger().timestamp();
        token::Client::new(&env, &plan.token).transfer(&subscriber, &plan.merchant, &plan.amount);
        let next: u64 = env.storage().instance().get(&DataKey::NextSubscription).unwrap_or(1);
        let sub = Subscription { id: next, subscriber: subscriber.clone(), plan_id, next_payment_at: now + plan.interval_seconds, active: true };
        env.storage().persistent().set(&DataKey::Subscription(next), &sub);
        Self::bump_sub(&env, next);
        env.storage().persistent().set(&active_key, &next);
        Self::bump_index(&env, plan_id, &subscriber);
        env.storage().instance().set(&DataKey::NextSubscription, &(next + 1));
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("sub"),), SubscribedEvent { id: sub.id, subscriber, plan_id });
        Ok(sub.id)
    }

    pub fn renew(env: Env, caller: Address, subscription_id: u64) -> Result<(), SubscriptionError> {
        let mut sub = Self::load_sub(&env, subscription_id)?;
        if !sub.active { return Err(SubscriptionError::AlreadyCancelled); }
        // Only the subscriber (or the plan merchant) can trigger a renewal.
        let plan = Self::load_plan(&env, sub.plan_id)?;
        if caller != sub.subscriber && caller != plan.merchant { return Err(SubscriptionError::Unauthorized); }
        caller.require_auth();
        let now = env.ledger().timestamp();
        if now < sub.next_payment_at { return Err(SubscriptionError::NotDue); }
        // The subscriber must also authorize the token transfer.
        sub.subscriber.require_auth();
        match token::Client::new(&env, &plan.token).try_transfer(&sub.subscriber, &plan.merchant, &plan.amount) {
            Ok(_) => {
                sub.next_payment_at = now + plan.interval_seconds;
                Self::store_sub(&env, subscription_id, &sub);
                Self::bump_index(&env, sub.plan_id, &sub.subscriber);
                env.events().publish((symbol_short!("renew"),), RenewedEvent { id: subscription_id, plan_id: sub.plan_id, amount: plan.amount, merchant: plan.merchant });
                Ok(())
            }
            Err(_) => {
                sub.active = false;
                Self::store_sub(&env, subscription_id, &sub);
                // Keep the index in step with `active`, so the subscriber can
                // subscribe again after a failed payment.
                env.storage().persistent().remove(&DataKey::ActiveSub(sub.plan_id, sub.subscriber.clone()));
                Err(SubscriptionError::TransferFailed)
            }
        }
    }

    pub fn cancel(env: Env, caller: Address, subscription_id: u64) -> Result<(), SubscriptionError> {
        let mut sub = Self::load_sub(&env, subscription_id)?;
        let plan = Self::load_plan(&env, sub.plan_id)?;
        if caller != sub.subscriber && caller != plan.merchant { return Err(SubscriptionError::Unauthorized); }
        caller.require_auth();
        if !sub.active { return Err(SubscriptionError::AlreadyCancelled); }
        sub.active = false;
        Self::store_sub(&env, subscription_id, &sub);
        // Releasing the index frees the (plan, subscriber) slot to subscribe again.
        env.storage().persistent().remove(&DataKey::ActiveSub(sub.plan_id, sub.subscriber.clone()));
        env.events().publish((symbol_short!("cancel"),), CancelledEvent { id: subscription_id, by: caller });
        Ok(())
    }

    /// Read one plan, restoring/extending its TTL.
    pub fn get_plan(env: Env, id: u64) -> Option<Plan> {
        let plan = env.storage().persistent().get(&DataKey::Plan(id));
        if plan.is_some() { Self::bump_plan(&env, id); }
        plan
    }

    /// Read one subscription, restoring/extending its TTL.
    pub fn get_subscription(env: Env, id: u64) -> Option<Subscription> {
        let sub = env.storage().persistent().get(&DataKey::Subscription(id));
        if sub.is_some() { Self::bump_sub(&env, id); }
        sub
    }

    /// True while `subscriber` has an active subscription to `plan`. The O(1)
    /// replacement for scanning every subscription.
    pub fn is_subscribed(env: Env, plan_id: u64, subscriber: Address) -> bool {
        env.storage().persistent().has(&DataKey::ActiveSub(plan_id, subscriber))
    }

    pub fn count_plans(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextPlan).unwrap_or(1) - 1
    }

    pub fn count_subscriptions(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextSubscription).unwrap_or(1) - 1
    }

    /// Paginated listing of live plan ids at or after `start`.
    pub fn list_plan_ids(env: Env, start: u64, limit: u32) -> Vec<u64> {
        let next: u64 = env.storage().instance().get(&DataKey::NextPlan).unwrap_or(1);
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let mut ids = Vec::new(&env);
        let mut id = if start < 1 { 1 } else { start };
        while id < next && ids.len() < page {
            if env.storage().persistent().has(&DataKey::Plan(id)) { ids.push_back(id); }
            id += 1;
        }
        ids
    }

    /// Paginated listing of live subscription ids at or after `start`.
    pub fn list_subscription_ids(env: Env, start: u64, limit: u32) -> Vec<u64> {
        let next: u64 = env.storage().instance().get(&DataKey::NextSubscription).unwrap_or(1);
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let mut ids = Vec::new(&env);
        let mut id = if start < 1 { 1 } else { start };
        while id < next && ids.len() < page {
            if env.storage().persistent().has(&DataKey::Subscription(id)) { ids.push_back(id); }
            id += 1;
        }
        ids
    }

    // ─── Permissionless TTL maintenance ──────────────────────────────────────

    /// Extend the contract's instance entry (id counters). Anyone may call this.
    pub fn bump_instance_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend one plan's TTL, restoring it if it was archived.
    pub fn bump_plan_ttl(env: Env, id: u64) -> Result<(), SubscriptionError> {
        if !env.storage().persistent().has(&DataKey::Plan(id)) { return Err(SubscriptionError::PlanNotFound); }
        Self::bump_plan(&env, id);
        Ok(())
    }

    /// Extend one subscription's TTL, restoring it if it was archived.
    pub fn bump_subscription_ttl(env: Env, id: u64) -> Result<(), SubscriptionError> {
        if !env.storage().persistent().has(&DataKey::Subscription(id)) { return Err(SubscriptionError::SubscriptionNotFound); }
        Self::bump_sub(&env, id);
        Ok(())
    }

    // ─── internal ────────────────────────────────────────────────────────────

    fn load_plan(env: &Env, id: u64) -> Result<Plan, SubscriptionError> {
        let plan = env.storage().persistent().get(&DataKey::Plan(id)).ok_or(SubscriptionError::PlanNotFound)?;
        Self::bump_plan(env, id);
        Ok(plan)
    }

    fn load_sub(env: &Env, id: u64) -> Result<Subscription, SubscriptionError> {
        let sub = env.storage().persistent().get(&DataKey::Subscription(id)).ok_or(SubscriptionError::SubscriptionNotFound)?;
        Self::bump_sub(env, id);
        Ok(sub)
    }

    fn store_sub(env: &Env, id: u64, sub: &Subscription) {
        env.storage().persistent().set(&DataKey::Subscription(id), sub);
        Self::bump_sub(env, id);
    }

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn bump_plan(env: &Env, id: u64) {
        env.storage().persistent().extend_ttl(&DataKey::Plan(id), PLAN_TTL_THRESHOLD, PLAN_TTL_EXTEND_TO);
    }

    fn bump_sub(env: &Env, id: u64) {
        env.storage().persistent().extend_ttl(&DataKey::Subscription(id), SUB_TTL_THRESHOLD, SUB_TTL_EXTEND_TO);
    }

    fn bump_index(env: &Env, plan_id: u64, subscriber: &Address) {
        env.storage().persistent().extend_ttl(&DataKey::ActiveSub(plan_id, subscriber.clone()), INDEX_TTL_THRESHOLD, INDEX_TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
