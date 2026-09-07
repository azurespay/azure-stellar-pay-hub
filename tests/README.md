# Test Suites

## Test tiers

Tests are organised by how much live infrastructure they require, so each tier
can be run in the right environment:

| Tier                                     | Requires                                                                     | Run in CI?                                                         | Command                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| **1. Deterministic unit / integration**  | Nothing external (deps mocked)                                               | ✅ yes                                                             | `pnpm test`                               |
| **2. Soroban contract tests**            | Rust toolchain (+ `wasm32v1-none`)                                           | ✅ yes                                                             | `pnpm contracts:test`                     |
| **3. API integration (Nest, supertest)** | Postgres + Redis (docker-compose)                                            | ✅ yes (CI provisions the services and runs `db:push` + the suite) | `pnpm --filter @stellar-pay/api test:e2e` |
| **4. Local-stack smoke**                 | Booted API + Postgres + Redis                                                | ❌ no                                                              | `pnpm test:e2e`                           |
| **5. Testnet E2E (payment lifecycle)**   | Booted API + Postgres + Redis + **live Stellar testnet** (Friendbot/Horizon) | ❌ no                                                              | `pnpm test:e2e:flow`                      |
| **6. Load test**                         | Booted API + Postgres + Redis                                                | ❌ no                                                              | `k6 run tests/load/payment-load.js`       |

Tiers 4–6 are not part of CI (`.github/workflows/ci.yml`). Tier 3 runs in CI
(the job provisions Postgres + Redis and runs `pnpm db:push` + the suite).
Tiers 4–6 need a live database/Redis and, for tier 5, live testnet access —
they run locally or against a deployed testnet environment.

| Suite                  | Location                          | Command                                   |
| ---------------------- | --------------------------------- | ----------------------------------------- |
| Package unit tests     | `packages/*/src/*.test.ts`        | `pnpm test`                               |
| API unit tests (Nest)  | `apps/api/src/**/*.test.ts`       | `pnpm test`                               |
| API integration (Nest) | `apps/api/test/*.e2e-spec.ts`     | `pnpm --filter @stellar-pay/api test:e2e` |
| Soroban contract tests | `contracts/*/src/test.rs`         | `pnpm contracts:test`                     |
| Local-stack smoke      | `tests/smoke.mjs`                 | `pnpm test:e2e`                           |
| Auth + payment E2E     | `tests/e2e/auth-payment-flow.mjs` | `pnpm test:e2e:flow`                      |
| Load test (k6)         | `tests/load/payment-load.js`      | `k6 run tests/load/payment-load.js`       |
| Security checks        | `.github/workflows/ci.yml`        | zizmor + npm audit (CI)                   |

## What each tier actually verifies

- **Unit/integration (1)** — services and validators in isolation with mocked
  infra. Includes the checkout/submission reconciliation tests that prove a
  successful payment marks invoices `PAID`, bumps payment-link stats, dispatches
  webhooks, and notifies merchants. Inbound-listener tests cover the Soroban
  event parser (vec + map payload layouts), Horizon feed polling/filtering, the
  `ChainEvent` unique-event idempotency, and merchant/invoice inbound credit.
- **Contract tests (2)** — every Soroban entry point in `test.rs` runs against
  the Soroban test host (no network).
- **API integration (3)** — boots the NestJS `AppModule` with supertest and
  verifies real routes against Postgres + Redis. Includes the
  **payment-lifecycle spec** (`apps/api/test/payment-lifecycle.e2e-spec.ts`):
  a merchant owner authenticates through the real auth flow (JWT) and connects
  Socket.IO, the Horizon listener is fed a direct on-chain payment into the
  merchant settlement address (chain mocked at the HTTP boundary), and the test
  asserts the merchant receives the live `payment.received` event **and** the
  database holds exactly one INCOMING `CONFIRMED` transaction with the chain
  hash. A re-delivered event (simulated cursor loss) must not double-credit
  (the `ChainEvent` unique ledger is asserted). This is the deterministic,
  CI-safe version of the No. 3 journey; the testnet version that also drives
  real create → sign → submit lives in tier 5.

  Failure-path and duplicate coverage across tiers:

  | Scenario                             | Covered where                                                                     |
  | ------------------------------------ | --------------------------------------------------------------------------------- |
  | Duplicate chain event                | Tier 3 lifecycle spec (re-delivered feed) + `ChainEvent` unique ledger unit tests |
  | Duplicate submission of same payment | Unit tests (`payments.service.test.ts` — already-submitted guard)                 |
  | Failed/zero/invalid amounts          | Unit tests (`inbound.service.test.ts`, payment validation)                        |
  | Unknown event / unknown payment id   | Unit tests (non-merchant recipient ignored; unparseable payload skipped)          |
  | Listener restart recovery            | Redis cursors + `ChainEvent` dedupe backstop (unit-tested idempotency)            |
  | Failed network submission            | Unit tests (`payments.service.contract.test.ts`, `checkout.service.test.ts`)      |

- **Smoke (4)** — boots the API and checks the health + a public endpoint. This
  is **not** a payment E2E; use tier 5 for the payment lifecycle.
- **Testnet E2E (5)** — the closest to real product behavior that runs without
  mainnet: auth challenge → verify → JWT → Friendbot funding → payment create →
  **sign → submit → on-chain confirmation → persisted final state → realtime
  `transaction.updated` delivery over Socket.IO** → logout → token invalidation.
  It requires `API_URL` (including the `/api` prefix) or a bootable local API.
  By default it exercises the **classic** Stellar path (`SUCCEEDED`). Set
  `E2E_CONTRACT=1` (plus `CONTRACT_STELLAR_PAY_PAYMENT` / `SOROBAN_RPC_URL` for
  boot mode) to route the same payment through the **Soroban `payment`
  contract**: the flow then expects `SUBMITTED` after submission and polls until
  the scheduler-driven indexer confirms it on-chain (`CONFIRMED`). Contract mode
  requires the deployed contract's XLM SAC to be allowlisted (`set_allowed` by
  the admin/deployer) — until that ops step is done, `send` reverts with
  `TokenNotAllowed` and contract mode cannot pass.
- **Load (6)** — Artillery/k6-based synthetic traffic.

## Running everything

```bash
pnpm test                # Tier 1 — unit/integration
pnpm contracts:test      # Tier 2 — requires Rust toolchain
pnpm --filter @stellar-pay/api test:e2e   # Tier 3 — requires Postgres + Redis
pnpm test:e2e            # Tier 4 — boots API against a live DB + Redis
pnpm test:e2e:flow       # Tier 5 — as above + live Stellar testnet
```
