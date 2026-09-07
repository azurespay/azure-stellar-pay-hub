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

## Security considerations

- Multi-sig proposals require `threshold` of `N` signers before execution.
- Escrow funds are only released by explicit `release`/`refund` calls with proper auth.
- All token operations go through the SAC `token` interface (`transfer`, `balance_of`)
  to support XLM and any Stellar asset.
