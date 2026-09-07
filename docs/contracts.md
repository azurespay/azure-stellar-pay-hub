---
title: Smart Contracts
description: The eight Soroban contracts, their interfaces, events, and deployment.
---

# Smart Contracts

All contracts live in `contracts/` and are written in Rust with
[Soroban](https://soroban.stellar.org). They are workspace members of `contracts/Cargo.toml`
(target: `wasm32v1-none`).

## Contracts

| Contract        | Purpose                                                         |
| --------------- | --------------------------------------------------------------- |
| `payment`       | Direct XLM/asset transfers with memo and receipt events         |
| `escrow`        | Conditional escrow with depositor/beneficiary/arbiter           |
| `multisig`      | Threshold-signature transactions and treasury control           |
| `treasury`      | Custody of funds with member spending limits and voting         |
| `subscriptions` | Recurring billing with plan management and cancellation         |
| `invoices`      | On-chain invoice registry with paid/expired states              |
| `merchant`      | Merchant registry + settlement distribution to multiple wallets |
| `rewards`       | Loyalty points: earn/redeem with tiers                          |

## Common conventions

- **Events** — every state change emits a typed event (e.g. `PaymentReceived`,
  `EscrowReleased`, `ProposalExecuted`).
- **Errors** — each contract defines an `Error` enum with descriptive variants
  (`Unauthorized`, `InsufficientBalance`, `AlreadyExists`, …).
- **Storage** — `DataKey` enums + `Persistent` storage; accessor patterns are public.
- **Upgrades** — contracts read configuration via `upgrade` entry points and use
  `env.current_contract_address()` for authorization, making deployments auditable.

## Build

```bash
# requires: rust toolchain + soroban-cli (stable) + wasm32 target
pnpm contracts:build
pnpm contracts:test
```

Artifacts: `contracts/target/wasm32v1-none/release/*.wasm`

## Deploy (testnet)

```bash
soroban contract deploy \
  --wasm contracts/target/wasm32v1-none/release/stellar_pay_payment.wasm \
  --source ADMIN \
  --network testnet
```

Then instantiate with the admin address: `soroban contract invoke --id <ID> -- initialize --admin G…`

## Platform wiring (payment contract — experimental)

The API can route authenticated `SEND` payments through the `payment`
contract's `send(from, to, token, amount, memo)` entry point instead of a
classic Stellar `Operation.payment`. Status as of 2026-09:

- **Opt-in and off by default.** Set `PAYMENT_ROUTE=contract` and provide the
  deployed contract address via `CONTRACT_STELLAR_PAY_PAYMENT` (see
  `.deployed-contracts.env`). Only assets in `PAYMENT_CONTRACT_ASSETS` (default
  `XLM`) are routed; everything else falls back to the classic path.
- **On-chain allowlist is required.** `send` reverts with `TokenNotAllowed`
  unless the token's SAC address was allowlisted by the admin
  (`set_allowed`). The SAC address for an asset can be resolved with the SDK's
  `sorobanTokenAddress()` (XLM native → `Asset.native().contractId(network)`).
  This must be done on-chain with the deployer key before the route is enabled.
- **No on-chain confirmation yet.** A contract-route payment is stored as
  `SUBMITTED` after a successful Horizon submission — payer-facing success
  events fire only after the (planned) event indexer observes the contract's
  `payment` event and moves the row to `CONFIRMED`. Do **not** mark contract
  payments `SUCCEEDED` from submission alone.
- **Correlation.** The `memo` argument passed to `send` is `sp:<correlationId>`
  (stored in the transaction `meta`), so a future indexer can map the emitted
  `payment` event back to the database row without trusting the client.

## Security considerations

- Multi-sig proposals require `threshold` of `N` signers before execution.
- Escrow funds are only released by explicit `release`/`refund` calls with proper auth.
- All token operations go through the SAC `token` interface (`transfer`, `balance_of`)
  to support XLM and any Stellar asset.
