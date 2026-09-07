# Azure StellarPay Hub

<p align="center">
  <img src="apps/web/public/logo.svg" alt="StellarPay Hub" width="260" />
</p>

**The open-source Stellar payments platform for businesses.**

Send and accept instant, low-cost payments on Stellar — backed by on-chain Soroban smart
contracts for escrow, multisig, subscriptions, invoicing, merchant settlement, and rewards.
Built for real-world commerce, not just demos.

[![Stellar](https://img.shields.io/badge/Stellar-7B3FE4?logo=stellar&logoColor=white)](https://stellar.org/developers)
[![Soroban SDK](https://img.shields.io/badge/Soroban_SDK-21.7.1-7B3FE4?logo=stellar&logoColor=white)](https://soroban.stellar.org/docs)
[![CI](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/actions/workflows/ci.yml)
[![Railway](https://img.shields.io/badge/Railway-API_deployed-0B0D0E?logo=railway&logoColor=white)](https://railway.com)
[![Vercel](https://img.shields.io/badge/Vercel-deployed-000000?logo=vercel&logoColor=white)](https://vercel.com)
[![Testnet](https://img.shields.io/badge/Testnet-8_contracts_deployed-34d399?logo=stellar&logoColor=white)](docs/testnet-deploy.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-ran_in_CI-34d399?logo=jest&logoColor=white)](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-818cf8.svg)](CONTRIBUTING.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-db5a3b?logo=rust&logoColor=white)](https://www.rust-lang.org/)

---

## Why Stellar?

Stellar is a Layer-1 blockchain purpose-built for payments — settlement takes 3-5 seconds
and costs fractions of a cent. Azure StellarPay Hub leverages Stellar's native multi-asset
support (XLM, USDC, and custom tokens) and Soroban smart contracts to deliver production-grade
payment infrastructure:

- **Near-instant settlement** — no waiting for blocks or paying gas spikes
- **On-chain escrow & multisig** — programmable trust, not just transfers
- **Built-in compliance** — Stellar's clawback, auth-required, and auth-revocable flags for regulated assets
- **Real ecosystem** — works with Freighter, xBull, Albedo wallets that millions already use

## Features

### Core Payments

| Feature                  | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| Send / Receive           | XLM, USDC, and any Stellar-issued asset                |
| QR codes & payment links | Shareable checkout links with hosted payment pages     |
| Scheduled payments       | One-time future-dated transfers                        |
| Recurring payments       | Daily, weekly, monthly subscription billing            |
| Batch payments           | Pay up to 100 recipients in a single transaction       |
| Split payments           | Distribute a single payment across multiple recipients |
| Fee estimation           | Real-time fee quotes from Horizon                      |

### Wallets & Authentication

| Feature                 | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| Freighter               | Browser extension wallet                                      |
| xBull                   | Browser extension + mobile wallet                             |
| Albedo                  | Web-based identity wallet (no extension needed)               |
| Ed25519 challenge → JWT | Sign a server-issued challenge to authenticate — no passwords |
| Session management      | View and revoke active sessions                               |
| Device tracking         | Audit which devices accessed your account                     |

### Merchants

| Feature         | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| Onboarding      | Register a merchant profile with settlement address               |
| Product catalog | Create and manage products for checkout                           |
| Invoices        | Generate on-chain invoices with due dates and auto-expiry         |
| Payment links   | Shareable URLs for fixed or open-amount payments                  |
| Hosted checkout | Branded checkout page for your customers                          |
| POS mode        | In-person checkout optimized for mobile                           |
| Settlement      | Auto-settle to your bank/wallet with configurable commission      |
| Analytics       | Revenue dashboards, customer insights, transaction volume         |
| Webhooks        | Real-time callbacks for payment events (paid, cancelled, expired) |

### Smart Contracts (Soroban)

| Contract        | Purpose                                        |
| --------------- | ---------------------------------------------- |
| `payment`       | Send XLM/assets, batch & split payments        |
| `escrow`        | Timed escrow with release & refund             |
| `multisig`      | Multi-signature proposal approval & execution  |
| `treasury`      | Allowlisted treasury (deposits/withdrawals)    |
| `subscriptions` | Recurring payment plans                        |
| `invoices`      | On-chain invoice issuance & payment            |
| `merchant`      | Merchant registry with commission & settlement |
| `rewards`       | Loyalty tiers, earn & redeem points            |

### Admin Dashboard

- User and merchant management (suspend, verify, assign roles)
- Transaction monitoring with filtering by status, asset, direction
- Asset registry (add/remove supported assets)
- System settings (commission rates, feature flags, contract addresses)
- Audit log with full request/response tracing
- Notification broadcast to users
- Analytics: dashboard metrics, 7/30/90-day volume charts

### Explorer

- Public transaction and account explorer
- Search by transaction hash or account public key
- View balances, trustlines, and transaction history for any Stellar account

### Chrome Extension

- Balance check at a glance from your browser toolbar
- Quick-send payments without opening the web app
- Real-time Chrome desktop notifications for incoming payments
- Freighter wallet integration for transaction signing
- See [`apps/extension/`](apps/extension/) for install instructions

## Live Demos

Deployed and publicly accessible — Vercel-hosted frontends pointed at the
Railway-hosted API (see [Deployment state](#deployment)). All hosted apps run
against **Stellar testnet with demo data**; none are mainnet deployments:

| App                   | URL                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **Admin Dashboard**   | [azure-stellar-pay-hub-admin-kfc3.vercel.app](https://azure-stellar-pay-hub-admin-kfc3.vercel.app) |
| **Web App**           | [web-umber-one-53.vercel.app](https://web-umber-one-53.vercel.app)                                 |
| **Explorer**          | (preview builds on push)                                                                           |
| **Soroban Contracts** | [Stellar Testnet](docs/testnet-deploy.md)                                                          |

> **Note — the ASCII wireframes below are UI mockups.** Figures such as volumes,
> user counts, and success rates are _illustrative sample data_, not live metrics.
> The deployed apps render real database values, which may legitimately show 0
> transactions and no success rate until real usage exists.

### Admin Dashboard

```
┌──────────────────────────────────────────────────────────────┐
│  ┌─────────┐                                                │
│  │ 🛡️ Logo  │  Analytics Dashboard                           │
│  │ StellarPay │  Real-time platform metrics and insights      │
│  │ Admin    │                                                │
│  ├─────────┤  ┌─────────┐ ┌──────────┐ ┌──────┐ ┌────────┐  │
│  │ Overview │  │ Daily    │ │ Monthly  │ │Revenue│ │ Users  │  │
│  │ Users    │  │ $12.4K   │ │ $284.7K  │ │$8.2K │ │ 1.2K   │  │
│  │ Merchants│  └─────────┘ └──────────┘ └──────┘ └────────┘  │
│  │ Txs      │  ┌───────────────────┐ ┌──────────┐            │
│  │ Assets   │  │ 📈 Volume Chart   │ │ ✅ 98.3% │            │
│  │ Audit    │  │  (7d / 30d / 90d) │ │ Success  │            │
│  │ Notifs   │  └───────────────────┘ └──────────┘            │
│  │ Settings │  ┌───────────────────┐ ┌──────────┐            │
│  └─────────┘  │ 🥧 Asset Dist.    │ │ 🏪 Top   │            │
│  v0.1.0       │  (Pie chart)     │ │ Merchants│            │
│               └───────────────────┘ └──────────┘            │
└──────────────────────────────────────────────────────────────┘
```

Dark-themed dashboard with fixed sidebar navigation, animated KPI cards, interactive
volume charts (7d/30d/90d toggle), asset distribution pie chart, top merchants leaderboard,
and real-time success rate gauge. All icons are inline SVGs — zero external icon dependencies.

### Web App (Landing)

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────┐│
│  │ 🟢 Powered by Stellar & Soroban smart contracts           ││
│  │                                                          ││
│  │       Payments on Stellar, beautifully simple            ││
│  │  Send XLM and Stellar assets, collect with payment       ││
│  │  links and invoices, and move money across borders.      ││
│  │                                                          ││
│  │        [ Get started → ]    [ Read the docs ]            ││
│  │                                                          ││
│  │   < 5s          3             7             1            ││
│  │ Settlement   Wallet      Soroban        Unified          ││
│  │   time      providers    contracts        SDK            ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                  │
│  │ 🌐 Multi  │ │ 📱 QR &   │ │ 🔁 Repeat │  ···             │
│  │  -wallet  │ │  links    │ │  payments │                  │
│  └───────────┘ └───────────┘ └───────────┘                  │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  👥 Bring your favorite wallet                            ││
│  │  [ Freighter ] [ xBull ] [ Albedo ]                      ││
│  │                [ ⚡ Launch app ]                          ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

Gradient hero section with orb animations, 4-column stat cards, 6-feature grid with
hover effects, and wallet provider badges. Connects via Freighter, xBull, or Albedo.

### Explorer

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────┐│
│  │ 🧭 StellarPay Explorer    │ 🔍 Search tx hash or account ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│       StellarPay Explorer                                    │
│   Search transactions and accounts across the platform.       │
│                                                              │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│   │ 📦 12.4K │  │ ✅ 98.3% │  │ ❌ 217   │                 │
│   │ Txs      │  │ Succeeded│  │ Failed   │                 │
│   └──────────┘  └──────────┘  └──────────┘                 │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │ Recent transactions                                   │  │
│   ├──────────────────────────────────────────────────────┤  │
│   │ tx_a1b2c3… · 500 USDC                                │  │
│   │ GABCD… → GEFGH… · 2 min ago                SUCCEEDED →│  │
│   ├──────────────────────────────────────────────────────┤  │
│   │ tx_d4e5f6… · 100 XLM                                 │  │
│   │ GHIJK… → GLMNO… · 15 min ago                FAILED  →│  │
│   └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Public blockchain explorer with sticky header search, stat cards (transactions/succeeded/failed),
and real-time transaction table with hash, amount, addresses, timestamps, and status badges.

## Tech Stack

| Layer               | Technology                                               |
| ------------------- | -------------------------------------------------------- |
| **Runtime**         | Node.js 22, Rust (stable, wasm32 target)                 |
| **Monorepo**        | Nx + pnpm workspaces                                     |
| **API**             | NestJS (Express), Socket.IO for realtime events          |
| **Web apps**        | Next.js 15 (App Router), React 19, Tailwind CSS          |
| **Database**        | PostgreSQL 16, Prisma ORM                                |
| **Cache / Locks**   | Redis 7 (no pub/sub yet — realtime fan-out is in-memory) |
| **Blockchain**      | Stellar Horizon API, Soroban RPC                         |
| **Smart contracts** | Soroban SDK 21.7.1 (Rust)                                |
| **Validation**      | Zod (runtime type safety)                                |
| **Auth**            | Ed25519 signatures, JWT (access + refresh tokens), RBAC  |
| **Testing**         | Jest (JS/TS), Rust test harness (contracts)              |
| **CI/CD**           | GitHub Actions, Docker, Kubernetes, Terraform (Azure)    |

## Repository Structure

```
azure-stellar-pay-hub/
├── apps/
│   ├── api/              NestJS backend (REST + WebSocket)
│   ├── web/              End-user wallet & merchant app (Next.js)
│   ├── admin/            Operator dashboard with RBAC (Next.js)
│   ├── explorer/         Public transaction/account explorer (Next.js)
│   ├── docs/             Documentation site rendering docs/*.md (Next.js)
│   └── extension/        Chrome extension — quick-send, balances, notifications
│
├── contracts/            Soroban smart contracts (Rust)
│   ├── payment/          Send, batch & split payments
│   ├── escrow/           Timed escrow with release + refund
│   ├── multisig/         Proposal-based multi-signature wallet
│   ├── treasury/         Allowlisted deposit/withdrawal vault
│   ├── subscriptions/    Recurring payment plans
│   ├── invoices/         On-chain invoice lifecycle
│   ├── merchant/         Merchant registry, commission, settlement
│   └── rewards/          Points-based loyalty system
│
├── packages/
│   ├── sdk/              Typed HTTP client for the API + Stellar Horizon wrapper
│   ├── wallet/           Multi-wallet adapter (Freighter, xBull, Albedo) + React context
│   ├── ui/               Shared React component library (Button, Card, Toast, Dialog, etc.)
│   ├── authentication/   JWT, Ed25519 challenge-sign, RBAC, password hashing
│   ├── database/         Prisma schema, migrations, seed scripts, PrismaService
│   ├── validation/       Zod schemas for all API DTOs (auth, payment, merchant, user, etc.)
│   ├── notifications/    Multi-channel notification providers (email, SMS, push, webhook)
│   ├── analytics/        Event tracking providers (console, noop, extensible)
│   ├── config/           Environment variable schema + validation
│   ├── logger/           Structured logging with configurable levels
│   ├── shared/           Shared utilities: money (stroops), Stellar URI parser, IDs, pagination
│   └── types/            Shared TypeScript type definitions
│
├── infrastructure/
│   ├── docker/           Dockerfiles (api, web) + docker-compose for local dev
│   ├── kubernetes/       Kustomize manifests (deployments, ingress, secrets, config)
│   ├── terraform/        Azure infrastructure as code (AKS, Postgres, Redis, Key Vault)
│   └── monitoring/       Prometheus config, alert rules
│
├── docs/                 Architecture, API, SDK, contracts, database, deployment, contributing
├── scripts/              Bootstrap scripts (env gen, setup, badge updater, testnet deploy)
├── tests/                End-to-end smoke tests + load testing scripts
└── .github/              CI/CD workflows, issue/PR templates, Dependabot
```

## Quick Start

### Prerequisites

- **Node.js** ≥ 20.9 (use `nvm install` — `.nvmrc` included)
- **pnpm** ≥ 9 (run `corepack enable`)
- **Docker** (for local Postgres + Redis)
- **Rust** stable + `wasm32v1-none` target (for Soroban contracts — optional)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub.git
cd azure-stellar-pay-hub

# 2. Install dependencies
corepack enable
pnpm install

# 3. Scaffold environment files
pnpm generate:env
# Edit .env and apps/*/.env with your values

# 4. Start infrastructure (Postgres + Redis)
pnpm docker:up

# 5. Set up the database
pnpm db:generate
pnpm db:push
pnpm db:seed

# 6. Start everything
pnpm dev
```

### Apps at a glance

| App      | URL                   | Command             |
| -------- | --------------------- | ------------------- |
| API      | http://localhost:4000 | `pnpm dev:api`      |
| Web      | http://localhost:3000 | `pnpm dev:web`      |
| Admin    | http://localhost:3001 | `pnpm dev:admin`    |
| Explorer | http://localhost:3002 | `pnpm dev:explorer` |
| Docs     | http://localhost:3003 | `pnpm dev:docs`     |

## Scripts Reference

| Command                          | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `pnpm dev`                       | Run all 5 apps in parallel (watch mode)      |
| `pnpm build`                     | Build all apps and packages                  |
| `pnpm build:apps`                | Build only the apps                          |
| `pnpm build:packages`            | Build only the shared packages               |
| `pnpm lint`                      | ESLint across the entire workspace           |
| `pnpm typecheck`                 | `tsc --noEmit` on every TypeScript project   |
| `pnpm test`                      | Run all unit and integration tests           |
| `pnpm test:e2e`                  | Run the local-stack smoke test               |
| `pnpm test:e2e:flow`             | Payment-lifecycle E2E (live Stellar testnet) |
| `pnpm format`                    | Auto-format with Prettier                    |
| `pnpm format:check`              | Check formatting without changing files      |
| `pnpm db:generate`               | Generate Prisma client from schema           |
| `pnpm db:migrate`                | Run Prisma migrations                        |
| `pnpm db:push`                   | Push schema directly to database             |
| `pnpm db:seed`                   | Seed the database with demo data             |
| `pnpm db:studio`                 | Open Prisma Studio (database GUI)            |
| `pnpm contracts:build`           | Compile Soroban contracts to WASM            |
| `pnpm contracts:test`            | Run all Rust contract unit tests             |
| `pnpm docker:up`                 | Start Postgres + Redis containers            |
| `pnpm docker:down`               | Stop and remove containers                   |
| `pnpm generate:env`              | Scaffold `.env` files from templates         |
| `pnpm setup`                     | Full first-time bootstrap                    |
| `bash scripts/deploy-testnet.sh` | Deploy contracts + API to Stellar testnet    |

## API Overview

The NestJS API serves as the backend for all apps. Key modules:

| Module            | Routes                 | Description                                                         |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| **Auth**          | `/auth/*`              | Challenge, verify, refresh, logout, sessions                        |
| **Payments**      | `/payments/*`          | Quote, preview, submit, schedule, recurring, batch, history         |
| **Assets**        | `/assets/*`            | List assets, create/remove trustlines                               |
| **Wallet**        | `/wallet/*`            | Balances, trustlines, network switching                             |
| **Merchants**     | `/merchants/*`         | Onboarding, profile, products, invoices, settlement                 |
| **Checkout**      | `/checkout/*`          | Public payment link & invoice checkout                              |
| **Invoices**      | `/invoices/*`          | Create, list, public lookup                                         |
| **Payment Links** | `/payment-links/*`     | Create, list, public lookup by code                                 |
| **Users**         | `/users/*`             | Profile, contacts, beneficiaries, preferences, devices              |
| **Notifications** | `/notifications/*`     | In-app notification inbox                                           |
| **Webhooks**      | `/webhooks/*`          | Register and test webhook endpoints                                 |
| **Admin**         | `/admin/*`             | RBAC-protected: users, merchants, transactions, analytics, settings |
| **Realtime**      | WebSocket `/socket.io` | Live events: `payment.sent`, `payment.received`, `notification`     |

Full API reference: [`docs/api.md`](docs/api.md)

## SDK (`@stellar-pay/sdk`)

The SDK provides two main classes:

```typescript
import { ApiClient, StellarNetwork } from '@stellar-pay/sdk';

// Typed HTTP client for the API
const api = new ApiClient({ baseUrl: 'http://localhost:4000', getToken: () => token });
await api.payments.create({ to: 'G...', amount: '100', assetCode: 'XLM' });

// Stellar Horizon wrapper for direct blockchain interaction
const network = StellarNetwork.forTestnet();
const xdr = await network.buildPaymentTransaction({
  from: 'G...',
  to: 'G...',
  amount: '100',
  assetCode: 'XLM',
});
// User signs with wallet, then:
const result = await network.submitSignedTransaction(signedXdr);
```

Full SDK docs: [`docs/sdk.md`](docs/sdk.md)

## Testing

```bash
pnpm test              # All unit + integration tests (Jest)
pnpm contracts:test    # All Rust contract tests (cargo test)
pnpm test:e2e          # Smoke test (API health, needs Postgres + Redis)
pnpm test:e2e:flow     # Full payment-lifecycle E2E (see below — needs testnet)
```

Test categories — see [`tests/README.md`](tests/README.md) for the full tier breakdown:

- **Deterministic unit/integration tests (CI)**: every package and API service has
  `*.test.ts` files; includes the checkout submission → invoice/payment-link
  reconciliation tests
- **Soroban contract tests (CI)**: per-entry-point tests in `contracts/*/src/test.rs`
- **Smoke test (not CI)**: `tests/smoke.mjs` — boots the API and checks the health
  endpoint (an API health check only, **not** a payment E2E)
- **Payment-lifecycle E2E (not CI, live testnet)**: `tests/e2e/auth-payment-flow.mjs`
  — auth challenge → verify → fund (Friendbot) → payment create → **sign → submit →
  on-chain confirmation → persisted final state → realtime Socket.IO
  `transaction.updated`** → logout → JWT invalidation
- **Load tests**: `tests/load/payment-load.js` — k6/Artillery-style load generation

## CI/CD

| Workflow              | File                                      | Triggers                                   |
| --------------------- | ----------------------------------------- | ------------------------------------------ |
| **CI**                | `.github/workflows/ci.yml`                | Every PR and push to `main`                |
| **Deploy to Railway** | `.github/workflows/deploy-railway.yml`    | Push to `main` (API/Docker changes)        |
| **Deploy to AKS**     | `.github/workflows/deploy.yml`            | Push to `main` (AKS — production-oriented) |
| **Release Extension** | `.github/workflows/publish-extension.yml` | Push `extension-v*` tag                    |
| **PR Auto-Labeler**   | `.github/workflows/pr-labeler.yml`        | PR opened/edited                           |
| **Badge Updater**     | `.github/workflows/update-badges.yml`     | Push to `main` with Cargo.toml changes     |
| **Dependabot**        | `.github/dependabot.yml`                  | Weekly (npm + Cargo)                       |

CI runs: lint → typecheck → format check → tests → contract build → contract tests → app builds → security audit (zizmor).

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for full instructions, including a
classification of every deployment target (canonical / supported / experimental).
Current state: the hosted API + frontends run on **testnet with demo data**;
Kubernetes/Terraform exist as production-oriented infrastructure but are **not** a
verified live production deployment, and nothing is deployed to Stellar mainnet.

> Note — the wireframe figures in this README (volumes, users, success rates) are
> illustrative UI mockups, not live metrics.

- **Docker Compose**: `pnpm docker:up` + `pnpm dev`
- **Production Docker**: `infrastructure/docker/api.Dockerfile` and `web.Dockerfile`
- **Railway (API)**: Auto-deploys on push to `main` via `deploy-railway.yml` — uses `infrastructure/docker/api.Dockerfile`
- **Kubernetes**: `infrastructure/kubernetes/` — Kustomize bundle with Postgres, Redis, API, Web, Ingress
- **Terraform (Azure)**: `infrastructure/terraform/` — provisions AKS, managed Postgres, Redis, Key Vault
- **Monitoring**: `infrastructure/monitoring/` — Prometheus + Grafana + alert rules
- **Vercel**: All frontends deploy automatically on push via Vercel GitHub integration:

| App      | Vercel URL                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------- |
| Admin    | [azure-stellar-pay-hub-admin-kfc3.vercel.app](https://azure-stellar-pay-hub-admin-kfc3.vercel.app) |
| Web      | [web-umber-one-53.vercel.app](https://web-umber-one-53.vercel.app)                                 |
| Explorer | (preview on push)                                                                                  |
| Docs     | (preview on push)                                                                                  |

- **Extension**: `git tag extension-v0.1.0 && git push origin extension-v0.1.0` — builds & publishes ZIP to GitHub Releases

### Environment Variables

| Variable                      | Where                      | Purpose                             |
| ----------------------------- | -------------------------- | ----------------------------------- |
| `NEXT_PUBLIC_API_URL`         | Vercel (admin, web)        | Backend API URL                     |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Vercel (admin, web)        | `testnet` or `public`               |
| `RAILWAY_TOKEN`               | GitHub railway environment | Auth for Railway CLI deploys        |
| `RAILWAY_API_URL`             | GitHub railway environment | API URL for smoke test              |
| `DATABASE_URL`                | Railway dashboard          | PostgreSQL connection string        |
| `JWT_SECRET`                  | Railway dashboard          | Access/refresh token signing secret |
| `REDIS_URL`                   | Railway dashboard          | Redis connection string             |

- **Testnet (Stellar)**: `bash scripts/deploy-testnet.sh` — one-command deploy to Stellar testnet

## Documentation

| Document                                           | Content                                             |
| -------------------------------------------------- | --------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)     | System architecture, data flow, security boundaries |
| [`docs/api.md`](docs/api.md)                       | Full REST API reference with all endpoints          |
| [`docs/sdk.md`](docs/sdk.md)                       | SDK usage guide (ApiClient + StellarNetwork)        |
| [`docs/contracts.md`](docs/contracts.md)           | Smart contract architecture and API                 |
| [`docs/database.md`](docs/database.md)             | Schema design, migrations, seeding                  |
| [`docs/development.md`](docs/development.md)       | Local dev setup, adding packages, scripts           |
| [`docs/deployment.md`](docs/deployment.md)         | Docker, Kubernetes, Terraform, monitoring           |
| [`docs/testnet-deploy.md`](docs/testnet-deploy.md) | Step-by-step Stellar testnet deployment guide       |
| [`contracts/README.md`](contracts/README.md)       | Contract build, test, deploy instructions           |
| [`CHANGELOG.md`](CHANGELOG.md)                     | Version history and release notes                   |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)               | Branch strategy, PR checklist, commit conventions   |

## Contributing

We welcome contributions! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for:

- Branch naming (`feat/`, `fix/`, `chore/`, `refactor/`)
- PR checklist (tests, lint, typecheck, docs, migrations)
- [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.)
- Code style (ESLint + Prettier for TS, rustfmt for Rust)

Browse [open issues](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/issues) filtered by:
[`good first issue`](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/issues?q=is%3Aopen+label%3A%22good+first+issue%22) ·
[`complexity:low`](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/issues?q=is%3Aopen+label%3A%22complexity%3Alow%22) ·
[`complexity:medium`](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/issues?q=is%3Aopen+label%3A%22complexity%3Amedium%22) ·
[`complexity:high`](https://github.com/Azure-StellarPay-Hub/azure-stellar-pay-hub/issues?q=is%3Aopen+label%3A%22complexity%3Ahigh%22)

All contributors must follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? **Do not open a public issue.** See [`SECURITY.md`](SECURITY.md) for the private reporting process.

Security highlights:

- Ed25519 wallet-based authentication (no passwords stored)
- Zod-validated DTOs on every API input
- Rate limiting on auth and payment endpoints
- Audit logging on all mutating requests
- CSRF protection on state-changing endpoints
- RBAC with role hierarchy (admin > merchant > user)
- Soroban contracts use `require_auth` for all privileged operations
- No secrets in code — env vars / K8s secrets / Azure Key Vault

## License

MIT © Azure StellarPay Hub contributors — see [`LICENSE`](LICENSE).
