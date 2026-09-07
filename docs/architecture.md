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
- **Audit logs: the `AuditLog` model and an admin listing endpoint exist, but no
  service writes audit entries yet** — sensitive admin operations are not
  currently journaled (documented limitation).
- Soroban contracts enforce multi-sig thresholds and escrow rules on-chain.

## Current state & limitations (accurate as of 2026-09)

- **Payments are classic Stellar transactions by default.** `POST
/payments/:id/submit` and the checkout submit path build/submit Stellar
  `Operation.payment` XDR. An **experimental Soroban route** exists behind
  `PAYMENT_ROUTE=contract`: `SEND` payments for allowlisted assets invoke the
  `payment` contract's `send` entry point (built in `@stellar-pay/sdk`). A
  successful Horizon submission is persisted as `SUBMITTED`, and the
  **event indexer** (`apps/api/src/indexer`, run by the scheduler every ~20s)
  polls Soroban RPC `getTransaction` and moves the row to `CONFIRMED` only when
  the ledger reports `SUCCESS` — the atomic `SUBMITTED → CONFIRMED` update makes
  confirmation idempotent, and payer realtime/notification events fire on that
  transition. Contract calls are not enabled by default (see `docs/contracts.md`
  → Platform wiring), and a full contract-route payment has not been executed
  on testnet because the on-chain SAC allowlist step still needs the deployer
  key.
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
- **Socket.IO fan-out is per-process (in-memory rooms).** Horizontal scaling of
  the API requires a Redis Socket.IO adapter, which is not wired yet. Redis is
  currently used for caching, rate-limit state, session state, and scheduler
  locks (no pub/sub).
- **Deployment state.** The architecture and infrastructure (Docker, K8s,
  Terraform, monitoring) are production-oriented, but the live platform runs on
  **Stellar testnet with demo data**. Mainnet is not deployed. Deployment targets
  are classified in `docs/deployment.md`.

## Feature maturity (evidence-based)

Status is assigned from evidence in this repository (code, tests, deployment
records), not from intent. Nothing is marked **PRODUCTION** while the platform
runs on testnet with demo data.

| Feature                                                   | Status                            | Evidence                                                                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth (Ed25519 challenge → JWT, sessions, RBAC)            | **DEV (tested)**                  | Unit tests + API e2e spec; exercised by the lifecycle E2E                                                                                                                                                    |
| Payments (classic Stellar send)                           | **DEV (tested, testnet)**         | Unit tests; lifecycle E2E submits real testnet XLM                                                                                                                                                           |
| Soroban contract payment route (`PAYMENT_ROUTE=contract`) | **EXPERIMENTAL (off by default)** | SDK invoke builder + indexer unit tests (11); submit persists `SUBMITTED`; indexer → `CONFIRMED` from on-chain `getTransaction` `SUCCESS`; **no testnet contract-route E2E yet** (SAC allowlist ops pending) |
| Checkout — invoice/payment-link pay + reconciliation      | **DEV (tested)**                  | Reconciliation unit tests (invoice PAID, link stats, webhooks, merchant notify)                                                                                                                              |
| Merchant registry, products, payment links, invoices (DB) | **DEV (partial)**                 | Service code + Zod schemas; webhook/notification integration varies                                                                                                                                          |
| Soroban contracts (8)                                     | **DEV (contract-level)**          | Rust unit tests; deployed + **verified live on testnet**; only the `payment` contract is reachable via the experimental off-by-default route                                                                 |
| Scheduled / recurring / subscription / settlement jobs    | **SCAFFOLD**                      | Scheduler creates PENDING rows only — no approval/signing/chain execution; comments admit the simulation                                                                                                     |     | Inbound detection — direct payments to merchant addresses | **DEV (testnet-verified)** | Horizon per-merchant feed poller + Soroban `payment`-event parser; `ChainEvent` unique-event dedupe; live testnet probe credited a real direct XLM payment exactly once; merchant notify + `payment.received` webhook + Socket.IO |
| Realtime (Socket.IO)                                      | **DEV (single-instance)**         | Unit coverage via flows; in-memory rooms, no Redis adapter yet                                                                                                                                               |
| Notifications & webhooks                                  | **DEV (partial)**                 | Dispatched from API-mediated successes; retries via scheduler                                                                                                                                                |
| IPFS receipts                                             | **DEV (provider-dependent)**      | Local/Pinata/web3.storage pinning; deterministic un-pinned CID fallback is not resolvable without a pin                                                                                                      |
| Explorer & admin analytics                                | **DEV (empty-state correct)**     | Live DB queries; success rate is `null` (not 100%) when there is no data                                                                                                                                     |
| Deployment                                                | **TESTNET / DEMO**                | Railway + Vercel on testnet; AKS/Terraform experimental; mainnet not deployed (`docs/deployment.md`)                                                                                                         |

Legend: **PRODUCTION** (mainnet, ops-ready) · **DEV** (implemented & tested on
this stack) · **SCAFFOLD** (placeholder behavior) · **NOT IMPLEMENTED**.
