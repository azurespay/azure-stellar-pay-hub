# Soroban Smart Contracts

Soroban (Rust) smart contracts powering the payment platform. Each contract is
self-contained with events, typed errors, unit tests and documentation.

| Contract        | Crates.io name              | Purpose                                     |
| --------------- | --------------------------- | ------------------------------------------- |
| `payment`       | `stellar-pay-payment`       | Send XLM/assets, batch & split payments     |
| `escrow`        | `stellar-pay-escrow`        | Timed escrow with release & refund          |
| `treasury`      | `stellar-pay-treasury`      | Allowlisted treasury (deposits/withdrawals) |
| `subscriptions` | `stellar-pay-subscriptions` | Recurring payment plans                     |
| `invoices`      | `stellar-pay-invoices`      | On-chain invoice issuance & payment         |
| `merchant`      | `stellar-pay-merchant`      | Merchant registry + commission & settlement |

## Requirements

- Rust stable (`rustup`)
- `wasm32v1-none` target: `rustup target add wasm32v1-none`
- [Soroban CLI](https://soroban.stellar.org/docs/cli) (optional, for `soroban contract build`)

## Build & test

```bash
# Compile all contracts to wasm (optimized release profile)
pnpm contracts:build
# or: cargo build --manifest-path contracts/Cargo.toml --workspace --release --target wasm32v1-none

# Run all unit tests (native host)
pnpm contracts:test
```

## Deploy

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/stellar_pay_payment.wasm \
  --source <admin-secret> --network testnet
```

Deployed addresses are recorded in `.deployed-contracts.env` (and mirrored into
`.env.testnet` by `scripts/deploy-testnet.sh`). The backend reads them as env
vars (e.g. `CONTRACT_STELLAR_PAY_PAYMENT`) and can route payments through the
contract behind the experimental `PAYMENT_ROUTE=contract` flag — see
`docs/contracts.md` → “Platform wiring” for the current status.

## Security

- All contracts use `require_auth` for privileged operations.
- Amounts are `i128` stroops - never floats.
- Errors are typed (`#[contracterror]`) and events are emitted for every state change.
- See each contract's README for the upgrade strategy and security considerations.
