#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Map, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    Unauthorized = 1, InvalidAmount = 2, EscrowNotFound = 3, TooEarly = 4,
    Expired = 5, NotExpired = 6, AlreadyReleased = 7, AlreadyRefunded = 8, NotInitialized = 9,
    AlreadyInitialized = 10,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey { Admin, NextId, Escrows }

#[contracttype]
#[derive(Clone, Debug)]
pub struct Escrow {
    pub id: u64, pub initiator: Address, pub counterparty: Address,
    pub arbiter: Option<Address>,
    pub token: Address, pub amount: i128, pub release_time: u64,
    pub expiry: u64, pub released: bool, pub refunded: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowCreated { pub id: u64, pub initiator: Address, pub counterparty: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowReleased { pub id: u64, pub to: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowRefunded { pub id: u64, pub to: Address, pub amount: i128 }

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) { return Err(EscrowError::AlreadyInitialized); }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().set(&DataKey::Escrows, &Map::<u64, Escrow>::new(&env));
        env.storage().instance().extend_ttl(5000, 5000);
        Ok(())
    }

    pub fn create(env: Env, initiator: Address, counterparty: Address, arbiter: Option<Address>, token: Address, amount: i128, release_time: u64, expiry: Option<u64>) -> Result<u64, EscrowError> {
        if amount <= 0 { return Err(EscrowError::InvalidAmount); }
        if expiry.map_or(false, |e| e <= release_time) { return Err(EscrowError::InvalidAmount); }
        initiator.require_auth();
        let mut escrows: Map<u64, Escrow> = env.storage().instance().get(&DataKey::Escrows).unwrap_or_else(|| Map::new(&env));
        let mut next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        token::Client::new(&env, &token).transfer(&initiator, &env.current_contract_address(), &amount);
        let escrow = Escrow { id: next_id, initiator: initiator.clone(), counterparty: counterparty.clone(), arbiter: arbiter.clone(), token: token.clone(), amount, release_time, expiry: expiry.unwrap_or(u64::MAX), released: false, refunded: false };
        escrows.set(next_id, escrow.clone()); next_id += 1;
        env.storage().instance().set(&DataKey::Escrows, &escrows);
        env.storage().instance().set(&DataKey::NextId, &next_id);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("created"),), EscrowCreated { id: escrow.id, initiator, counterparty, amount });
        Ok(escrow.id)
    }

    pub fn release(env: Env, id: u64, caller: Address) -> Result<(), EscrowError> {
        let mut escrows: Map<u64, Escrow> = env.storage().instance().get(&DataKey::Escrows).unwrap_or_else(|| Map::new(&env));
        let mut escrow = escrows.get(id).ok_or(EscrowError::EscrowNotFound)?;
        if escrow.released { return Err(EscrowError::AlreadyReleased); }
        if escrow.refunded { return Err(EscrowError::AlreadyRefunded); }
        // The initiator, counterparty, or an appointed arbiter may release.
        let is_arbiter = escrow.arbiter.as_ref().map_or(false, |a| a == &caller);
        if caller != escrow.counterparty && caller != escrow.initiator && !is_arbiter {
            return Err(EscrowError::Unauthorized);
        }
        caller.require_auth();
        if env.ledger().timestamp() < escrow.release_time { return Err(EscrowError::TooEarly); }
        let to = escrow.counterparty.clone();
        token::Client::new(&env, &escrow.token).transfer(&env.current_contract_address(), &to, &escrow.amount);
        escrow.released = true; escrows.set(id, escrow.clone());
        env.storage().instance().set(&DataKey::Escrows, &escrows);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("released"),), EscrowReleased { id, to: to.clone(), amount: escrow.amount });
        Ok(())
    }

    pub fn refund(env: Env, id: u64, caller: Address) -> Result<(), EscrowError> {
        let mut escrows: Map<u64, Escrow> = env.storage().instance().get(&DataKey::Escrows).unwrap_or_else(|| Map::new(&env));
        let mut escrow = escrows.get(id).ok_or(EscrowError::EscrowNotFound)?;
        if escrow.released { return Err(EscrowError::AlreadyReleased); }
        if escrow.refunded { return Err(EscrowError::AlreadyRefunded); }
        // Either the initiator or the counterparty may initiate a refund after expiry.
        if caller != escrow.initiator && caller != escrow.counterparty { return Err(EscrowError::Unauthorized); }
        caller.require_auth();
        let now = env.ledger().timestamp();
        if now >= escrow.release_time && now <= escrow.expiry { return Err(EscrowError::NotExpired); }
        let to = escrow.initiator.clone();
        token::Client::new(&env, &escrow.token).transfer(&env.current_contract_address(), &to, &escrow.amount);
        escrow.refunded = true; escrows.set(id, escrow.clone());
        env.storage().instance().set(&DataKey::Escrows, &escrows);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("refund"),), EscrowRefunded { id, to: to.clone(), amount: escrow.amount });
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Option<Escrow> {
        env.storage().instance().get::<_, Map<u64, Escrow>>(&DataKey::Escrows).and_then(|e| e.get(id))
    }

    pub fn all_ids(env: Env) -> Vec<u64> {
        env.storage().instance().get::<_, Map<u64, Escrow>>(&DataKey::Escrows).map(|e| e.keys()).unwrap_or_else(|| Vec::new(&env))
    }
}

#[cfg(test)]
mod test;
