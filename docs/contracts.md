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
| `escrow`        | Conditional escrow with initiator/counterparty/arbiter          |
| `multisig`      | Threshold proposals that execute real cross-contract calls      |
| `treasury`      | Allowlisted vault with governance propose→approve→execute       |
| `subscriptions` | Recurring billing with plan management and cancellation         |
| `invoices`      | On-chain invoice registry with paid/expired states              |
| `merchant`      | Merchant registry + settlement distribution to multiple wallets |
| `rewards`       | Loyalty points: earn/redeem with tiers                          |

## Contract status matrix

Having a contract in this repo does **not** mean the platform invokes it.
Distinguish _implemented_ (code + `test.rs`), _deployed_ (address on testnet),
and _used by the platform_ (the API actually calls it):

| Contract        | Implemented | Unit tested (Rust) | Deployed (testnet) | Platform uses it                                                                                                              |
| --------------- | :---------: | :----------------: | :----------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| `payment`       |     ✅      |  ✅ (host tests)   |         ✅         | ✅ API route (off by default) — **live-verified end-to-end 2026-09-11**                                                       |
| `escrow`        |     ✅      |  ✅ (host tests)   |         ✅         | ✅ API route (`EscrowsService`) — **live-verified 2026-09-11** (create→FUNDED→release→RELEASED)                               |
| `treasury`      |     ✅      |  ✅ (host tests)   |         ✅         | ✅ API route (`TreasuryService`) — **live-verified 2026-09-11** (deposit→CONFIRMED); **no JS/TS unit tests**                  |
| `subscriptions` |     ✅      |  ✅ (host tests)   |         ✅         | ✅ API route (`SubscriptionsService`) — **live-verified 2026-09-11** (plan→ACTIVE, subscribe→ACTIVE); **no JS/TS unit tests** |
| `invoices`      |     ✅      |  ✅ (host tests)   |         ✅         | ✅ API route (on-chain issue/pay) — **live-verified 2026-09-11** (issue→issued, pay→PAID)                                     |
| `merchant`      |     ✅      |  ✅ (host tests)   |         ✅         | ✅ API route (register/sale/settle) — **live-verified 2026-09-11** (sale credited, settlement COMPLETED)                      |
| `multisig`      |     ✅      |  ✅ (host tests)   |         ✅         | ❌ not invoked by the platform                                                                                                |
| `rewards`       |     ✅      |  ✅ (host tests)   |         ✅         | ❌ not invoked by the platform                                                                                                |

All eight testnet addresses are recorded in `docs/testnet-deploy.md` and in the
generated (gitignored) `.deployed-contracts.env`; they were deployed on
2026-08-10. Re-verified on 2026-09-11 via Soroban RPC `getLedgerEntries` (all
eight contract instances live) and by simulating `admin()` / `paused()` /
`is_allowed(XLM SAC)` on the `payment` contract (admin set to the deployer, not
paused, XLM allowlisted). On the same date the **contract-integrations E2E**
(`node tests/e2e/contracts-flow.mjs`) passed 28/28 against live testnet: escrow
fund + release, treasury deposit confirmed, invoice issued + paid, merchant
registered on-chain, subscription plan + subscribe active, and merchant
settlement completed — every state driven by the event indexer, never a DB-only
write. The remaining gap is **unit** (not integration) coverage: `treasury` and
`subscriptions` services have no JS/TS unit tests.

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
# Build contracts (requires rust + wasm32v1-none target)
pnpm contracts:build

# Deploy all 8 contracts (writes .deployed-contracts.env; stable per-contract
# salts so re-runs are idempotent)
export STELLAR_SECRET_KEY=S...
pnpm deploy:contracts

# Initialize each contract + set the token allowlists + verify on-chain
pnpm contracts:init
```

Or the all-in-one: `bash scripts/deploy-testnet.sh` (build → deploy → init).

Manual equivalent for a single contract:

```bash
soroban contract deploy \
  --wasm contracts/target/wasm32v1-none/release/stellar_pay_payment.wasm \
  --source ADMIN \
  --network testnet

soroban contract invoke --id <ID> -- initialize --admin G…
```

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
- **The SDK route is fixed (2026-09) and unit-tested.** `prepareSorobanSendTransaction`
  runs the simulate → assemble (soroban-auth) round-trip so the envelope carries
  the resource footprint (`sorobanData`) and the `from.require_auth()`
  authorization entries; `submitSorobanSendTransaction` submits via Soroban RPC
  `sendTransaction`, and `signSorobanSendTransaction` fills the address
  credentials (with `validUntil`). The invocation targets the **deployed payment
  contract** (`contractId`), not the token SAC — a regression guarded by unit
  tests that assert the invoked contract address. Create-time simulation
  failures (e.g. a token not allowlisted) map to a 4xx with the on-chain
  diagnostic instead of a 500.
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
- **Ops prerequisite automated.** End-to-end contract-route payment on testnet
  requires the admin to `set_allowed` the token SACs on the deployed contracts
  (deployer key); until then a `send` reverts with `TokenNotAllowed`. This is
  now automated: `pnpm contracts:init` (`scripts/init-contracts.mjs`) calls
  `initialize(...)` on every contract that needs it, sets the XLM SAC (and any
  `ALLOWLIST_TOKENS`) allowlist on `payment` + `treasury`, and verifies the
  on-chain storage afterwards. Run it after `deploy-testnet.sh` /
  `deploy-contracts.mjs`. Until it has been run against the 2026-08-10
  deployment, the deployed contracts remain inert (verified: zero events,
  uninitialized storage).

## Security considerations

- Multi-sig proposals require `threshold` of `N` signers before execution; once
  quorum is reached `execute` performs the proposal's actual cross-contract
  invocation (`try_invoke_contract` with XDR-serialized `Val` args) and only
  marks the proposal executed when the target call succeeds — a failing call
  reverts the whole transaction so signers can fix and re-vote.
- Treasury withdrawals are allowlisted per token and, when governance is
  enabled, require a propose → approve → execute flow with a member threshold
  (plus an optional per-token max-withdrawal cap).
- Escrow funds are only released by explicit `release`/`refund` calls with proper
  auth; an optional arbiter can settle disputes, and time-locked releases fire
  only after `release_time`.
- All token operations go through the SAC `token` interface (`transfer`, `balance_of`)
  to support XLM and any Stellar asset.
