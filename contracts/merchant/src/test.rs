#![cfg(test)]

use super::{MerchantContract, MerchantContractClient, MerchantError, DataKey};
use soroban_sdk::testutils::Address as AddressUtils;
use soroban_sdk::{token, Address, Env, String};

fn create_token<'e>(env: &'e Env, admin: &Address) -> (token::Client<'e>, Address) {
    let id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (token::Client::new(env, &id), id)
}

type Setup<'e> = (
    Address,
    Address,
    Address,
    token::Client<'e>,
    Address,
    Address,
    MerchantContractClient<'e>,
    u64,
);

fn setup<'e>(env: &'e Env) -> Setup<'e> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let settlement = Address::generate(env);
    let (token, token_id) = create_token(env, &admin);
    let contract_id = env.register_contract(None, MerchantContract);
    let client = MerchantContractClient::new(env, &contract_id);
    client.initialize(&admin);
    // Mint tokens to the owner (who acts as the paying customer in tests).
    mint(env, &token_id, &owner, 10_000i128);
    let id = client.register(&owner, &String::from_str(env, "Demo Coffee Co."), &settlement, &100);
    (admin, owner, settlement, token, token_id, contract_id, client, id)
}

fn mint<'e>(env: &'e Env, token_id: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_id).mint(to, &amount);
}

#[test]
fn test_register_creates_profile() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, _token_id, _contract_id, client, id) = setup(&env);
    let profile = client.get(&id).unwrap();
    assert_eq!(profile.owner, owner);
    assert_eq!(profile.commission_bps, 100);
    assert!(profile.active);
}

#[test]
fn test_record_sale_transfers_and_accrues_balance() {
    let env = Env::default();
    let (_admin, owner, _settlement, token, token_id, contract_id, client, id) = setup(&env);

    let payer_balance_before = token.balance(&owner);
    client.record_sale(&owner, &id, &token_id, &1000);

    // Payer's balance decreased.
    assert_eq!(token.balance(&owner), payer_balance_before - 1000);
    // Contract now holds the tokens.
    assert_eq!(token.balance(&contract_id), 1000);
    // Merchant's internal balance is credited.
    assert_eq!(client.held_balance(&id, &token_id), 1000);
}

#[test]
fn test_settle_withholds_commission() {
    let env = Env::default();
    let (admin, owner, settlement, token, token_id, contract_id, client, id) = setup(&env);

    // Customer (owner) pays 1000 to the contract via record_sale.
    client.record_sale(&owner, &id, &token_id, &1000);
    assert_eq!(token.balance(&contract_id), 1000);

    // Merchant owner settles.
    client.settle(&owner, &id, &token_id);

    // 1000 * 100bps / 10000 = 10 commission -> 990 net to settlement.
    assert_eq!(token.balance(&settlement), 990);
    assert_eq!(token.balance(&admin), 10);
    assert_eq!(client.held_balance(&id, &token_id), 0);
    // Contract balance should be empty after settlement.
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_settle_requires_owner() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, _contract_id, client, id) = setup(&env);
    client.record_sale(&owner, &id, &token_id, &1000);
    let attacker = Address::generate(&env);

    let result = client.try_settle(&attacker, &id, &token_id);
    assert_eq!(result, Err(Ok(MerchantError::Unauthorized)));
    // State integrity: tokens and balances are untouched after failed attempt.
    assert_eq!(client.held_balance(&id, &token_id), 1000);
}

#[test]
fn test_inactive_merchant_rejects_sales() {
    let env = Env::default();
    let (admin, owner, _settlement, _token, token_id, _contract_id, client, id) = setup(&env);
    client.set_active(&admin, &id, &false);

    let result = client.try_record_sale(&owner, &id, &token_id, &10);
    assert_eq!(result, Err(Ok(MerchantError::InactiveMerchant)));
}

#[test]
fn test_admin_commission_override() {
    let env = Env::default();
    let (admin, owner, settlement, token, token_id, contract_id, client, id) = setup(&env);
    client.set_commission(&admin, &id, &250);
    client.record_sale(&owner, &id, &token_id, &1000);
    client.settle(&owner, &id, &token_id);

    // 1000 * 250bps / 10000 = 25 commission -> 975 net to settlement, 25 to admin.
    assert_eq!(token.balance(&settlement), 975);
    assert_eq!(token.balance(&admin), 25);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn test_record_sale_rejects_zero_amount() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, _contract_id, client, id) = setup(&env);

    let result = client.try_record_sale(&owner, &id, &token_id, &0);
    assert_eq!(result, Err(Ok(MerchantError::InvalidAmount)));
}

#[test]
fn test_record_sale_rejects_unknown_merchant() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, _contract_id, client, _id) = setup(&env);

    let result = client.try_record_sale(&owner, &999, &token_id, &100);
    assert_eq!(result, Err(Ok(MerchantError::MerchantNotFound)));
}

#[test]
fn test_settle_rejects_when_no_balance() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, _contract_id, client, id) = setup(&env);

    // No sales recorded — settle should fail with NoBalance.
    let result = client.try_settle(&owner, &id, &token_id);
    assert_eq!(result, Err(Ok(MerchantError::NoBalance)));
}

// ─── storage layout, pagination and TTL maintenance ──────────────────────────

/// Profiles and held balances used to be two nested instance-storage Maps, so
/// any merchant's sale rewrote every merchant's record. Each is now its own
/// persistent entry.
#[test]
fn test_profiles_and_balances_are_per_key_persistent_entries() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, contract_id, client, id) = setup(&env);
    client.record_sale(&owner, &id, &token_id, &1000);

    env.as_contract(&contract_id, || {
        assert!(env.storage().persistent().has(&DataKey::Merchant(id)));
        assert_eq!(
            env.storage().persistent().get::<_, i128>(&DataKey::Balance(id, token_id.clone())),
            Some(1000),
        );
    });
}

#[test]
fn test_settle_clears_the_balance_entry_rather_than_zeroing_it() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, contract_id, client, id) = setup(&env);
    client.record_sale(&owner, &id, &token_id, &1000);
    client.settle(&owner, &id, &token_id);

    assert_eq!(client.held_balance(&id, &token_id), 0);
    env.as_contract(&contract_id, || {
        assert!(!env.storage().persistent().has(&DataKey::Balance(id, token_id.clone())));
    });
}

#[test]
fn test_count_tracks_registered_merchants() {
    let env = Env::default();
    let (_admin, owner, settlement, _token, _token_id, _contract_id, client, _id) = setup(&env);

    assert_eq!(client.count(), 1);
    client.register(&owner, &String::from_str(&env, "Second Co."), &settlement, &50);
    assert_eq!(client.count(), 2);
}

#[test]
fn test_list_ids_paginates() {
    let env = Env::default();
    let (_admin, owner, settlement, _token, _token_id, _contract_id, client, _id) = setup(&env);
    client.register(&owner, &String::from_str(&env, "Second Co."), &settlement, &50);
    client.register(&owner, &String::from_str(&env, "Third Co."), &settlement, &50);

    let first = client.list_ids(&1, &2);
    assert_eq!(first.len(), 2);
    assert_eq!(first.get(0), Some(1));
    assert_eq!(first.get(1), Some(2));

    let second = client.list_ids(&3, &2);
    assert_eq!(second.len(), 1);
    assert_eq!(second.get(0), Some(3));
    assert_eq!(client.list_ids(&4, &2).len(), 0);
}

#[test]
fn test_list_returns_the_records_for_a_page() {
    let env = Env::default();
    let (_admin, _owner, _settlement, _token, _token_id, _contract_id, client, id) = setup(&env);

    let page = client.list(&1, &10);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().id, id);
    assert_eq!(page.get(0).unwrap().commission_bps, 100);
}

#[test]
fn test_bump_helpers_cover_profiles_and_held_funds() {
    let env = Env::default();
    let (_admin, owner, _settlement, _token, token_id, _contract_id, client, id) = setup(&env);
    client.record_sale(&owner, &id, &token_id, &1000);

    // Permissionless: none of these call require_auth.
    client.bump_instance_ttl();
    client.bump_merchant_ttl(&id);
    client.bump_balance_ttl(&id, &token_id);

    assert_eq!(client.held_balance(&id, &token_id), 1000);
}

#[test]
fn test_bump_merchant_ttl_rejects_unknown_id() {
    let env = Env::default();
    let (_admin, _owner, _settlement, _token, _token_id, _contract_id, client, _id) = setup(&env);

    let result = client.try_bump_merchant_ttl(&999);
    assert_eq!(result, Err(Ok(MerchantError::MerchantNotFound)));
}

#[test]
fn test_bump_balance_ttl_rejects_an_empty_balance() {
    let env = Env::default();
    let (_admin, _owner, _settlement, _token, token_id, _contract_id, client, id) = setup(&env);

    // No sale recorded, so there is nothing held to keep alive.
    let result = client.try_bump_balance_ttl(&id, &token_id);
    assert_eq!(result, Err(Ok(MerchantError::NoBalance)));
}
