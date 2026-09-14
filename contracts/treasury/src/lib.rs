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

// ─── TTL budget ──────────────────────────────────────────────────────────────
// Ledgers close roughly every 5 seconds, so 17_280 ledgers ≈ 1 day and
// 518_400 ledgers ≈ 30 days. Withdrawal proposals and the per-token allowlist
// and caps are now their own persistent entries; previously every proposal was
// a member of a single instance-storage Map, so approving one proposal rewrote
// all of them. Governance membership and the threshold stay in the instance
// entry because they are small and bounded by design.
const INSTANCE_TTL_THRESHOLD: u32 = 17_280;
const INSTANCE_TTL_EXTEND_TO: u32 = 518_400;
const WITHDRAWAL_TTL_THRESHOLD: u32 = 17_280;
const WITHDRAWAL_TTL_EXTEND_TO: u32 = 518_400;
const TOKEN_TTL_THRESHOLD: u32 = 17_280;
const TOKEN_TTL_EXTEND_TO: u32 = 518_400;

/// Largest page a listing entry point will return in one call.
const MAX_PAGE_SIZE: u32 = 100;

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Admin,
    /// Per-token allowlist flag, in its own persistent entry.
    Allowed(Address),
    /// Per-token withdrawal cap, in its own persistent entry.
    MaxWithdrawal(Address),
    DailyCap(Address),
    Members,
    Threshold,
    NextWithdrawal,
    /// One persistent entry per withdrawal proposal.
    Withdrawal(u64),
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
        Self::bump_instance(&env);
        Ok(())
    }

    pub fn set_allowed(env: Env, admin: Address, token: Address, allowed: bool) -> Result<(), TreasuryError> {
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&DataKey::Allowed(token.clone()), &allowed);
        Self::bump_token(&env, &token);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("allow"),), TokenAllowanceEvent { token, allowed, by: admin });
        Ok(())
    }

    pub fn set_max_withdrawal(env: Env, admin: Address, token: Address, cap: i128) -> Result<(), TreasuryError> {
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&DataKey::MaxWithdrawal(token.clone()), &cap);
        Self::bump_token(&env, &token);
        Self::bump_instance(&env);
        env.events().publish((symbol_short!("caps"),), CapsChangedEvent { by: admin });
        Ok(())
    }

    pub fn allowlisted(env: Env, token: Address) -> bool {
        let allowed = env.storage().persistent().get(&DataKey::Allowed(token.clone())).unwrap_or(false);
        if env.storage().persistent().has(&DataKey::Allowed(token.clone())) {
            Self::bump_token(&env, &token);
        }
        allowed
    }

    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) -> Result<(), TreasuryError> {
        if amount <= 0 { return Err(TreasuryError::InvalidAmount); }
        if !Self::allowlisted(env.clone(), token.clone()) { return Err(TreasuryError::TokenNotAllowed); }
        from.require_auth();
        token::Client::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        Self::bump_instance(&env);
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
        Self::bump_instance(&env);
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
    ///
    /// Reconfiguring governance no longer resets the withdrawal counter or
    /// discards outstanding proposals: proposals are now independent ledger
    /// entries, so the ids must stay monotonic (reusing an id would silently
    /// overwrite a proposal). The counter is only seeded on first use.
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
        if !env.storage().instance().has(&DataKey::NextWithdrawal) {
            env.storage().instance().set(&DataKey::NextWithdrawal, &1u64);
        }
        Self::bump_instance(&env);
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
        let next: u64 = env.storage().instance().get(&DataKey::NextWithdrawal).unwrap_or(1);
        let proposal = WithdrawalProposal {
            id: next, token: token.clone(), to: to.clone(), amount,
            approvals: Map::new(&env), executed: false,
        };
        env.storage().persistent().set(&DataKey::Withdrawal(next), &proposal);
        Self::bump_withdrawal(&env, next);
        env.storage().instance().set(&DataKey::NextWithdrawal, &(next + 1));
        Self::bump_instance(&env);
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
        let mut proposal = Self::load_withdrawal(&env, id)?;
        if proposal.executed { return Err(TreasuryError::AlreadyExecuted); }
        if proposal.approvals.contains_key(member.clone()) { return Err(TreasuryError::AlreadyVoted); }
        proposal.approvals.set(member.clone(), true);
        Self::store_withdrawal(&env, id, &proposal);
        env.events().publish((symbol_short!("wappr"),), WithdrawalApprovedEvent { id, member });
        Ok(())
    }

    /// Execute a withdrawal proposal once it has `threshold` approvals. Runs
    /// the same allowlist/cap/balance checks as the admin `withdraw` path and
    /// performs the transfer; only the first executor wins.
    pub fn execute_withdraw(env: Env, member: Address, id: u64) -> Result<(), TreasuryError> {
        Self::require_member(&env, &member)?;
        member.require_auth();
        let mut proposal = Self::load_withdrawal(&env, id)?;
        if proposal.executed { return Err(TreasuryError::AlreadyExecuted); }
        let approvals = Self::approval_count(&proposal);
        if approvals < Self::threshold(env.clone()) { return Err(TreasuryError::QuorumNotReached); }

        Self::check_withdrawal(&env, &proposal.token, proposal.amount)?;
        token::Client::new(&env, &proposal.token).transfer(
            &env.current_contract_address(), &proposal.to, &proposal.amount,
        );
        proposal.executed = true;
        Self::store_withdrawal(&env, id, &proposal);
        env.events().publish(
            (symbol_short!("wexec"),),
            WithdrawalExecutedEvent { id, token: proposal.token, to: proposal.to, amount: proposal.amount },
        );
        Ok(())
    }

    /// Read one proposal, restoring/extending its TTL.
    pub fn get_withdrawal(env: Env, id: u64) -> Option<WithdrawalProposal> {
        let proposal = env.storage().persistent().get(&DataKey::Withdrawal(id));
        if proposal.is_some() { Self::bump_withdrawal(&env, id); }
        proposal
    }

    /// Highest withdrawal id assigned so far (0 when none exist yet).
    pub fn count_withdrawals(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::NextWithdrawal).unwrap_or(1) - 1
    }

    /// Paginated listing of live withdrawal-proposal ids at or after `start`.
    pub fn list_withdrawal_ids(env: Env, start: u64, limit: u32) -> Vec<u64> {
        let next: u64 = env.storage().instance().get(&DataKey::NextWithdrawal).unwrap_or(1);
        let page = if limit > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { limit };
        let mut ids = Vec::new(&env);
        let mut id = if start < 1 { 1 } else { start };
        while id < next && ids.len() < page {
            if env.storage().persistent().has(&DataKey::Withdrawal(id)) { ids.push_back(id); }
            id += 1;
        }
        ids
    }

    // ─── Permissionless TTL maintenance ──────────────────────────────────────

    /// Extend the contract's instance entry (admin + governance). Anyone may
    /// call this and pay the rent.
    pub fn bump_instance_ttl(env: Env) {
        Self::bump_instance(&env);
    }

    /// Extend one proposal's TTL, restoring it if it was archived.
    pub fn bump_withdrawal_ttl(env: Env, id: u64) -> Result<(), TreasuryError> {
        if !env.storage().persistent().has(&DataKey::Withdrawal(id)) {
            return Err(TreasuryError::WithdrawalNotFound);
        }
        Self::bump_withdrawal(&env, id);
        Ok(())
    }

    /// Extend one token's allowlist/cap entries, restoring them if archived.
    pub fn bump_token_ttl(env: Env, token: Address) -> Result<(), TreasuryError> {
        let key = DataKey::Allowed(token.clone());
        if !env.storage().persistent().has(&key) {
            return Err(TreasuryError::TokenNotAllowed);
        }
        Self::bump_token(&env, &token);
        Ok(())
    }

    // ─── internal ────────────────────────────────────────────────────────────

    fn load_withdrawal(env: &Env, id: u64) -> Result<WithdrawalProposal, TreasuryError> {
        let proposal = env.storage().persistent().get(&DataKey::Withdrawal(id)).ok_or(TreasuryError::WithdrawalNotFound)?;
        Self::bump_withdrawal(env, id);
        Ok(proposal)
    }

    fn store_withdrawal(env: &Env, id: u64, proposal: &WithdrawalProposal) {
        env.storage().persistent().set(&DataKey::Withdrawal(id), proposal);
        Self::bump_withdrawal(env, id);
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
        let cap: i128 = env.storage().persistent().get(&DataKey::MaxWithdrawal(token.clone())).unwrap_or(i128::MAX);
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

    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    fn bump_withdrawal(env: &Env, id: u64) {
        env.storage().persistent().extend_ttl(&DataKey::Withdrawal(id), WITHDRAWAL_TTL_THRESHOLD, WITHDRAWAL_TTL_EXTEND_TO);
    }

    /// Extend whichever of a token's two optional entries actually exists.
    /// A cap is only written when an admin sets one, so it must not be extended
    /// unconditionally (`extend_ttl` requires the entry to be present).
    fn bump_token(env: &Env, token: &Address) {
        let allowed = DataKey::Allowed(token.clone());
        if env.storage().persistent().has(&allowed) {
            env.storage().persistent().extend_ttl(&allowed, TOKEN_TTL_THRESHOLD, TOKEN_TTL_EXTEND_TO);
        }
        let cap = DataKey::MaxWithdrawal(token.clone());
        if env.storage().persistent().has(&cap) {
            env.storage().persistent().extend_ttl(&cap, TOKEN_TTL_THRESHOLD, TOKEN_TTL_EXTEND_TO);
        }
    }
}

#[cfg(test)]
mod test;
