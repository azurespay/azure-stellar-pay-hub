#![cfg(test)]

use super::{SubscriptionsContract, SubscriptionsContractClient, SubscriptionError, DataKey};
use soroban_sdk::testutils::{Address as AddressUtils, Ledger};
use soroban_sdk::{token, Address, Env};

fn create_token<'e>(env: &'e Env, admin: &Address) -> (token::Client<'e>, Address) {
    let id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (token::Client::new(env, &id), id)
}

fn mint<'e>(env: &'e Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

type Setup<'e> = (Address, Address, token::Client<'e>, Address, SubscriptionsContractClient<'e>, u64);

fn setup<'e>(env: &'e Env) -> Setup<'e> {
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(env);
    let merchant = Address::generate(env);
    let subscriber = Address::generate(env);
    let (token, token_id) = create_token(env, &admin);
    let contract_id = env.register_contract(None, SubscriptionsContract);
    let client = SubscriptionsContractClient::new(env, &contract_id);
    let plan_id = client.create_plan(&merchant, &token_id, &100, &60);
    mint(env, &token_id, &subscriber, 1000i128);
    (merchant, subscriber, token, token_id, client, plan_id)
}

#[test]
fn test_subscribe_charges_first_period() {
    let env = Env::default();
    let (_merchant, subscriber, token, _token_id, client, plan_id) = setup(&env);

    let sub_id = client.subscribe(&subscriber, &plan_id);
    assert_eq!(sub_id, 1);
    assert_eq!(token.balance(&subscriber), 900);

    let sub = client.get_subscription(&sub_id).unwrap();
    assert!(sub.active);
    assert_eq!(sub.next_payment_at, 1_000_060);
}

#[test]
fn test_duplicate_subscription_rejected() {
    let env = Env::default();
    let (_merchant, subscriber, _token, _token_id, client, plan_id) = setup(&env);
    client.subscribe(&subscriber, &plan_id);

    let result = client.try_subscribe(&subscriber, &plan_id);
    assert_eq!(result, Err(Ok(SubscriptionError::AlreadySubscribed)));
}

#[test]
fn test_renew_advances_period() {
    let env = Env::default();
    let (_merchant, subscriber, token, _token_id, client, plan_id) = setup(&env);
    let sub_id = client.subscribe(&subscriber, &plan_id);

    // Not due yet.
    let result = client.try_renew(&subscriber, &sub_id);
    assert_eq!(result, Err(Ok(SubscriptionError::NotDue)));

    // Advance time and renew.
    env.ledger().set_timestamp(1_000_061);
    client.renew(&subscriber, &sub_id);
    assert_eq!(token.balance(&subscriber), 800);
    assert_eq!(client.get_subscription(&sub_id).unwrap().next_payment_at, 1_000_121);
}

#[test]
fn test_renew_with_insufficient_balance_pauses() {
    let env = Env::default();
    let (merchant, subscriber, token, _token_id, client, plan_id) = setup(&env);
    let sub_id = client.subscribe(&subscriber, &plan_id);

    // Drain the subscriber.
    let drain_to = Address::generate(&env);
    token.transfer(&subscriber, &drain_to, &900);

    env.ledger().set_timestamp(1_000_061);
    let result = client.try_renew(&subscriber, &sub_id);
    assert_eq!(result, Err(Ok(SubscriptionError::TransferFailed)));
    // state is reverted on error — subscription remains active
    assert!(client.get_subscription(&sub_id).unwrap().active);
    // No money moved to the merchant.
    assert_eq!(token.balance(&merchant), 100);
}

#[test]
fn test_cancel() {
    let env = Env::default();
    let (merchant, subscriber, _token, _token_id, client, plan_id) = setup(&env);
    let sub_id = client.subscribe(&subscriber, &plan_id);

    client.cancel(&subscriber, &sub_id);
    assert!(!client.get_subscription(&sub_id).unwrap().active);

    // Merchant can also cancel.
    let sub_id2 = client.subscribe(&subscriber, &plan_id);
    client.cancel(&merchant, &sub_id2);
    assert!(!client.get_subscription(&sub_id2).unwrap().active);

    // Cannot cancel twice.
    let result = client.try_cancel(&subscriber, &sub_id);
    assert_eq!(result, Err(Ok(SubscriptionError::AlreadyCancelled)));
}

// ─── storage layout, the duplicate index, pagination and TTL maintenance ─────

/// Plans, subscriptions and the (plan, subscriber) index are each their own
/// persistent entry — previously both collections were single instance-storage
/// Maps, so one renewal rewrote every subscription in the contract.
#[test]
fn test_plans_and_subscriptions_are_per_key_persistent_entries() {
    let env = Env::default();
    let (_merchant, subscriber, _token, _token_id, client, plan_id) = setup(&env);
    let sub_id = client.subscribe(&subscriber, &plan_id);

    env.as_contract(&client.address, || {
        assert!(env.storage().persistent().has(&DataKey::Plan(plan_id)));
        assert!(env.storage().persistent().has(&DataKey::Subscription(sub_id)));
        assert!(env.storage().persistent().has(&DataKey::ActiveSub(plan_id, subscriber.clone())));
    });
}

/// `subscribe` used to scan every subscription in the contract to decide
/// whether this subscriber already had this plan. The check is now a single
/// indexed lookup, exposed directly as `is_subscribed`.
#[test]
fn test_duplicate_check_uses_the_index_and_is_plan_scoped() {
    let env = Env::default();
    let (merchant, subscriber, _token, token_id, client, plan_id) = setup(&env);
    let other_plan = client.create_plan(&merchant, &token_id, &50, &60);
    let stranger = Address::generate(&env);

    assert!(!client.is_subscribed(&plan_id, &subscriber));
    client.subscribe(&subscriber, &plan_id);

    assert!(client.is_subscribed(&plan_id, &subscriber));
    // The index is keyed by both plan and subscriber, so neither a different
    // plan nor a different subscriber is affected.
    assert!(!client.is_subscribed(&other_plan, &subscriber));
    assert!(!client.is_subscribed(&plan_id, &stranger));
}

#[test]
fn test_cancelling_frees_the_slot_to_subscribe_again() {
    let env = Env::default();
    let (_merchant, subscriber, _token, _token_id, client, plan_id) = setup(&env);
    let sub_id = client.subscribe(&subscriber, &plan_id);

    let result = client.try_subscribe(&subscriber, &plan_id);
    assert_eq!(result, Err(Ok(SubscriptionError::AlreadySubscribed)));

    client.cancel(&subscriber, &sub_id);
    assert!(!client.is_subscribed(&plan_id, &subscriber));

    // Released index: the subscriber may sign up again.
    let again = client.subscribe(&subscriber, &plan_id);
    assert_eq!(again, 2);
    assert!(client.is_subscribed(&plan_id, &subscriber));
}

#[test]
fn test_counts_and_paginated_listings() {
    let env = Env::default();
    let (merchant, subscriber, _token, token_id, client, plan_id) = setup(&env);
    let second_plan = client.create_plan(&merchant, &token_id, &50, &60);
    let first_sub = client.subscribe(&subscriber, &plan_id);
    let second_sub = client.subscribe(&subscriber, &second_plan);

    assert_eq!(client.count_plans(), 2);
    assert_eq!(client.count_subscriptions(), 2);

    let plans = client.list_plan_ids(&1, &1);
    assert_eq!(plans.len(), 1);
    assert_eq!(plans.get(0), Some(plan_id));
    assert_eq!(client.list_plan_ids(&2, &10).get(0), Some(second_plan));

    let subs = client.list_subscription_ids(&1, &10);
    assert_eq!(subs.len(), 2);
    assert_eq!(subs.get(0), Some(first_sub));
    assert_eq!(subs.get(1), Some(second_sub));
}

#[test]
fn test_bump_helpers_keep_an_idle_subscription_alive() {
    let env = Env::default();
    let (_merchant, subscriber, _token, _token_id, client, plan_id) = setup(&env);
    let sub_id = client.subscribe(&subscriber, &plan_id);

    // Permissionless: none of these call require_auth.
    client.bump_instance_ttl();
    client.bump_plan_ttl(&plan_id);
    client.bump_subscription_ttl(&sub_id);

    assert!(client.get_subscription(&sub_id).unwrap().active);
    assert!(client.get_plan(&plan_id).unwrap().active);
}

#[test]
fn test_bump_helpers_reject_unknown_ids() {
    let env = Env::default();
    let (_merchant, _subscriber, _token, _token_id, client, _plan_id) = setup(&env);

    let result = client.try_bump_plan_ttl(&999);
    assert_eq!(result, Err(Ok(SubscriptionError::PlanNotFound)));

    let result = client.try_bump_subscription_ttl(&999);
    assert_eq!(result, Err(Ok(SubscriptionError::SubscriptionNotFound)));
}
