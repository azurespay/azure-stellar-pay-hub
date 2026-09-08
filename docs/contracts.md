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

## Contract status matrix

Having a contract in this repo does **not** mean the platform invokes it.
Distinguish _implemented_ (code + `test.rs`), _deployed_ (address on testnet),
and _used by the platform_ (the API actually calls it):

| Contract        | Implemented | Unit tested (Rust) | Deployed (testnet) |           Platform uses it            |
| --------------- | :---------: | :----------------: | :----------------: | :-----------------------------------: |
| `payment`       |     ✅      |  ✅ (host tests)   |         ✅         | ⚠️ experimental route, off by default |
| `escrow`        |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |
| `multisig`      |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |
| `treasury`      |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |
| `subscriptions` |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |
| `invoices`      |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |
| `merchant`      |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |
| `rewards`       |     ✅      |  ✅ (host tests)   |         ✅         |          ❌ not invoked yet           |

All eight testnet addresses are recorded in `.deployed-contracts.env`; they were
deployed on 2026-08-10 and **verified live on-chain** via Soroban RPC
`getLedgerEntries` on 2026-09-07 (see `docs/testnet-deploy.md` → Deployed
contracts). Only the `payment` contract is reachable from the API, and only via
the experimental route described below.

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
- **No live execution yet — verified blocker at this commit.** A full
  contract-route payment has **not** completed on testnet. An attempt on
  2026-09-08 (tier-5 E2E, `E2E_CONTRACT=1`) failed at submission: the API
  returned 500 because `StellarNetwork.submitSignedTransaction` posts the
  envelope to **Horizon's classic endpoint, which rejects Soroban
  transactions** (Horizon HTTP 400). Two gaps must close before this route can
  work end-to-end:
  1. **Simulation-assembled XDR.** The SDK's `buildSorobanSendTransaction`
     builds a raw `invokeHostFunction` with `auth: []` and no `sorobanData`
     (footprint / resource preconditions). The contract's `send` calls
     `from.require_auth()` and performs a SAC `transfer`, so a valid
     transaction must be produced via a simulate → assemble (soroban-auth)
     round-trip against Soroban RPC before signing — classic `Operation.payment`
     XDR construction is not sufficient.
  2. **Soroban RPC submission.** Submitting the assembled envelope must go
     through Soroban RPC `sendTransaction` (then the indexer's
     `getTransaction` poll below confirms it), not Horizon.
- **On-chain confirmation via the event indexer (once submission exists).**
  A successful RPC submission would be stored as `SUBMITTED` — never
  `SUCCEEDED`/`CONFIRMED` from submission alone. The API scheduler runs
  `apps/api/src/indexer` every ~20s: it polls Soroban RPC `getTransaction` for
  every `SUBMITTED` contract send and moves the row to `CONFIRMED` only when
  the ledger reports `SUCCESS` (the `send` invocation executed; it reverts
  otherwise). Payer realtime/notification events fire on that transition, and
  the atomic `SUBMITTED → CONFIRMED` update makes confirmation idempotent (a
  duplicate observation can only win once). It also ingests contract `payment`
  events (`getEvents`, cursor persisted in Redis) as best-effort groundwork
  for inbound detection.
- **Correlation.** The `memo` argument passed to `send` is `sp:<correlationId>`
  (stored in the transaction `meta`); the indexer maps the emitted `payment`
  event back to the database row via that memo without trusting the client.
- **Status consumers treat `CONFIRMED` as success.** Transactions/analytics
  stats and the explorer/admin/web UIs count `CONFIRMED` alongside
  `SUCCEEDED` (transaction `status` enum includes `CONFIRMED`).
- **Inbound event ingestion (merchant-address payments).** Besides confirming
  platform sends, the indexer parses `payment` contract events whose recipient
  is an ACTIVE merchant and credits them as inbound payments even though they
  never went through the API. Payload parsing (`soroban-event.ts`) accepts
  both the vec and the map layout of `PaymentEventData` and validates
  recipient/token/amount before crediting; native XLM is supported today.
  Inbound credits share one idempotent path (see `InboundReconciliationService`
  in `docs/architecture.md`) with the classic-Horizon listener: a `ChainEvent`
  unique-event ledger prevents double processing, and a memo equal to an open
  invoice number (asset + amount match) marks the invoice PAID.
- **Blocked on one ops prerequisite.** End-to-end contract-route payment on
  testnet still requires the admin to `set_allowed` the XLM SAC on the deployed
  contract (deployer key); until then a `send` reverts with `TokenNotAllowed`.

## Security considerations

- Multi-sig proposals require `threshold` of `N` signers before execution.
- Escrow funds are only released by explicit `release`/`refund` calls with proper auth.
- All token operations go through the SAC `token` interface (`transfer`, `balance_of`)
  to support XLM and any Stellar asset.
