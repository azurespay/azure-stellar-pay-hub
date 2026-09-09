#![cfg(test)]

use super::{MultisigContract, MultisigContractClient, MultisigError, ProposalCall};
use soroban_sdk::testutils::Address as AddressUtils;
use soroban_sdk::{contract, contractimpl, contracttype, xdr::ToXdr, Address, Bytes, Env, String, Symbol, Vec, vec};

/// A minimal target contract used to prove that `execute` really performs the
/// stored cross-contract invocation (not just bookkeeping).
#[contracttype]
enum TargetKey { Counter }

#[contract]
pub struct TargetContract;

#[contractimpl]
impl TargetContract {
    pub fn bump(env: Env, x: u64) -> u64 {
        let cur: u64 = env.storage().instance().get(&TargetKey::Counter).unwrap_or(0);
        let next = cur + x;
        env.storage().instance().set(&TargetKey::Counter, &next);
        next
    }

    pub fn counter(env: Env) -> u64 {
        env.storage().instance().get(&TargetKey::Counter).unwrap_or(0)
    }

    pub fn fail(_env: Env) -> u64 {
        panic!("target call failed on purpose")
    }
}

// The #[contractimpl] macro generates TargetContractClient for the local target.
type TargetClient<'e> = TargetContractClient<'e>;

fn setup<'e>(env: &'e Env) -> (Vec<Address>, MultisigContractClient<'e>) {
    env.mock_all_auths();
    let alice = Address::generate(env);
    let bob = Address::generate(env);
    let carol = Address::generate(env);
    let signers = vec![env, alice, bob, carol];
    let contract_id = env.register_contract(None, MultisigContract);
    let client = MultisigContractClient::new(env, &contract_id);
    client.initialize(&signers, &2);
    (signers, client)
}

fn target_setup<'e>(env: &'e Env) -> (Vec<Address>, MultisigContractClient<'e>, TargetClient<'e>, Address) {
    let (signers, client) = setup(env);
    let target_id = env.register_contract(None, TargetContract);
    let target = TargetClient::new(env, &target_id);
    (signers, client, target, target_id)
}

fn call(env: &Env, target: &Address, function: &str, args: Vec<Bytes>) -> ProposalCall {
    ProposalCall {
        target: target.clone(),
        function: Symbol::new(env, function),
        args,
    }
}

fn no_args(env: &Env, target: &Address) -> ProposalCall {
    call(env, target, "nop", vec![env])
}

#[test]
fn test_initializes_with_threshold() {
    let env = Env::default();
    let (signers, client) = setup(&env);
    assert_eq!(client.threshold(), 2);
    assert_eq!(client.signers().len(), 3);
    assert_eq!(client.signers(), signers);
}

#[test]
fn test_submit_and_approve_to_quorum() {
    let env = Env::default();
    let (signers, client) = setup(&env);
    let alice = signers.get(0).unwrap();
    let bob = signers.get(1).unwrap();
    let target = Address::generate(&env);

    let id = client.submit(&alice, &String::from_str(&env, "withdraw"), &no_args(&env, &target));
    assert_eq!(id, 1);

    // Single approval is below the quorum.
    client.approve(&alice, &id);
    let result = client.try_execute(&alice, &id);
    assert_eq!(result, Err(Ok(MultisigError::QuorumNotReached)));

    // Second approval reaches quorum, but the target is not a registered
    // contract — execution must fail cleanly (not mark the proposal executed).
    client.approve(&bob, &id);
    let result = client.try_execute(&bob, &id);
    assert_eq!(result, Err(Ok(MultisigError::ExecutionFailed)));
    let proposal = client.get_proposal(&id).unwrap();
    assert!(!proposal.executed);
}

#[test]
fn test_execute_performs_cross_contract_call() {
    let env = Env::default();
    let (signers, client, target, target_id) = target_setup(&env);
    let alice = signers.get(0).unwrap();
    let bob = signers.get(1).unwrap();

    // The proposal invokes target.bump(7) once quorum is reached.
    let args = vec![&env, 7u64.to_xdr(&env)];
    let id = client.submit(&alice, &String::from_str(&env, "bump by 7"), &call(&env, &target_id, "bump", args));

    // Below quorum: nothing executed.
    client.approve(&alice, &id);
    assert_eq!(target.counter(), 0);

    // Quorum reached: execution really invokes the target contract.
    client.approve(&bob, &id);
    client.execute(&bob, &id);
    assert_eq!(target.counter(), 7);

    // Cannot execute twice.
    let result = client.try_execute(&bob, &id);
    assert_eq!(result, Err(Ok(MultisigError::AlreadyExecuted)));
}

#[test]
fn test_execute_keeps_proposal_unexecuted_when_target_call_fails() {
    let env = Env::default();
    let (signers, client, _target, target_id) = target_setup(&env);
    let alice = signers.get(0).unwrap();
    let bob = signers.get(1).unwrap();

    let id = client.submit(&alice, &String::from_str(&env, "failing call"), &no_args(&env, &target_id));
    client.approve(&alice, &id);
    client.approve(&bob, &id);

    // The target function panics — the proposal must not be marked executed.
    let result = client.try_execute(&bob, &id);
    assert_eq!(result, Err(Ok(MultisigError::ExecutionFailed)));
    let proposal = client.get_proposal(&id).unwrap();
    assert!(!proposal.executed);
}

#[test]
fn test_reject_prevents_quorum() {
    let env = Env::default();
    let (signers, client) = setup(&env);
    let alice = signers.get(0).unwrap();
    let bob = signers.get(1).unwrap();
    let target = Address::generate(&env);

    let id = client.submit(&alice, &String::from_str(&env, "withdraw"), &no_args(&env, &target));
    client.approve(&alice, &id);
    client.reject(&bob, &id);

    // Approvals: 1, rejects: 1 -> quorum (2 approvals) not reached.
    let result = client.try_execute(&alice, &id);
    assert_eq!(result, Err(Ok(MultisigError::QuorumNotReached)));
}

#[test]
fn test_cannot_vote_twice() {
    let env = Env::default();
    let (signers, client) = setup(&env);
    let alice = signers.get(0).unwrap();
    let target = Address::generate(&env);

    let id = client.submit(&alice, &String::from_str(&env, "x"), &no_args(&env, &target));
    client.approve(&alice, &id);
    let result = client.try_approve(&alice, &id);
    assert_eq!(result, Err(Ok(MultisigError::AlreadyVoted)));
}

#[test]
fn test_non_signer_cannot_submit() {
    let env = Env::default();
    let (_signers, client) = setup(&env);
    let outsider = Address::generate(&env);
    let target = Address::generate(&env);

    let result = client.try_submit(&outsider, &String::from_str(&env, "x"), &no_args(&env, &target));
    assert_eq!(result, Err(Ok(MultisigError::NotASigner)));
}

#[test]
fn test_invalid_threshold_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let a = Address::generate(&env);
    let signers = vec![&env, a];
    let contract_id = env.register_contract(None, MultisigContract);
    let client = MultisigContractClient::new(&env, &contract_id);

    // Threshold 0 and threshold above signer count are invalid.
    let result = client.try_initialize(&signers, &0);
    assert_eq!(result, Err(Ok(MultisigError::InvalidThreshold)));
    let result = client.try_initialize(&signers, &5);
    assert_eq!(result, Err(Ok(MultisigError::InvalidThreshold)));
}