#![cfg(test)]

use super::{InvoicesContract, InvoicesContractClient, InvoiceError, DataKey};
use soroban_sdk::testutils::{Address as AddressUtils, Ledger};
use soroban_sdk::{token, Address, Env, String};

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
    token::Client<'e>,
    Address,
    InvoicesContractClient<'e>,
);

fn setup<'e>(env: &'e Env) -> Setup<'e> {
    env.mock_all_auths();
    let merchant = Address::generate(env);
    let customer = Address::generate(env);
    let admin = Address::generate(env);
    let (token, token_id) = create_token(env, &admin);
    let contract_id = env.register_contract(None, InvoicesContract);
    let client = InvoicesContractClient::new(env, &contract_id);
    mint(env, &token_id, &customer, 10_000i128);
    (merchant, customer, token, token_id, client)
}

fn create_invoice<'e>(
    env: &'e Env,
    client: &InvoicesContractClient<'e>,
    merchant: &Address,
    customer: &Address,
    token_id: &Address,
    amount: i128,
    due: u64,
) -> u64 {
    client
        .create(
            merchant,
            customer,
            token_id,
            &amount,
            &String::from_str(env, "Test invoice"),
            &due,
        )
}

// ------------------------------------------------------------------ Create

#[test]
fn test_create_invoice() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);

    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 1000);
    assert_eq!(id, 1);

    let invoice = client.get_invoice(&id).unwrap();
    assert_eq!(invoice.merchant, merchant);
    assert_eq!(invoice.customer, customer);
    assert_eq!(invoice.amount, 500);
    assert!(!invoice.paid);
    assert!(!invoice.cancelled);
}

#[test]
fn test_create_rejects_zero_amount() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);

    let result = client.try_create(
        &merchant,
        &customer,
        &token_id,
        &0,
        &String::from_str(&env, ""),
        &0u64,
    );
    assert_eq!(result, Err(Ok(InvoiceError::InvalidAmount)));
}

#[test]
fn test_create_multiple_invoices() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);

    let id1 = create_invoice(&env, &client, &merchant, &customer, &token_id, 100, 0);
    let id2 = create_invoice(&env, &client, &merchant, &customer, &token_id, 200, 0);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert!(client.get_invoice(&1).is_some());
    assert!(client.get_invoice(&2).is_some());
}

// ------------------------------------------------------------------ Pay

#[test]
fn test_pay_invoice_transfers_funds() {
    let env = Env::default();
    let (merchant, customer, token, token_id, client) = setup(&env);

    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);
    let bal_before = token.balance(&merchant);

    client.pay(&customer, &id);
    assert_eq!(token.balance(&merchant), bal_before + 500);
    assert!(client.get_invoice(&id).unwrap().paid);
}

#[test]
fn test_pay_rejects_wrong_payer() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    let stranger = Address::generate(&env);
    mint(&env, &token_id, &stranger, 1000i128);
    let result = client.try_pay(&stranger, &id);
    assert_eq!(result, Err(Ok(InvoiceError::PayerMismatch)));
}

#[test]
fn test_pay_rejects_already_paid() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    client.pay(&customer, &id);
    let result = client.try_pay(&customer, &id);
    assert_eq!(result, Err(Ok(InvoiceError::AlreadyPaid)));
}

#[test]
fn test_pay_rejects_cancelled_invoice() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    client.cancel(&merchant, &id);
    let result = client.try_pay(&customer, &id);
    assert_eq!(result, Err(Ok(InvoiceError::AlreadyCancelled)));
}

#[test]
fn test_pay_rejects_expired_invoice() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    env.ledger().set_timestamp(100);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 500);

    env.ledger().set_timestamp(501);
    let result = client.try_pay(&customer, &id);
    assert_eq!(result, Err(Ok(InvoiceError::Expired)));
}

#[test]
fn test_pay_rejects_unknown_invoice() {
    let env = Env::default();
    let (_merchant, customer, _token, _token_id, client) = setup(&env);

    let result = client.try_pay(&customer, &999);
    assert_eq!(result, Err(Ok(InvoiceError::InvoiceNotFound)));
}

// ------------------------------------------------------------------ Cancel

#[test]
fn test_cancel_invoice() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    client.cancel(&merchant, &id);
    assert!(client.get_invoice(&id).unwrap().cancelled);
}

#[test]
fn test_cancel_rejects_unauthorized() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    let stranger = Address::generate(&env);
    let result = client.try_cancel(&stranger, &id);
    assert_eq!(result, Err(Ok(InvoiceError::Unauthorized)));
}

#[test]
fn test_cancel_rejects_already_paid() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    client.pay(&customer, &id);
    let result = client.try_cancel(&merchant, &id);
    assert_eq!(result, Err(Ok(InvoiceError::AlreadyPaid)));
}

#[test]
fn test_cancel_rejects_unknown_invoice() {
    let env = Env::default();
    let (merchant, _customer, _token, _token_id, client) = setup(&env);

    let result = client.try_cancel(&merchant, &999);
    assert_eq!(result, Err(Ok(InvoiceError::InvoiceNotFound)));
}

#[test]
fn test_cannot_cancel_twice() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    client.cancel(&merchant, &id);
    let result = client.try_cancel(&merchant, &id);
    assert_eq!(result, Err(Ok(InvoiceError::AlreadyCancelled)));
}

// ------------------------------------------------------------------ Queries

#[test]
fn test_invoices_of_returns_merchant_invoices() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id1 = create_invoice(&env, &client, &merchant, &customer, &token_id, 100, 0);
    let id2 = create_invoice(&env, &client, &merchant, &customer, &token_id, 200, 0);

    let list = client.invoices_of(&merchant, &1, &10);
    assert_eq!(list.len(), 2);
    assert!(list.contains(id1));
    assert!(list.contains(id2));
}

#[test]
fn test_invoices_of_empty_for_unknown() {
    let env = Env::default();
    let (_merchant, _customer, _token, _token_id, client) = setup(&env);
    let stranger = Address::generate(&env);

    let list = client.invoices_of(&stranger, &1, &10);
    assert_eq!(list.len(), 0);
}

#[test]
fn test_get_invoice_returns_none_for_unknown() {
    let env = Env::default();
    let (_merchant, _customer, _token, _token_id, client) = setup(&env);

    assert!(client.get_invoice(&999).is_none());
}

// ─── storage layout, pagination and TTL maintenance ──────────────────────────

#[test]
fn test_invoices_are_per_key_persistent_entries() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    env.as_contract(&client.address, || {
        assert!(env.storage().persistent().has(&DataKey::Invoice(id)));
    });
}

#[test]
fn test_count_tracks_invoices_issued() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);

    assert_eq!(client.count(), 0);
    create_invoice(&env, &client, &merchant, &customer, &token_id, 100, 0);
    create_invoice(&env, &client, &merchant, &customer, &token_id, 200, 0);
    assert_eq!(client.count(), 2);
}

#[test]
fn test_list_ids_paginates() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    for _ in 0..3 {
        create_invoice(&env, &client, &merchant, &customer, &token_id, 100, 0);
    }

    let first = client.list_ids(&1, &2);
    assert_eq!(first.len(), 2);
    assert_eq!(first.get(0), Some(1));
    assert_eq!(first.get(1), Some(2));

    let second = client.list_ids(&3, &2);
    assert_eq!(second.len(), 1);
    assert_eq!(second.get(0), Some(3));
    assert_eq!(client.list_ids(&4, &2).len(), 0);
}

/// The previous per-merchant index was a `Map<Address, Vec<u64>>` that grew
/// without bound. It is now a key per position, so a page costs O(page) and the
/// merchant owns an explicit count to paginate against.
#[test]
fn test_invoices_of_paginates_with_a_per_merchant_count() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    for _ in 0..3 {
        create_invoice(&env, &client, &merchant, &customer, &token_id, 100, 0);
    }

    assert_eq!(client.invoices_of_count(&merchant), 3);

    let first = client.invoices_of(&merchant, &1, &2);
    assert_eq!(first.len(), 2);
    assert_eq!(first.get(0), Some(1));

    let second = client.invoices_of(&merchant, &3, &2);
    assert_eq!(second.len(), 1);
    assert_eq!(second.get(0), Some(3));

    // A page past the end is empty, not an error.
    assert_eq!(client.invoices_of(&merchant, &4, &2).len(), 0);
}

#[test]
fn test_merchant_index_is_isolated_per_merchant() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let other = Address::generate(&env);

    let mine = create_invoice(&env, &client, &merchant, &customer, &token_id, 100, 0);
    create_invoice(&env, &client, &other, &customer, &token_id, 200, 0);

    assert_eq!(client.invoices_of_count(&merchant), 1);
    assert_eq!(client.invoices_of_count(&other), 1);
    assert_eq!(client.invoices_of(&merchant, &1, &10).get(0), Some(mine));

    let theirs = client.invoices_of(&other, &1, &10);
    assert_ne!(theirs.get(0), Some(mine));
}

#[test]
fn test_bump_helpers_restore_an_idle_contract() {
    let env = Env::default();
    let (merchant, customer, _token, token_id, client) = setup(&env);
    let id = create_invoice(&env, &client, &merchant, &customer, &token_id, 500, 0);

    // Permissionless: no require_auth on any of these.
    client.bump_instance_ttl();
    client.bump_invoice_ttl(&id);
    assert_eq!(client.bump_merchant_index_ttl(&merchant, &1, &10), 1);

    assert!(client.get_invoice(&id).is_some());
}

#[test]
fn test_bump_invoice_ttl_rejects_unknown_id() {
    let env = Env::default();
    let (_merchant, _customer, _token, _token_id, client) = setup(&env);

    let result = client.try_bump_invoice_ttl(&999);
    assert_eq!(result, Err(Ok(InvoiceError::InvoiceNotFound)));
}
