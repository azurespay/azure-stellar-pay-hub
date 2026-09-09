#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Map, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    Unauthorized = 1, InvalidAmount = 2, TokenNotAllowed = 3, NotInitialized = 4, WithdrawalCapped = 5,
    AlreadyInitialized = 6,
    NotAMember = 7, InvalidGovernance = 8, WithdrawalNotFound = 9,
    AlreadyVoted = 10, AlreadyExecuted = 11, QuorumNotReached = 12,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Admin, Allowed(Address), MaxWithdrawal(Address), DailyCap(Address),
    Members, Threshold, NextWithdrawal, Withdrawals,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct WithdrawalProposal {
    pub id: u64, pub token: Address, pub to: Address, pub amount: i128,
    pub approvals: Map<Address, bool>, pub executed: bool,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DepositedEvent { pub token: Address, pub from: Address, pub amount: i128 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct WithdrawnEvent { pub token: Address, pub to: Address, pub amount: i128, pub by: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct TokenAllowanceEvent { pub token: Address, pub allowed: bool, pub by: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct CapsChangedEvent { pub by: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct GovernanceChangedEvent { pub by: Address, pub members: Vec<Address>, pub threshold: u32 }
#[contracttype]
#[derive(Clone, Debug)]
pub struct WithdrawalProposedEvent { pub id: u64, pub token: Address, pub to: Address, pub amount: i128, pub by: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct WithdrawalApprovedEvent { pub id: u64, pub member: Address }
#[contracttype]
#[derive(Clone, Debug)]
pub struct WithdrawalExecutedEvent { pub id: u64, pub token: Address, pub to: Address, pub amount: i128 }

#[contract]
pub struct TreasuryContract;

#[contractimpl]
impl TreasuryContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), TreasuryError> {
        if env.storage().instance().has(&DataKey::Admin) { return Err(TreasuryError::AlreadyInitialized); }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().extend_ttl(5000, 5000);
        Ok(())
    }

    pub fn set_allowed(env: Env, admin: Address, token: Address, allowed: bool) -> Result<(), TreasuryError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Allowed(token.clone()), &allowed);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("allow"),), TokenAllowanceEvent { token, allowed, by: admin });
        Ok(())
    }

    pub fn set_max_withdrawal(env: Env, admin: Address, token: Address, cap: i128) -> Result<(), TreasuryError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::MaxWithdrawal(token), &cap);
        env.events().publish((symbol_short!("caps"),), CapsChangedEvent { by: admin });
        Ok(())
    }

    pub fn allowlisted(env: Env, token: Address) -> bool {
        env.storage().instance().get(&DataKey::Allowed(token)).unwrap_or(false)
    }

    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) -> Result<(), TreasuryError> {
        if amount <= 0 { return Err(TreasuryError::InvalidAmount); }
        if !Self::allowlisted(env.clone(), token.clone()) { return Err(TreasuryError::TokenNotAllowed); }
        from.require_auth();
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("deposit"),), DepositedEvent { token, from, amount });
        Ok(())
    }

    /// Legacy admin-only withdrawal path. When governance is enabled, the
    /// propose → approve → execute flow is the intended (multi-member) path.
    pub fn withdraw(env: Env, admin: Address, token: Address, to: Address, amount: i128) -> Result<(), TreasuryError> {
        if amount <= 0 { return Err(TreasuryError::InvalidAmount); }
        Self::require_admin(&env, &admin)?;
        Self::check_withdrawal(&env, &token, amount)?;
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("withdraw"),), WithdrawnEvent { token, to, amount, by: admin });
        Ok(())
    }

    pub fn balance(env: Env, token: Address) -> i128 {
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    // ------------------------------------------------------------ Governance

    /// Configure multi-member governance for withdrawals. `members` empty
    /// disables governance (admin-only mode, the default). When enabled,
    /// `threshold` (1..=members.len()) member approvals are required before a
    /// proposed withdrawal executes.
    pub fn set_governance(
        env: Env,
        admin: Address,
        members: Vec<Address>,
        threshold: u32,
    ) -> Result<(), TreasuryError> {
        Self::require_admin(&env, &admin)?;
        if !members.is_empty() && (threshold == 0 || threshold > members.len() as u32) {
            return Err(TreasuryError::InvalidGovernance);
        }
        env.storage().instance().set(&DataKey::Members, &members);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::NextWithdrawal, &1u64);
        env.storage().instance().set(&DataKey::Withdrawals, &Map::<u64, WithdrawalProposal>::new(&env));
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish((symbol_short!("gov"),), GovernanceChangedEvent { by: admin, members, threshold });
        Ok(())
    }

    pub fn members(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Members).unwrap_or_else(|| Vec::new(&env))
    }

    pub fn threshold(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Threshold).unwrap_or(0)
    }

    pub fn governance_enabled(env: Env) -> bool {
        !Self::members(env).is_empty()
    }

    /// Propose a withdrawal. Requires the admin when governance is disabled,
    /// or a governance member when it is enabled.
    pub fn propose_withdraw(
        env: Env,
        proposer: Address,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<u64, TreasuryError> {
        if amount <= 0 { return Err(TreasuryError::InvalidAmount); }
        if Self::governance_enabled(env.clone()) {
            Self::require_member(&env, &proposer)?;
        } else {
            Self::require_admin(&env, &proposer)?;
        }
        let mut next: u64 = env.storage().instance().get(&DataKey::NextWithdrawal).unwrap_or(1);
        let mut withdrawals: Map<u64, WithdrawalProposal> = env
            .storage().instance().get(&DataKey::Withdrawals)
            .unwrap_or_else(|| Map::new(&env));
        let proposal = WithdrawalProposal {
            id: next, token: token.clone(), to: to.clone(), amount,
            approvals: Map::new(&env), executed: false,
        };
        withdrawals.set(next, proposal.clone()); next += 1;
        env.storage().instance().set(&DataKey::NextWithdrawal, &next);
        env.storage().instance().set(&DataKey::Withdrawals, &withdrawals);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish(
            (symbol_short!("wprop"),),
            WithdrawalProposedEvent { id: proposal.id, token, to, amount, by: proposer },
        );
        Ok(proposal.id)
    }

    /// Approve a pending withdrawal proposal (governance members only).
    pub fn approve_withdraw(env: Env, member: Address, id: u64) -> Result<(), TreasuryError> {
        Self::require_member(&env, &member)?;
        member.require_auth();
        let mut withdrawals: Map<u64, WithdrawalProposal> = env
            .storage().instance().get(&DataKey::Withdrawals)
            .unwrap_or_else(|| Map::new(&env));
        let mut proposal = withdrawals.get(id).ok_or(TreasuryError::WithdrawalNotFound)?;
        if proposal.executed { return Err(TreasuryError::AlreadyExecuted); }
        if proposal.approvals.contains_key(member.clone()) { return Err(TreasuryError::AlreadyVoted); }
        proposal.approvals.set(member.clone(), true);
        withdrawals.set(id, proposal);
        env.storage().instance().set(&DataKey::Withdrawals, &withdrawals);
        env.events().publish((symbol_short!("wappr"),), WithdrawalApprovedEvent { id, member });
        Ok(())
    }

    /// Execute a withdrawal proposal once it has `threshold` approvals. Runs
    /// the same allowlist/cap/balance checks as the admin `withdraw` path and
    /// performs the transfer; only the first executor wins.
    pub fn execute_withdraw(env: Env, member: Address, id: u64) -> Result<(), TreasuryError> {
        Self::require_member(&env, &member)?;
        member.require_auth();
        let mut withdrawals: Map<u64, WithdrawalProposal> = env
            .storage().instance().get(&DataKey::Withdrawals)
            .unwrap_or_else(|| Map::new(&env));
        let mut proposal = withdrawals.get(id).ok_or(TreasuryError::WithdrawalNotFound)?;
        if proposal.executed { return Err(TreasuryError::AlreadyExecuted); }
        let approvals = Self::approval_count(&proposal);
        if approvals < Self::threshold(env.clone()) { return Err(TreasuryError::QuorumNotReached); }

        Self::check_withdrawal(&env, &proposal.token, proposal.amount)?;
        token::Client::new(&env, &proposal.token).transfer(
            &env.current_contract_address(), &proposal.to, &proposal.amount,
        );
        proposal.executed = true;
        withdrawals.set(id, proposal.clone());
        env.storage().instance().set(&DataKey::Withdrawals, &withdrawals);
        env.storage().instance().extend_ttl(5000, 5000);
        env.events().publish(
            (symbol_short!("wexec"),),
            WithdrawalExecutedEvent { id, token: proposal.token, to: proposal.to, amount: proposal.amount },
        );
        Ok(())
    }

    pub fn get_withdrawal(env: Env, id: u64) -> Option<WithdrawalProposal> {
        env.storage().instance().get::<_, Map<u64, WithdrawalProposal>>(&DataKey::Withdrawals)
            .and_then(|w| w.get(id))
    }

    fn approval_count(proposal: &WithdrawalProposal) -> u32 {
        let mut count: u32 = 0;
        for v in proposal.approvals.values() { if v { count += 1; } }
        count
    }

    fn require_member(env: &Env, caller: &Address) -> Result<(), TreasuryError> {
        let members: Vec<Address> = env.storage().instance().get(&DataKey::Members)
            .ok_or(TreasuryError::NotInitialized)?;
        if !members.contains(caller) { return Err(TreasuryError::NotAMember); }
        Ok(())
    }

    /// Shared allowlist + cap + balance validation for both withdrawal paths.
    fn check_withdrawal(env: &Env, token: &Address, amount: i128) -> Result<(), TreasuryError> {
        if !Self::allowlisted(env.clone(), token.clone()) { return Err(TreasuryError::TokenNotAllowed); }
        let cap: i128 = env.storage().instance().get(&DataKey::MaxWithdrawal(token.clone())).unwrap_or(i128::MAX);
        if amount > cap { return Err(TreasuryError::WithdrawalCapped); }
        let current = token::Client::new(env, token).balance(&env.current_contract_address());
        if current < amount { return Err(TreasuryError::InvalidAmount); }
        Ok(())
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), TreasuryError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin).ok_or(TreasuryError::NotInitialized)?;
        stored.require_auth();
        if admin != &stored { return Err(TreasuryError::Unauthorized); }
        Ok(())
    }
}

#[cfg(test)]
mod test;
