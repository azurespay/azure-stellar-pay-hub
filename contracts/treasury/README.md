# Treasury Contract

Vault holding platform funds (fees, settlements, reserves):

- allowlisted tokens only
- `deposit` – anyone (typically a payment/settlement contract)
- `withdraw` – admin only, per-token per-transaction cap
- `set_allowed` / `set_max_withdrawal` – admin configuration

## Events

- `Deposited { token, from, amount }`
- `Withdrawn { token, to, amount, by }`
- `TokenAllowanceChanged`, `CapsChanged`

## Security considerations

- Funds can only leave via admin withdrawal, capped per transaction.
- Production hardening: require multi-party approval for withdrawals (for
  example a separate approval contract, or an off-chain quorum that co-signs),
  add a timelock, and add a daily aggregate cap (the `DailyCap` key is
  reserved for that).
- `require_auth` on every privileged call.

## Upgrade strategy

The treasury holds funds, so upgrades must be carefully staged: pause
deposits, drain to the new vault, update the backend registry. See
`contracts/README.md`.
