# Changelog

All notable changes to Azure StellarPay Hub are documented in this file.

This project follows [Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/).

---

## [Unreleased]

### Removed

- **`multisig` and `rewards` Soroban contracts** — both were contract-level
  demonstrations with no API module, SDK method, indexer reconciliation or UI,
  so nothing in the platform could invoke them. Shipping them advertised
  capabilities the product did not have. Their already-deployed testnet
  instances remain on-chain but are no longer part of the repo, the deploy
  scripts, or the docs (`contracts/Cargo.toml`, `scripts/*`).

### Fixed

- **Clean-clone `pnpm typecheck` / `pnpm test` now work** — the Nx `typecheck`
  and `test` targets did not depend on their workspace dependencies' `build`,
  so a fresh clone failed with ~209 `TS2307 Cannot find module '@stellar-pay/*'`
  errors until `pnpm build:packages` was run by hand. CI compensated by building
  first, which hid the problem from developers.

## [0.1.0] — 2026-08-10

### Added

- **8 Soroban smart contracts** — `payment`, `escrow`, `multisig`, `treasury`,
  `subscriptions`, `invoices`, `merchant`, `rewards` _(#1)_
- **NestJS API** with 70+ REST endpoints and WebSocket realtime gateway _(#1)_
- **4 Next.js 16 apps** — `web` (wallet/merchant), `admin` (RBAC dashboard),
  `explorer` (public blockchain explorer), `docs` (documentation site) _(#1)_
- **12 shared packages** — `sdk`, `wallet`, `ui`, `authentication`, `database`,
  `validation`, `notifications`, `analytics`, `config`, `logger`, `shared`, `types` _(#1)_
- **Chrome extension** with quick-send, balance check, and push notifications _(#46)_
- **CI/CD pipeline** — GitHub Actions with lint, typecheck, test, contract build,
  app build, security scan, Docker image build/push, and AKS deploy _(#6, #10, #13)_
- **Dependabot** configured for weekly npm + Cargo dependency updates _(#13)_
- **Issue templates** for bug reports, feature requests, and good first issues _(#13)_
- **PR template** with checklist for tests, lint, typecheck, docs, and migrations _(#13)_
- **Infrastructure as code** — Docker Compose, Kubernetes (Kustomize), Terraform (Azure) _(#1)_
- **Monitoring** — Prometheus config with alert rules for API error rate and payment failures _(#1)_
- **Vercel deployment** for all 4 Next.js apps with security headers _(#48, #52)_
- **Admin dashboard** with sidebar nav, KPI cards, volume charts, asset pie chart,
  top merchants leaderboard, and success rate gauge _(#1, #19, #21)_
- **Explorer** with transaction search, account lookup, and stats cards _(#1)_
- **Web app** landing page with hero section, feature grid, wallet provider badges,
  and responsive design _(#1)_
- **Wallet adapters** — Freighter, xBull, and Albedo with unified `WalletAdapter` interface _(#1)_
- **Ed25519 challenge-sign authentication** with JWT access + refresh tokens and RBAC _(#1)_
- **Payment features** — send/receive, QR codes, payment links, scheduled/recurring,
  batch, split, fee estimation _(#1)_
- **Merchant features** — onboarding, product catalog, invoices, hosted checkout,
  POS mode, settlement, analytics, webhooks _(#1)_
- **Unit tests** — 131 tests across 7 packages (sdk, shared, authentication,
  validation, ui, wallet, database) _(#58)_
- **README** with Live Demos section, ASCII interface previews, deployment links,
  and comprehensive documentation _(#20, #57)_
- **Repository health files** — LICENSE (MIT), CODE_OF_CONDUCT,
  CONTRIBUTING, SECURITY _(#1)_

### Fixed

- **Turbopack SSR 500 error** — converted `@stellar-pay/ui` to ESM output,
  resolving CJS `__exportStar` re-export chain incompatibility _(#28)_
- **Docker build** — restored `pnpm-lock.yaml` to build context and used
  `pnpm deploy --legacy` flag _(#2, #3)_
- **Soroban contract compatibility** — pinned `ed25519-dalek` to 2.2.0 and
  bumped `ethnum` to 1.5.3 for modern Rust toolchains _(#4, #11)_
- **Vercel build configuration** — corrected monorepo build commands,
  install from root, proper `onlyBuiltDependencies` configuration _(#49-56)_
- **Lint errors** resolved across api, wallet, notifications, and analytics _(#14-17)_
- **Prettier formatting** applied consistently across all 200+ files _(#56)_

### Changed

- **Next.js downgrade/re-upgrade cycle** — stabilized on Next.js 16.3.0
  after resolving Vercel static file upload bug _(#38-45)_
- **CI actions pinned to commit SHAs** for supply chain security _(#10)_
- **pnpm 10** adoption with hoisted node linker and `onlyBuiltDependencies`
  moved to `pnpm-workspace.yaml` _(#25)_
- **Extension excluded from pnpm workspace** for independent build workflow _(#47)_

---

## Versioning

- `[Unreleased]` — changes on `main` since the last tagged release
- `[0.1.0]` — initial public release of the monorepo

Tags follow the format `v0.1.0`, `v0.2.0`, etc.

## Types of Changes

| Prefix       | Description                       |
| ------------ | --------------------------------- |
| `Added`      | New features                      |
| `Changed`    | Changes in existing functionality |
| `Deprecated` | Soon-to-be removed features       |
| `Removed`    | Removed features                  |
| `Fixed`      | Bug fixes                         |
| `Security`   | Vulnerability fixes               |
