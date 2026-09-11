---
title: Architecture
description: System architecture, module boundaries, and data flow of the Azure StellarPay Hub platform.
---

# Architecture

Azure StellarPay Hub is a **monorepo** powered by [Nx](https://nx.dev) and pnpm workspaces. It
implements a complete Stellar payment platform: wallet-based authentication, XLM/USDC/custom-asset
payments, merchants, invoices, payment links, subscriptions, escrow, and analytics.

## High-level diagram

```text
                          ┌──────────────────────────────┐
                          │         Clients              │
                          │  web · admin · explorer      │
                          └──────────────┬───────────────┘
                                         │ HTTPS / WSS
                          ┌──────────────▼───────────────┐
                          │        apps/api (NestJS)     │
                          │  Auth · Payments · Merchants │
                          │  Checkout · Webhooks · Admin │
                          └───┬──────────┬──────────┬────┘
                              │          │          │
                 ┌────────────▼───┐ ┌────▼─────┐ ┌───▼───────────┐
                 │ PostgreSQL     │ │ Redis    │ │ Stellar/Soroban│
                 │ (Prisma)       │ │ (cache,  │ │ Horizon +      │
                 │                │ │ locks)   │ │ contract net   │
                 └────────────────┘ └──────────┘ └───────────────┘
```

## Repo layout

| Path               | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `apps/web`         | End-user Next.js app (wallet, send/receive, merchant UI) |
| `apps/admin`       | Operator Next.js dashboard (RBAC protected)              |
| `apps/api`         | NestJS backend (REST + WebSockets)                       |
| `apps/explorer`    | Public transaction/account explorer                      |
| `apps/docs`        | Documentation site (renders `docs/*.md`)                 |
| `contracts/*`      | Soroban smart contracts (Rust)                           |
| `packages/*`       | Shared libraries (SDK, wallet, ui, database, auth, ...)  |
| `infrastructure/*` | Docker, Kubernetes, Terraform, monitoring                |
| `scripts`, `tests` | Tooling and end-to-end suites                            |

## Layering & dependency rules

1. `apps/*` depend on `packages/*`, never on other apps.
2. `packages/*` depend only on other `packages/*` (low-level, e.g. `types`).
3. `packages/ui` is the only package that ships React components; framework-agnostic logic
   lives in `shared`, `sdk`, `validation`, `config`, `logger`.
4. Nx enforces these boundaries via `nx.json` target defaults and per-project `package.json`
   dependencies.

## Request lifecycle (payment)

1. Web app builds a transaction via `@stellar-pay/sdk` (`buildPaymentTx`).
2. User signs in the wallet (Freighter / xBull / Albedo) and returns the signed XDR.
3. Web app submits the XDR to `POST /payments/submit`.
4. The API validates (Zod pipe), simulates against Horizon, submits, and persists a
   `Transaction` row; a `Notification` is created and pushed over WebSockets.
5. The realtime gateway fans the event out to connected clients; webhooks are dispatched
   to merchant endpoints.

## Data flow for wallet auth

```text
GET  /auth/challenge?address=G…      → signed challenge (24h TTL)
POST /auth/verify {signature}        → verifies Ed25519 sig → issues JWT
JWT → every protected route           → RBAC via roles guard
```

## Security boundaries

- All persistence goes through Prisma with Zod-validated DTOs.
- Secrets live in env vars / K8s secrets / Azure Key Vault (never in code).
- Rate limiting on every endpoint (auth endpoints throttled tighter).
- **Audit logs: implemented (request-level, best-effort).** A global
  `AuditInterceptor` (registered in `AppModule` since the initial commit) writes an
  `AuditLog` row for every mutating HTTP request (POST/PUT/PATCH/DELETE) that reaches a
  controller and completes — capturing the actor (user id / public key), action
  (`METHOD route`), resource, IP, and user-agent, plus request-body metadata. Writes are
  fire-and-forget: a failure is logged and never blocks the response. The admin listing
  endpoint (`GET /admin/audit-logs`) reads these rows. Dedicated interceptor unit tests cover
  the write path (actor/action capture, fire-and-forget failure handling).
  Limitations: rejected requests (guard/pipe failures before the controller) and
  non-HTTP/scheduler work are not journaled; response bodies are not captured.
- Soroban contracts enforce multi-sig thresholds and escrow rules on-chain.

## Current state & limitations (accurate as of 2026-09)

- **Payments are classic Stellar transactions by default.** `POST
/payments/:id/submit` and the checkout submit path build/submit Stellar
  `Operation.payment` XDR. An **experimental Soroban route** exists behind
  `PAYMENT_ROUTE=contract`: `SEND` payments for allowlisted assets invoke the
  `payment` contract's `send` entry point (built in `@stellar-pay/sdk`). The
  **event indexer** (`apps/api/src/indexer`, run by the scheduler every ~20s)
  polls Soroban RPC `getTransaction` and moves a submitted row to
  `CONFIRMED` only when the ledger reports `SUCCESS` — the atomic `SUBMITTED →
CONFIRMED` update makes confirmation idempotent, and payer
  realtime/notification events fire on that transition.
  **The SDK route is fixed and unit-tested**: `prepareSorobanSendTransaction`
  runs the simulate → assemble round-trip (resource footprint / `sorobanData`
  and the `from.require_auth()` soroban-auth entries), the invocation targets
  the deployed **payment contract** (not the token SAC — a regression guarded
  by unit tests), and `submitSorobanSendTransaction` submits via Soroban RPC
  `sendTransaction` (Horizon's classic endpoint rejects Soroban envelopes, and
  the SDK fails fast with the real reason instead). Create-time simulation
  failures (e.g. a token not allowlisted on-chain) surface as 4xx with the
  on-chain diagnostic rather than 500. The remaining prerequisite is the
  on-chain SAC allowlist step (`set_allowed` with the deployer key), which is
  now automated by `pnpm contracts:init` (`scripts/init-contracts.mjs`). See
  `docs/contracts.md` → Platform wiring. The deterministic contract-route
  _unit_ tests cover XDR construction, correct invocation target, error
  mapping, and `SUBMITTED`-persistence semantics.
- **Inbound detection now exists for merchant-address payments, in two forms.**
  `HorizonInboundService` polls each ACTIVE merchant's Horizon account payment
  feed (~15s cadence, per-merchant cursor in Redis) and credits **classic
  direct payments** that never went through the API — a customer wallet paying
  the merchant's settlement address directly. The Soroban indexer additionally
  parses `payment` contract events (`apps/api/src/indexer/soroban-event.ts`,
  accepts both vec and map payload layouts) whose recipient is a registered
  ACTIVE merchant and credits them the same way (native XLM only). Both funnel
  through `InboundReconciliationService`: the `ChainEvent` table (unique
  deterministic event id) makes duplicate deliveries impossible, an existing
  transaction hash is never double-credited, and each credited payment creates
  an INCOMING `CONFIRMED` transaction row, notifies the merchant, dispatches a
  `payment.received` webhook, and pushes a live `payment.received` Socket.IO
  event to the merchant user. A memo equal to an open invoice number (with
  matching asset + amount) marks the invoice PAID via the shared
  reconciliation service.
- **Inbound limits (accurate).** Only ACTIVE merchants with a registered
  settlement address are monitored; credit is per-account-polling so detection
  latency is up to one poll interval; cursor state lives in Redis (the
  `ChainEvent` unique ledger is the correctness backstop if a cursor is lost);
  the Soroban inbound path accepts native XLM only (other SACs need
  code/decimals resolution); Horizon ops other than `payment` (e.g.
  `path_payment`-style flows) and payments made _by_ a merchant are ignored.
  Verified live on testnet: a direct Friendbot-funded XLM payment to a fresh
  ACTIVE merchant address was detected and credited exactly once (hash
  `60bb12aa…`), with the second poll a no-op.
- **Idempotent, guarded payment state.** `POST /payments` accepts an optional
  `Idempotency-Key` header enforced by a `@@unique([userId, idempotencyKey])`
  constraint: a retried request returns the original intent (the unsigned XDR
  is kept in `meta` so the replay returns the exact signable payload), and a
  concurrent duplicate create loses the unique race and gets the winner's row.
  Submission is an **atomic claimed transition** (PENDING → SUBMITTED via
  `updateMany`) so only one request can reach the network — a loser is
  rejected before any XDR is sent; a transport/infrastructure failure reverts
  the claim to PENDING (retryable) instead of marking the payment FAILED,
  while a definitive network rejection persists as FAILED. Invoice `PAID` is a
  guarded ISSUED/DRAFT → PAID update (only the first reconciler notifies), and
  inbound credits are backstopped by the unique `hash` on `Transaction` in
  addition to `ChainEvent`. Signed webhook payloads embed a stable
  `deliveryId` and retries reuse the same delivery row, so merchants can dedupe
  exactly-once per logical event.
- **Checkout/payment links are server-authoritative against tampering.** The
  hosted checkout (`/pay/[code]`, `/checkout/invoice/[number]`) renders only
  the record fetched from the API — amount, recipient, and asset are never
  taken from the URL. Fixed-amount links ignore any customer-supplied amount
  (open/donation links still accept one), expired links and closed invoices
  (PAID/CANCELED/EXPIRED) are refused by the checkout endpoints, and a
  scheduler sweep flips due links ACTIVE → EXPIRED so the merchant dashboard
  never shows a stale link as active. Before either submit path posts a signed
  envelope to the network it is decoded and verified against the recorded
  intent (amount in stroops, recipient, asset code/issuer, memo) — a wallet
  that signed anything else is rejected with a 400 and nothing is sent, so a
  customer cannot underpay a fixed amount or redirect a payment. The customer
  UI distinguishes a wallet rejection/abort (never submitted — retryable, amber
  "Payment not completed") from a real network failure or an insufficient
  balance, and success is only shown after the server confirms on-chain
  settlement.
- **Socket.IO fan-out uses the Redis Socket.IO adapter.** The realtime gateway
  (`apps/api/src/realtime`) registers a Redis adapter, so events fan out across
  API instances (multi-instance safe); Redis also serves caching, rate-limit
  state, session state, and scheduler locks. Note: the docs previously claimed
  an in-memory-only gateway — the code moved to the Redis adapter and this
  document reflects that.
- **Deployment state.** The architecture and infrastructure (Docker, K8s,
  Terraform, monitoring) are production-oriented, but the platform is built for
  **Stellar testnet with demo data** and the hosted API service is currently
  **offline** (Railway returns `404 Application not found`; the Vercel frontends
  still serve static shells). Mainnet is not deployed. Deployment targets are
  classified in `docs/deployment.md`; the locally-run stack is the verified
  working configuration (see the README → Verification).

## Feature maturity (evidence-based)

Status is assigned from evidence in this repository (code, tests, deployment
records), not from intent. Nothing is marked **PRODUCTION** while the platform
runs on testnet with demo data.

| Feature                                                   | Status                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth (Ed25519 challenge → JWT, sessions, RBAC)            | **DEV (tested)**              | Unit tests + API e2e spec; exercised by the lifecycle E2E                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Payments (classic Stellar send)                           | **DEV (tested, testnet)**     | Unit tests; lifecycle E2E submits real testnet XLM                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Soroban contract payment route (`PAYMENT_ROUTE=contract`) | **DEV (tested, testnet)**     | SDK simulate→assemble invoke + Soroban-RPC submission, unit tests (29) incl. correct contract target + 4xx error mapping; `pnpm contracts:init` initializes + allowlists + verifies on-chain storage; **contract-route E2E executed live 2026-09-09**: `send` invoked on the deployed payment contract, on-chain `payment` event detected by the indexer, reconciled to `CONFIRMED` in Postgres, realtime `transaction.updated` delivered (22/22 checks)                                                   |
| Checkout — invoice/payment-link pay + reconciliation      | **DEV (tested)**              | Reconciliation unit tests (invoice PAID, link stats, webhooks, merchant notify)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Merchant registry, products, payment links, invoices (DB) | **DEV (partial)**             | Service code + Zod schemas; webhook/notification integration varies                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Soroban contracts (8)                                     | **DEV (contract-level)**      | Rust unit tests; all 8 deployed and re-verified live on testnet 2026-09-11 (`getLedgerEntries`).The `payment` route is **live-verified end-to-end**, and the `escrow`/`treasury`/`subscriptions`/`invoices`/`merchant` routes (via `ContractIntegrationService` + indexer reconciliation) are **live-verified** by the 28/28 `tests/e2e/contracts-flow.mjs` run on 2026-09-11. Remaining gap: `treasury`/`subscriptions` have no JS/TS unit tests and `multisig`/`rewards` are not invoked by the platform |
| Scheduled / recurring / subscription jobs                 | **DEV (confirmation-gated)**  | Scheduler creates one PENDING occurrence per due run (in-flight dedupe); the plan advances (`totalRuns`/`nextRunAt`/`COMPLETED`) only when the occurrence's transaction is confirmed on-chain (classic `SUCCEEDED` via submit, or contract `CONFIRMED` via the indexer) — unit tested; each occurrence still awaits user-approved submission (no auto-signer)                                                                                                                                              |
| Settlement jobs                                           | **DEV (testnet-verified)**    | On-chain settlement via the `merchant` contract: `/merchants/me/onchain/settle` prepares → signs → submits and the indexer advances the row to COMPLETED on the `settle` event (live-verified 2026-09-11: settlement COMPLETED, net amount 1.98 recorded from the event). `processPendingSettlements` still only sweeps PENDING → PROCESSING rows on a timer; those rows now complete via the on-chain event rather than DB-only state                                                                     |
| Inbound detection — direct payments to merchant addresses | **DEV (testnet-verified)**    | Horizon per-merchant feed poller + Soroban `payment`-event parser; `ChainEvent` unique-event dedupe; live testnet probe credited a real direct XLM payment exactly once; merchant notify + `payment.received` webhook + Socket.IO                                                                                                                                                                                                                                                                          |
| Realtime (Socket.IO)                                      | **DEV (multi-instance)**      | Unit coverage via flows; Redis Socket.IO adapter wired in the gateway                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Notifications & webhooks                                  | **DEV (partial)**             | Dispatched from API-mediated successes; retries via scheduler                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| IPFS receipts                                             | **DEV (provider-dependent)**  | Local/Pinata/web3.storage pinning; deterministic un-pinned CID fallback is not resolvable without a pin                                                                                                                                                                                                                                                                                                                                                                                                    |
| Explorer & admin analytics                                | **DEV (empty-state correct)** | Live DB queries; success rate is `null` (not 100%) when there is no data                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Deployment                                                | **TESTNET / DEMO**            | Railway + Vercel on testnet; AKS/Terraform experimental; mainnet not deployed (`docs/deployment.md`)                                                                                                                                                                                                                                                                                                                                                                                                       |

Legend: **PRODUCTION** (mainnet, ops-ready) · **DEV** (implemented & tested on
this stack) · **SCAFFOLD** (placeholder behavior) · **NOT IMPLEMENTED**.
