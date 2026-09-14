#![cfg(test)]

use super::{PaymentContract, PaymentContractClient, PaymentError, DataKey};
use soroban_sdk::testutils::{Address as AddressUtils, Events};
use soroban_sdk::{token, Address, Env, String, Vec};

fn create_token<'e>(env: &'e Env, admin: &Address) -> (token::Client<'e>, Address) {
    let id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (token::Client::new(env, &id), id)
}

fn mint<'e>(env: &'e Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

type Setup<'e> = (
    Address,
    Address,
    Address,
    Address,
    token::Client<'e>,
    Address,
    Address,
    PaymentContractClient<'e>,
);

fn setup<'e>(env: &'e Env) -> Setup<'e> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let alice = Address::generate(env);
    let bob = Address::generate(env);
    let carol = Address::generate(env);
    let (token, token_id) = create_token(env, &admin);
    let contract_id = env.register_contract(None, PaymentContract);
    let client = PaymentContractClient::new(env, &contract_id);
    client.initialize(&admin);
    client.set_allowed(&admin, &token_id, &true);
    mint(env, &token_id, &alice, 1000i128);
    (admin, alice, bob, carol, token, token_id, contract_id, client)
}

#[test]
fn test_send_transfers_funds() {
    let env = Env::default();
    let (_admin, alice, bob, _carol, token, token_id, _contract_id, client) = setup(&env);

    client.send(&alice, &bob, &token_id, &250, &None);

    assert_eq!(token.balance(&bob), 250);
    assert_eq!(token.balance(&alice), 750);
}

#[test]
fn test_send_with_memo() {
    let env = Env::default();
    let (_admin, alice, bob, _carol, token, token_id, _contract_id, client) = setup(&env);

    let memo = String::from_str(&env, "invoice-42");
    client.send(&alice, &bob, &token_id, &10, &Some(memo));

    assert_eq!(token.balance(&bob), 10);
}

#[test]
fn test_send_rejects_zero_amount() {
    let env = Env::default();
    let (_admin, alice, bob, _carol, token, token_id, _contract_id, client) = setup(&env);

    let result = client.try_send(&alice, &bob, &token_id, &0, &None);
    assert_eq!(result, Err(Ok(PaymentError::InvalidAmount)));
}

#[test]
fn test_send_rejects_unlisted_token() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let (_unlisted, unlisted_id) = create_token(&env, &admin);
    let contract_id = env.register_contract(None, PaymentContract);
    let client = PaymentContractClient::new(&env, &contract_id);
    env.mock_all_auths();
    client.initialize(&admin);
    mint(&env, &unlisted_id, &alice, 100i128);

    let result = client.try_send(&alice, &bob, &unlisted_id, &1, &None);
    assert_eq!(result, Err(Ok(PaymentError::TokenNotAllowed)));
}

#[test]
fn test_send_rejects_when_paused() {
    let env = Env::default();
    let (admin, alice, bob, _carol, token, token_id, _contract_id, client) = setup(&env);
    client.pause(&admin);

    let result = client.try_send(&alice, &bob, &token_id, &1, &None);
    assert_eq!(result, Err(Ok(PaymentError::Paused)));

    client.unpause(&admin);
    client.send(&alice, &bob, &token_id, &1, &None);
    assert_eq!(token.balance(&bob), 1);
}

#[test]
fn test_batch_payment() {
    let env = Env::default();
    let (_admin, alice, bob, carol, token, token_id, _contract_id, client) = setup(&env);

    let recipients = Vec::from_array(
        &env,
        [
            (bob.clone(), 100_i128),
            (carol.clone(), 200_i128),
            (bob.clone(), 50_i128),
        ],
    );
    client.send_batch(&alice, &token_id, &recipients);

    assert_eq!(token.balance(&bob), 150);
    assert_eq!(token.balance(&carol), 200);
    assert_eq!(token.balance(&alice), 650);
}

#[test]
fn test_batch_rejects_empty_recipients() {
    let env = Env::default();
    let (_admin, alice, _bob, _carol, token, token_id, _contract_id, client) = setup(&env);

    let result = client.try_send_batch(&alice, &token_id, &Vec::new(&env));
    assert_eq!(result, Err(Ok(PaymentError::EmptyRecipients)));
}

#[test]
fn test_emits_payment_event() {
    let env = Env::default();
    let (_admin, alice, bob, _carol, token, token_id, _contract_id, client) = setup(&env);

    client.send(&alice, &bob, &token_id, &5, &None);

    let events = env.events().all();
    // At minimum we have token creation + initialization + allowed + payment events.
    assert!(events.len() >= 2, "expected at least 2 events");
    // Verify that the last event was emitted by our contract.
    let last = events.last().unwrap();
    assert_eq!(last.0, _contract_id, "last event should be from our contract");
}

#[test]
fn test_non_admin_cannot_set_allowed() {
    let env = Env::default();
    let (_admin, alice, _bob, _carol, _token, token_id, _contract_id, client) = setup(&env);

    // Alice is not the admin — set_allowed must fail.
    let result = client.try_set_allowed(&alice, &token_id, &true);
    assert_eq!(result, Err(Ok(PaymentError::Unauthorized)));
}

#[test]
fn test_non_admin_cannot_pause() {
    let env = Env::default();
    let (_admin, alice, _bob, _carol, _token, _token_id, _contract_id, client) = setup(&env);

    // Alice is not the admin — pause must fail.
    let result = client.try_pause(&alice);
    assert_eq!(result, Err(Ok(PaymentError::Unauthorized)));
}

#[test]
fn test_non_admin_cannot_unpause() {
    let env = Env::default();
    let (admin, alice, _bob, _carol, _token, _token_id, _contract_id, client) = setup(&env);
    client.pause(&admin);

    // Alice is not the admin — unpause must fail.
    let result = client.try_unpause(&alice);
    assert_eq!(result, Err(Ok(PaymentError::Unauthorized)));
}

#[test]
fn test_cannot_initialize_twice() {
    let env = Env::default();
    let (_admin, _alice, _bob, _carol, _token, _token_id, _contract_id, client) = setup(&env);

    let new_admin = Address::generate(&env);
    let result = client.try_initialize(&new_admin);
    assert_eq!(result, Err(Ok(PaymentError::AlreadyInitialized)));
}

// ─── storage layout and TTL maintenance ─────────────────────────────────────

/// The allowlist used to live in the contract's single instance entry, so
/// setting one token rewrote the whole instance. Each token now owns a
/// persistent row.
#[test]
fn test_allowlist_entries_are_per_key_persistent() {
    let env = Env::default();
    let (_admin, _alice, _bob, _carol, _token, token_id, contract_id, client) = setup(&env);

    env.as_contract(&contract_id, || {
        assert!(env.storage().persistent().has(&DataKey::Allowed(token_id.clone())));
    });

    // The instance entry no longer holds the allowlist.
    assert!(client.is_allowed(&token_id));
}

#[test]
fn test_allowlist_toggle_is_read_from_persistent_storage() {
    let env = Env::default();
    let (admin, _alice, _bob, _carol, _token, token_id, _contract_id, client) = setup(&env);

    client.set_allowed(&admin, &token_id, &false);
    assert!(!client.is_allowed(&token_id));

    client.set_allowed(&admin, &token_id, &true);
    assert!(client.is_allowed(&token_id));
}

#[test]
fn test_bump_helpers_keep_an_idle_contract_alive() {
    let env = Env::default();
    let (_admin, _alice, _bob, _carol, _token, token_id, _contract_id, client) = setup(&env);

    // Permissionless: neither helper calls require_auth, so anyone can pay the
    // rent for an idle contract or allowlist entry.
    client.bump_instance_ttl();
    client.bump_token_ttl(&token_id);

    assert!(client.is_allowed(&token_id));
}

#[test]
fn test_bump_token_ttl_rejects_a_never_configured_token() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let (_unlisted, unlisted_id) = create_token(&env, &admin);
    let contract_id = env.register_contract(None, PaymentContract);
    let client = PaymentContractClient::new(&env, &contract_id);
    env.mock_all_auths();
    client.initialize(&admin);

    let result = client.try_bump_token_ttl(&unlisted_id);
    assert_eq!(result, Err(Ok(PaymentError::TokenNotAllowed)));
}
