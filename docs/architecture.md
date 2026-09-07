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
- Rate limiting and audit logs on sensitive endpoints.
- Soroban contracts enforce multi-sig thresholds and escrow rules on-chain.

## Current state & limitations (accurate as of 2026-09)

- **Payments are classic Stellar transactions.** `POST /payments/:id/submit` and
  the checkout submit path build/submit Stellar `Operation.payment` XDR. The API
  does **not** currently invoke the deployed Soroban contracts; those contracts
  exist, are unit-tested in Rust, and are verified on testnet, but contract calls
  from the platform are not yet wired (see `docs/contracts.md`).
- **No inbound chain-event ingestion.** Transactions that arrive on-chain without
  going through an API submission (e.g. a wallet paying a merchant address
  directly) are not detected, so nothing is persisted, reconciled, or
  pushed over WebSockets for them. Realtime/notification/webhook events fire for
  API-mediated submissions only.
- **Socket.IO fan-out is per-process (in-memory rooms).** Horizontal scaling of
  the API requires a Redis Socket.IO adapter, which is not wired yet. Redis is
  currently used for caching, rate-limit state, session state, and scheduler
  locks (no pub/sub).
- **Deployment state.** The architecture and infrastructure (Docker, K8s,
  Terraform, monitoring) are production-oriented, but the live platform runs on
  **Stellar testnet with demo data**. Mainnet is not deployed. Deployment targets
  are classified in `docs/deployment.md`.
