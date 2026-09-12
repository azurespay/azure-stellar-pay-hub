#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Map};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SubscriptionError {
    Unauthorized = 1, InvalidAmount = 2, PlanNotFound = 3, SubscriptionNotFound = 4,
    NotDue = 5, AlreadyCancelled = 6, AlreadySubscribed = 7, TransferFailed = 8,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey { NextPlan, NextSubscription, Plans, Subscriptions }

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
        let mut next: u64 = env.storage().instance().get(&DataKey::NextPlan).unwrap_or(1);
        let mut plans: Map<u64, Plan> = env.storage().instance().get(&DataKey::Plans).unwrap_or_else(|| Map::new(&env));
        let plan = Plan { id: next, merchant: merchant.clone(), token, amount, interval_seconds, active: true };
        plans.set(next, plan.clone()); next += 1;
        env.storage().instance().set(&DataKey::NextPlan, &next);
        env.storage().instance().set(&DataKey::Plans, &plans);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("plan"),), PlanCreatedEvent { id: plan.id, merchant, amount });
        Ok(plan.id)
    }

    pub fn subscribe(env: Env, subscriber: Address, plan_id: u64) -> Result<u64, SubscriptionError> {
        subscriber.require_auth();
        let plans: Map<u64, Plan> = env.storage().instance().get(&DataKey::Plans).unwrap_or_else(|| Map::new(&env));
        let plan = plans.get(plan_id).ok_or(SubscriptionError::PlanNotFound)?;
        if !plan.active { return Err(SubscriptionError::PlanNotFound); }
        let subscriptions: Map<u64, Subscription> = env.storage().instance().get(&DataKey::Subscriptions).unwrap_or_else(|| Map::new(&env));
        for sub in subscriptions.values() {
            if sub.subscriber == subscriber && sub.plan_id == plan_id && sub.active { return Err(SubscriptionError::AlreadySubscribed); }
        }
        let now = env.ledger().timestamp();
        token::Client::new(&env, &plan.token).transfer(&subscriber, &plan.merchant, &plan.amount);
        let mut next: u64 = env.storage().instance().get(&DataKey::NextSubscription).unwrap_or(1);
        let mut subs: Map<u64, Subscription> = subscriptions.clone();
        let sub = Subscription { id: next, subscriber: subscriber.clone(), plan_id, next_payment_at: now + plan.interval_seconds, active: true };
        subs.set(next, sub.clone()); next += 1;
        env.storage().instance().set(&DataKey::NextSubscription, &next);
        env.storage().instance().set(&DataKey::Subscriptions, &subs);
        env.events().publish((symbol_short!("sub"),), SubscribedEvent { id: sub.id, subscriber, plan_id });
        Ok(sub.id)
    }

    pub fn renew(env: Env, caller: Address, subscription_id: u64) -> Result<(), SubscriptionError> {
        let mut subs: Map<u64, Subscription> = env.storage().instance().get(&DataKey::Subscriptions).unwrap_or_else(|| Map::new(&env));
        let mut sub = subs.get(subscription_id).ok_or(SubscriptionError::SubscriptionNotFound)?;
        if !sub.active { return Err(SubscriptionError::AlreadyCancelled); }
        // Only the subscriber (or the plan merchant) can trigger a renewal.
        let plans: Map<u64, Plan> = env.storage().instance().get(&DataKey::Plans).unwrap_or_else(|| Map::new(&env));
        let plan = plans.get(sub.plan_id).ok_or(SubscriptionError::PlanNotFound)?;
        if caller != sub.subscriber && caller != plan.merchant { return Err(SubscriptionError::Unauthorized); }
        caller.require_auth();
        let now = env.ledger().timestamp();
        if now < sub.next_payment_at { return Err(SubscriptionError::NotDue); }
        // The subscriber must also authorize the token transfer.
        sub.subscriber.require_auth();
        match token::Client::new(&env, &plan.token).try_transfer(&sub.subscriber, &plan.merchant, &plan.amount) {
            Ok(_) => {
                sub.next_payment_at = now + plan.interval_seconds;
                subs.set(subscription_id, sub.clone());
                env.storage().instance().set(&DataKey::Subscriptions, &subs);
                env.storage().instance().extend_ttl(5000, 5000);
                env.events().publish((symbol_short!("renew"),), RenewedEvent { id: subscription_id, plan_id: sub.plan_id, amount: plan.amount, merchant: plan.merchant });
                Ok(())
            }
            Err(_) => { sub.active = false; subs.set(subscription_id, sub.clone()); env.storage().instance().set(&DataKey::Subscriptions, &subs); Err(SubscriptionError::TransferFailed) }
        }
    }

    pub fn cancel(env: Env, caller: Address, subscription_id: u64) -> Result<(), SubscriptionError> {
        let mut subs: Map<u64, Subscription> = env.storage().instance().get(&DataKey::Subscriptions).unwrap_or_else(|| Map::new(&env));
        let mut sub = subs.get(subscription_id).ok_or(SubscriptionError::SubscriptionNotFound)?;
        let plans: Map<u64, Plan> = env.storage().instance().get(&DataKey::Plans).unwrap_or_else(|| Map::new(&env));
        let plan = plans.get(sub.plan_id).ok_or(SubscriptionError::PlanNotFound)?;
        if caller != sub.subscriber && caller != plan.merchant { return Err(SubscriptionError::Unauthorized); }
        caller.require_auth();
        if !sub.active { return Err(SubscriptionError::AlreadyCancelled); }
        sub.active = false; subs.set(subscription_id, sub.clone());
        env.storage().instance().set(&DataKey::Subscriptions, &subs);
        env.events().publish((symbol_short!("cancel"),), CancelledEvent { id: subscription_id, by: caller });
        Ok(())
    }

    pub fn get_plan(env: Env, id: u64) -> Option<Plan> {
        env.storage().instance().get::<_, Map<u64, Plan>>(&DataKey::Plans).and_then(|p| p.get(id))
    }
    pub fn get_subscription(env: Env, id: u64) -> Option<Subscription> {
        env.storage().instance().get::<_, Map<u64, Subscription>>(&DataKey::Subscriptions).and_then(|s| s.get(id))
    }
}

#[cfg(test)]
mod test;
