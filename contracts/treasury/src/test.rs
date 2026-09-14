#![cfg(test)]

use super::{TreasuryContract, TreasuryContractClient, TreasuryError, DataKey};
use soroban_sdk::testutils::Address as AddressUtils;
use soroban_sdk::{token, Address, Env};

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
    Address,
    TreasuryContractClient<'e>,
);

fn setup<'e>(env: &'e Env) -> Setup<'e> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let depositor = Address::generate(env);
    let (token, token_id) = create_token(env, &admin);
    let contract_id = env.register_contract(None, TreasuryContract);
    let client = TreasuryContractClient::new(env, &contract_id);
    client.initialize(&admin);
    client.set_allowed(&admin, &token_id, &true);
    mint(env, &token_id, &depositor, 10_000i128);
    (admin, depositor, token, token_id, contract_id, client)
}

// ------------------------------------------------------------------ Deposit

#[test]
fn test_deposit_transfers_tokens_to_contract() {
    let env = Env::default();
    let (_admin, depositor, token, token_id, contract_id, client) = setup(&env);

    let before = token.balance(&depositor);
    client.deposit(&depositor, &token_id, &500);
    assert_eq!(token.balance(&depositor), before - 500);
    assert_eq!(token.balance(&contract_id), 500);
}

#[test]
fn test_deposit_rejects_zero() {
    let env = Env::default();
    let (_admin, depositor, _token, token_id, _contract_id, client) = setup(&env);

    let result = client.try_deposit(&depositor, &token_id, &0);
    assert_eq!(result, Err(Ok(TreasuryError::InvalidAmount)));
}

#[test]
fn test_deposit_rejects_unlisted_token() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let (_unlisted, unlisted_id) = create_token(&env, &admin);
    let contract_id = env.register_contract(None, TreasuryContract);
    let client = TreasuryContractClient::new(&env, &contract_id);
    env.mock_all_auths();
    client.initialize(&admin);
    mint(&env, &unlisted_id, &depositor, 100i128);

    let result = client.try_deposit(&depositor, &unlisted_id, &10);
    assert_eq!(result, Err(Ok(TreasuryError::TokenNotAllowed)));
}

#[test]
fn test_deposit_accrues_treasury_balance() {
    let env = Env::default();
    let (_admin, depositor, token, token_id, contract_id, client) = setup(&env);

    client.deposit(&depositor, &token_id, &300);
    client.deposit(&depositor, &token_id, &200);

    assert_eq!(client.balance(&token_id), 500);
    assert_eq!(token.balance(&contract_id), 500);
}

// ------------------------------------------------------------------ Withdraw

#[test]
fn test_withdraw_sends_funds() {
    let env = Env::default();
    let (admin, depositor, token, token_id, _contract_id, client) = setup(&env);
    client.deposit(&depositor, &token_id, &1000);

    let recipient = Address::generate(&env);
    client.withdraw(&admin, &token_id, &recipient, &400);

    assert_eq!(token.balance(&recipient), 400);
    assert_eq!(client.balance(&token_id), 600);
}

#[test]
fn test_withdraw_rejects_zero_amount() {
    let env = Env::default();
    let (admin, _depositor, _token, token_id, _contract_id, client) = setup(&env);
    let recipient = Address::generate(&env);

    let result = client.try_withdraw(&admin, &token_id, &recipient, &0);
    assert_eq!(result, Err(Ok(TreasuryError::InvalidAmount)));
}

#[test]
fn test_withdraw_rejects_unauthorized() {
    let env = Env::default();
    let (_admin, depositor, _token, token_id, _contract_id, client) = setup(&env);
    client.deposit(&depositor, &token_id, &500);

    let attacker = Address::generate(&env);
    let recipient = Address::generate(&env);
    let result = client.try_withdraw(&attacker, &token_id, &recipient, &100);
    assert_eq!(result, Err(Ok(TreasuryError::Unauthorized)));
}

#[test]
fn test_withdraw_rejects_exceeding_cap() {
    let env = Env::default();
    let (admin, depositor, token, token_id, _contract_id, client) = setup(&env);
    client.deposit(&depositor, &token_id, &1000);
    client.set_max_withdrawal(&admin, &token_id, &200);

    let recipient = Address::generate(&env);
    // Within cap should succeed.
    client.withdraw(&admin, &token_id, &recipient, &200);
    assert_eq!(token.balance(&recipient), 200);

    // Above cap should fail.
    let result = client.try_withdraw(&admin, &token_id, &recipient, &201);
    assert_eq!(result, Err(Ok(TreasuryError::WithdrawalCapped)));
}

#[test]
fn test_withdraw_rejects_insufficient_balance() {
    let env = Env::default();
    let (admin, depositor, _token, token_id, _contract_id, client) = setup(&env);
    client.deposit(&depositor, &token_id, &100);

    let recipient = Address::generate(&env);
    let result = client.try_withdraw(&admin, &token_id, &recipient, &101);
    assert_eq!(result, Err(Ok(TreasuryError::InvalidAmount)));
}

// ------------------------------------------------------------------ Admin

#[test]
fn test_set_allowed_toggle() {
    let env = Env::default();
    let (admin, _depositor, _token, token_id, _contract_id, client) = setup(&env);

    assert!(client.allowlisted(&token_id));

    client.set_allowed(&admin, &token_id, &false);
    assert!(!client.allowlisted(&token_id));

    client.set_allowed(&admin, &token_id, &true);
    assert!(client.allowlisted(&token_id));
}

#[test]
fn test_set_allowed_rejects_unauthorized() {
    let env = Env::default();
    let (_admin, _depositor, _token, token_id, _contract_id, client) = setup(&env);
    let attacker = Address::generate(&env);

    let result = client.try_set_allowed(&attacker, &token_id, &false);
    assert_eq!(result, Err(Ok(TreasuryError::Unauthorized)));
}

#[test]
fn test_set_max_withdrawal_enforces_cap() {
    let env = Env::default();
    let (admin, depositor, token, token_id, _contract_id, client) = setup(&env);
    client.deposit(&depositor, &token_id, &1000);
    client.set_max_withdrawal(&admin, &token_id, &300);

    // Within cap — succeeds.
    let recipient = Address::generate(&env);
    client.withdraw(&admin, &token_id, &recipient, &300);
    assert_eq!(token.balance(&recipient), 300);

    // Above cap — rejected.
    let result = client.try_withdraw(&admin, &token_id, &recipient, &301);
    assert_eq!(result, Err(Ok(TreasuryError::WithdrawalCapped)));
}

#[test]
fn test_set_max_withdrawal_unauthorized() {
    let env = Env::default();
    let (_admin, _depositor, _token, token_id, _contract_id, client) = setup(&env);
    let attacker = Address::generate(&env);

    let result = client.try_set_max_withdrawal(&attacker, &token_id, &500);
    assert_eq!(result, Err(Ok(TreasuryError::Unauthorized)));
}

// ------------------------------------------------------------ Governance

type GovernanceSetup<'e> = (
    Address,
    Address,
    Address,
    token::Client<'e>,
    Address,
    Address,
    TreasuryContractClient<'e>,
);

fn governance_setup<'e>(env: &'e Env, threshold: u32) -> GovernanceSetup<'e> {
    let (admin, depositor, token, token_id, contract_id, client) = setup(env);
    let alice = Address::generate(env);
    let bob = Address::generate(env);
    let members = soroban_sdk::vec![env, alice.clone(), bob.clone()];
    client.set_governance(&admin, &members, &threshold);
    client.deposit(&depositor, &token_id, &1000);
    (admin, alice, bob, token, token_id, contract_id, client)
}

#[test]
fn test_governance_requires_quorum_to_execute() {
    let env = Env::default();
    let (_admin, alice, bob, token, token_id, _contract_id, client) = governance_setup(&env, 2);
    let recipient = Address::generate(&env);

    let id = client.propose_withdraw(&alice, &token_id, &recipient, &400);
    assert_eq!(id, 1);

    // One approval below quorum — nothing executes.
    client.approve_withdraw(&alice, &id);
    let result = client.try_execute_withdraw(&bob, &id);
    assert_eq!(result, Err(Ok(TreasuryError::QuorumNotReached)));
    assert_eq!(token.balance(&recipient), 0);

    // Second approval reaches quorum — execution transfers the funds.
    client.approve_withdraw(&bob, &id);
    client.execute_withdraw(&bob, &id);
    assert_eq!(token.balance(&recipient), 400);
    assert_eq!(client.balance(&token_id), 600);

    // Cannot execute twice.
    let result = client.try_execute_withdraw(&bob, &id);
    assert_eq!(result, Err(Ok(TreasuryError::AlreadyExecuted)));
}

#[test]
fn test_governance_single_member_threshold() {
    let env = Env::default();
    let (_admin, alice, _bob, token, token_id, _contract_id, client) = governance_setup(&env, 1);
    let recipient = Address::generate(&env);

    let id = client.propose_withdraw(&alice, &token_id, &recipient, &300);
    client.approve_withdraw(&alice, &id);
    client.execute_withdraw(&alice, &id);
    assert_eq!(token.balance(&recipient), 300);
}

#[test]
fn test_governance_rejects_non_member() {
    let env = Env::default();
    let (admin, _alice, _bob, _token, token_id, _contract_id, client) = governance_setup(&env, 1);
    let outsider = Address::generate(&env);
    let recipient = Address::generate(&env);

    let result = client.try_propose_withdraw(&outsider, &token_id, &recipient, &100);
    assert_eq!(result, Err(Ok(TreasuryError::NotAMember)));

    // The admin is not automatically a member — approving as admin fails.
    let result = client.try_approve_withdraw(&admin, &1);
    assert_eq!(result, Err(Ok(TreasuryError::NotAMember)));
}

#[test]
fn test_governance_enforces_cap() {
    let env = Env::default();
    let (admin, alice, bob, _token, token_id, _contract_id, client) = governance_setup(&env, 2);
    client.set_max_withdrawal(&admin, &token_id, &200);
    let recipient = Address::generate(&env);

    let id = client.propose_withdraw(&alice, &token_id, &recipient, &201);
    client.approve_withdraw(&alice, &id);
    client.approve_withdraw(&bob, &id);
    let result = client.try_execute_withdraw(&bob, &id);
    assert_eq!(result, Err(Ok(TreasuryError::WithdrawalCapped)));
    assert!(!client.get_withdrawal(&id).unwrap().executed);
}

#[test]
fn test_governance_rejects_unlisted_token() {
    let env = Env::default();
    let (_admin, alice, bob, _token, _token_id, _contract_id, client) = governance_setup(&env, 2);
    // A second, never-allowlisted token.
    let admin = Address::generate(&env);
    let (_unlisted, unlisted_id) = create_token(&env, &admin);
    let recipient = Address::generate(&env);

    let id = client.propose_withdraw(&alice, &unlisted_id, &recipient, &10);
    client.approve_withdraw(&alice, &id);
    client.approve_withdraw(&bob, &id);
    let result = client.try_execute_withdraw(&bob, &id);
    assert_eq!(result, Err(Ok(TreasuryError::TokenNotAllowed)));
}

#[test]
fn test_governance_cannot_vote_twice() {
    let env = Env::default();
    let (_admin, alice, _bob, _token, token_id, _contract_id, client) = governance_setup(&env, 2);
    let recipient = Address::generate(&env);

    let id = client.propose_withdraw(&alice, &token_id, &recipient, &100);
    client.approve_withdraw(&alice, &id);
    let result = client.try_approve_withdraw(&alice, &id);
    assert_eq!(result, Err(Ok(TreasuryError::AlreadyVoted)));
}

#[test]
fn test_governance_invalid_threshold_rejected() {
    let env = Env::default();
    let (admin, _depositor, _token, _token_id, _contract_id, client) = setup(&env);
    let a = Address::generate(&env);
    let members = soroban_sdk::vec![&env, a];

    let result = client.try_set_governance(&admin, &members, &0);
    assert_eq!(result, Err(Ok(TreasuryError::InvalidGovernance)));
    let result = client.try_set_governance(&admin, &members, &5);
    assert_eq!(result, Err(Ok(TreasuryError::InvalidGovernance)));
}

// ─── storage layout, pagination and TTL maintenance ──────────────────────────

/// Proposals were members of one instance-storage Map, so approving one
/// rewrote all of them. Each is now its own persistent entry.
#[test]
fn test_withdrawal_proposals_are_per_key_persistent_entries() {
    let env = Env::default();
    let (_admin, alice, _bob, _token, token_id, contract_id, client) = governance_setup(&env, 1);
    let recipient = Address::generate(&env);
    let id = client.propose_withdraw(&alice, &token_id, &recipient, &100);

    env.as_contract(&contract_id, || {
        assert!(env.storage().persistent().has(&DataKey::Withdrawal(id)));
    });
}

#[test]
fn test_count_and_paginated_listing_of_proposals() {
    let env = Env::default();
    let (_admin, alice, _bob, _token, token_id, _contract_id, client) = governance_setup(&env, 1);
    let recipient = Address::generate(&env);

    assert_eq!(client.count_withdrawals(), 0);
    let first = client.propose_withdraw(&alice, &token_id, &recipient, &100);
    let second = client.propose_withdraw(&alice, &token_id, &recipient, &100);
    assert_eq!(client.count_withdrawals(), 2);

    let page = client.list_withdrawal_ids(&1, &1);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0), Some(first));

    let rest = client.list_withdrawal_ids(&2, &10);
    assert_eq!(rest.len(), 1);
    assert_eq!(rest.get(0), Some(second));
    assert_eq!(client.list_withdrawal_ids(&3, &10).len(), 0);
}

/// Reconfiguring governance previously reset the withdrawal counter and
/// discarded every outstanding proposal. With per-key entries those ids must
/// stay monotonic — reusing an id would overwrite a live proposal.
#[test]
fn test_governance_reconfiguration_does_not_reuse_proposal_ids() {
    let env = Env::default();
    let (admin, alice, bob, _token, token_id, _contract_id, client) = governance_setup(&env, 2);
    let recipient = Address::generate(&env);

    let first = client.propose_withdraw(&alice, &token_id, &recipient, &100);
    assert_eq!(first, 1);

    // Change the membership; the outstanding proposal must survive.
    let members = soroban_sdk::vec![&env, alice.clone(), bob.clone()];
    client.set_governance(&admin, &members, &2);

    let second = client.propose_withdraw(&alice, &token_id, &recipient, &100);
    assert_eq!(second, 2, "ids must keep advancing across a governance change");

    let original = client.get_withdrawal(&first).unwrap();
    assert_eq!(original.amount, 100);
    assert!(!original.executed);
}

#[test]
fn test_bump_helpers_cover_proposals_and_token_config() {
    let env = Env::default();
    let (_admin, alice, _bob, _token, token_id, _contract_id, client) = governance_setup(&env, 1);
    let recipient = Address::generate(&env);
    let id = client.propose_withdraw(&alice, &token_id, &recipient, &100);

    // Permissionless: none of these call require_auth.
    client.bump_instance_ttl();
    client.bump_withdrawal_ttl(&id);
    client.bump_token_ttl(&token_id);

    assert_eq!(client.get_withdrawal(&id).unwrap().amount, 100);
    assert!(client.allowlisted(&token_id));
}

#[test]
fn test_bump_helpers_reject_unknown_targets() {
    let env = Env::default();
    let (_admin, _depositor, _token, token_id, _contract_id, client) = setup(&env);
    let admin = Address::generate(&env);
    let (_unlisted, unlisted_id) = create_token(&env, &admin);

    let result = client.try_bump_withdrawal_ttl(&999);
    assert_eq!(result, Err(Ok(TreasuryError::WithdrawalNotFound)));

    let result = client.try_bump_token_ttl(&unlisted_id);
    assert_eq!(result, Err(Ok(TreasuryError::TokenNotAllowed)));

    // The configured token is accepted.
    client.bump_token_ttl(&token_id);
}
