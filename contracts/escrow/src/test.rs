#![cfg(test)]

use super::{EscrowContract, EscrowContractClient, EscrowError, DataKey, DEFAULT_REFUND_WINDOW};
use soroban_sdk::testutils::{Address as AddressUtils, Ledger};
use soroban_sdk::{token, Address, Env};

fn create_token<'e>(env: &'e Env, admin: &Address) -> (token::Client<'e>, Address) {
    let id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (token::Client::new(env, &id), id)
}

fn mint<'e>(env: &'e Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

type Setup<'e> = (Address, Address, Address, token::Client<'e>, Address, Address, EscrowContractClient<'e>);

fn setup<'e>(env: &'e Env) -> Setup<'e> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let alice = Address::generate(env);
    let bob = Address::generate(env);
    let (token, token_id) = create_token(env, &admin);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(env, &contract_id);
    client.initialize(&admin);
    mint(env, &token_id, &alice, 10_000i128);
    mint(env, &token_id, &bob, 10_000i128);
    (admin, alice, bob, token, token_id, contract_id, client)
}

#[test]
fn test_create_holds_funds() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, contract_id, client) = setup(&env);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    assert_eq!(id, 1);
    assert_eq!(token.balance(&alice), 9500);
    assert_eq!(token.balance(&contract_id), 500);

    let escrow = client.get(&id).unwrap();
    assert_eq!(escrow.amount, 500);
    assert!(!escrow.released);
}

#[test]
fn test_cannot_release_before_time() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);

    env.ledger().set_timestamp(999);
    let result = client.try_release(&id, &bob);
    assert_eq!(result, Err(Ok(EscrowError::TooEarly)));
}

#[test]
fn test_release_after_time() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(1001);

    client.release(&id, &bob);
    assert_eq!(token.balance(&bob), 10500);
    assert_eq!(token.balance(&contract_id), 0);

    // Cannot release twice.
    let result = client.try_release(&id, &bob);
    assert_eq!(result, Err(Ok(EscrowError::AlreadyReleased)));
}

#[test]
fn test_refund_before_release() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(999);

    client.refund(&id, &alice);
    assert_eq!(token.balance(&alice), 10000);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_refund_not_allowed_mid_window() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &Some(2000));
    env.ledger().set_timestamp(1500); // between release_time and expiry

    let result = client.try_refund(&id, &alice);
    assert_eq!(result, Err(Ok(EscrowError::NotExpired)));
}

#[test]
fn test_refund_after_expiry() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, _contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &Some(2000));
    env.ledger().set_timestamp(2001);

    client.refund(&id, &alice);
    assert_eq!(token.balance(&alice), 10000);
}

#[test]
fn test_arbiter_can_release() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, contract_id, client) = setup(&env);
    let arbiter = Address::generate(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &Some(arbiter.clone()), &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(1001);

    // The arbiter can release to the counterparty after release_time.
    client.release(&id, &arbiter);
    assert_eq!(token.balance(&bob), 10500);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_unrelated_party_cannot_release() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);
    let stranger = Address::generate(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(1001);

    let result = client.try_release(&id, &stranger);
    assert_eq!(result, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_arbiter_cannot_release_before_time() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);
    let arbiter = Address::generate(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &Some(arbiter.clone()), &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(999);

    let result = client.try_release(&id, &arbiter);
    assert_eq!(result, Err(Ok(EscrowError::TooEarly)));
}

#[test]
fn test_unknown_escrow_errors() {
    let env = Env::default();
    let (_admin, _alice, bob, _token, _token_id, _contract_id, client) = setup(&env);

    let result = client.try_release(&999, &bob);
    assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
}

#[test]
fn test_cannot_initialize_twice() {
    let env = Env::default();
    let (_admin, _alice, _bob, _token, _token_id, _contract_id, client) = setup(&env);

    let new_admin = Address::generate(&env);
    let result = client.try_initialize(&new_admin);
    assert_eq!(result, Err(Ok(EscrowError::AlreadyInitialized)));
}

#[test]
fn test_unrelated_party_cannot_refund() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);
    let stranger = Address::generate(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(999);

    // Stranger is not a party — refund must fail.
    let result = client.try_refund(&id, &stranger);
    assert_eq!(result, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_cannot_release_escrow_not_yet_created() {
    let env = Env::default();
    let (_admin, _alice, bob, _token, _token_id, _contract_id, client) = setup(&env);
    env.ledger().set_timestamp(1001);

    // Try to release a non-existent escrow.
    let result = client.try_release(&999, &bob);
    assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
}

// ─── funds can never be locked forever ───────────────────────────────────────

/// Regression: an escrow created with `expiry: None` used to store `u64::MAX`,
/// and `refund` requires `now > expiry` — so once `release_time` had passed the
/// initiator had no way to reclaim if the counterparty never released. Funds
/// were locked permanently. The default window gives the counterparty a bounded
/// period to act and then guarantees the initiator an exit.
#[test]
fn test_escrow_without_expiry_gets_a_bounded_refund_window() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);

    // The stored deadline is release_time + the default window, not u64::MAX.
    let escrow = client.get(&id).unwrap();
    assert_eq!(escrow.expiry, 1000 + DEFAULT_REFUND_WINDOW);

    // Throughout the window the counterparty keeps the exclusive release right.
    env.ledger().set_timestamp(escrow.expiry - 1);
    let result = client.try_refund(&id, &alice);
    assert_eq!(result, Err(Ok(EscrowError::NotExpired)));

    // Past it the initiator can always reclaim — no permanent lock.
    env.ledger().set_timestamp(escrow.expiry + 1);
    client.refund(&id, &alice);
    assert_eq!(token.balance(&alice), 10000);
    assert_eq!(token.balance(&contract_id), 0);

    let settled = client.get(&id).unwrap();
    assert!(settled.refunded);
}

#[test]
fn test_explicit_expiry_still_overrides_the_default_window() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &Some(2000));

    assert_eq!(client.get(&id).unwrap().expiry, 2000);
}

#[test]
fn test_initiator_can_still_refund_before_release_time() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, _contract_id, client) = setup(&env);
    env.ledger().set_timestamp(100);

    // The default window must not make an early refund stricter than before.
    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    env.ledger().set_timestamp(500);

    client.refund(&id, &alice);
    assert_eq!(token.balance(&alice), 10000);
}

// ─── storage layout, pagination and TTL maintenance ──────────────────────────

#[test]
fn test_escrows_are_per_key_persistent_entries() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, contract_id, client) = setup(&env);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);

    env.as_contract(&contract_id, || {
        // The record is its own ledger entry, not a member of an instance Map.
        assert!(env.storage().persistent().has(&DataKey::Escrow(id)));
        assert_eq!(env.storage().instance().get::<_, u64>(&DataKey::NextId), Some(2));
    });
}

#[test]
fn test_count_tracks_the_highest_assigned_id() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);

    assert_eq!(client.count(), 0);
    client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    assert_eq!(client.count(), 1);
    client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    assert_eq!(client.count(), 2);
}

#[test]
fn test_list_ids_paginates_without_an_index_entry() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);

    for _ in 0..3 {
        client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    }

    let first = client.list_ids(&1, &2);
    assert_eq!(first.len(), 2);
    assert_eq!(first.get(0), Some(1));
    assert_eq!(first.get(1), Some(2));

    // Second page, past the end, and an out-of-range start.
    let second = client.list_ids(&3, &2);
    assert_eq!(second.len(), 1);
    assert_eq!(second.get(0), Some(3));
    assert_eq!(client.list_ids(&4, &2).len(), 0);
    assert_eq!(client.list_ids(&0, &1).get(0), Some(1));
}

#[test]
fn test_list_ids_caps_a_page_at_the_maximum_size() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);

    for _ in 0..3 {
        client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    }

    // An unbounded request is clamped, so one call can never exceed the budget.
    assert_eq!(client.list_ids(&1, &10_000).len(), 3);
}

#[test]
fn test_list_returns_the_records_for_a_page() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);

    let first_id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);
    client.create(&alice, &bob, &None, &token_id, &700, &1000, &None);

    let page = client.list(&1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().id, first_id);
    assert_eq!(page.get(0).unwrap().amount, 500);
}

#[test]
fn test_bump_helpers_keep_an_idle_contract_alive() {
    let env = Env::default();
    let (_admin, alice, bob, _token, token_id, _contract_id, client) = setup(&env);

    let id = client.create(&alice, &bob, &None, &token_id, &500, &1000, &None);

    // Both are permissionless: neither calls require_auth, so any account can
    // pay the rent for an idle contract or a single escrow.
    client.bump_instance_ttl();
    client.bump_escrow_ttl(&id);

    // The escrow is still readable and still intact afterwards.
    assert_eq!(client.get(&id).unwrap().amount, 500);
}

#[test]
fn test_bump_escrow_ttl_rejects_an_unknown_id() {
    let env = Env::default();
    let (_admin, _alice, _bob, _token, _token_id, _contract_id, client) = setup(&env);

    let result = client.try_bump_escrow_ttl(&999);
    assert_eq!(result, Err(Ok(EscrowError::EscrowNotFound)));
}
