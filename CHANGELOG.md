# Changelog

All notable changes to Azure StellarPay Hub are documented in this file.

This project follows [Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/).

---

## [Unreleased]

### Security

- **Audit logs no longer store credentials.** The global `AuditInterceptor`
  journaled the raw request body, so `POST /auth/admin/login` persisted a
  plaintext admin password and `POST /auth/refresh` a live refresh token into
  `AuditLog.metadata` (which the admin dashboard renders). Sensitive keys
  (`password`, `token`/`refreshToken`, `secret`, `apiKey`, `signature`, …) are
  now replaced by `[REDACTED]` recursively before the row is written.
- **Webhook delivery is SSRF-guarded.** A merchant-controlled webhook URL was
  fetched from inside the deployment network with no checks, so a merchant
  could target `169.254.169.254`, `localhost` or an in-cluster service. URLs are
  now validated at registration (http(s), FQDN, no credentials, no
  private/loopback/link-local/`*.svc`/`*.local`/`*.internal` host) **and** every
  delivery re-resolves the hostname and refuses non-public answers. Deliveries
  also carry a 10s request timeout instead of hanging forever.
- **Realtime sockets apply the same authority as HTTP requests.** The Socket.IO
  gateway trusted any valid JWT; it now also requires the session to be `ACTIVE`
  and unexpired and the account to be `ACTIVE` before joining a user room, so
  logout/revocation and suspension close the realtime channel too.
- **`newNonce`/`newSecret` fail closed.** Both fell back to `Math.random()` when
  WebCrypto was unavailable — a silent downgrade for the auth challenge nonce
  and webhook/API secrets. They now throw, like `hashSecret` already did.

### Fixed

- **`verifySignedXdrOwner` could never return `true`.** The helper compared the
  signature hint against the last 4 characters of the StrKey (base32) address
  instead of the last 4 bytes of the raw ed25519 key, _and_ called the versioned
  envelope accessors unbound, which throws inside `xdr`. It verified no
  signature either — the hint alone proves nothing. It now extracts the hint
  correctly, verifies the signature against the transaction hash for a given
  network passphrase, and has positive + negative tests (the old suite only
  asserted rejections).
- **Duplicate route registrations removed.** `MerchantsController` and
  `InvoicesController`/`PaymentLinksController` both declared
  `GET /merchants/me/invoices` and `GET /merchants/me/payment-links`; Express
  dispatched to whichever was registered first (module import order), leaving
  the other handler dead. A route-table test asserts every method+path is
  registered exactly once.
- **Auth responses no longer lie about token lifetime.** `expiresInSeconds` was
  hardcoded to 7 days regardless of `JWT_EXPIRES_IN`, and wallet rows were always
  stored with `network: 'testnet'`. Both are now derived from configuration.
- **Sums of decimal amounts are exact.** Payment totals and payment-link
  `totalCollected` were computed with `Number()` arithmetic, accumulating binary
  float error into persisted money values; they now use the stroop helpers.
- **Memo limits are measured in bytes.** `memoSchema` used
  `z.string().max(28)` with a "28 bytes" message: a 28-character emoji memo
  passed validation (32 bytes) and then failed on-chain. The limit now counts
  UTF-8 bytes, matching `isValidMemo` in `@stellar-pay/shared`.
- **Generated artifacts are no longer tracked.** The Prisma client (27 files,
  including two platform-specific `libquery_engine-*.so.node` binaries) and
  Next.js's `next-env.d.ts` files were committed despite being regenerated on
  every build, dirtying the worktree and bloating the repo (`pnpm db:generate`
  produces the client; a clean-clone typecheck was verified without either).
- **Dependency hygiene** — removed the unused, deprecated `soroban-client`
  dependency and declared `globals`, which six ESLint configs imported without
  it being a dependency anywhere.
- **The Chrome extension is linted and type-checked in CI.** `apps/extension` sits
  outside the pnpm workspace, so no Nx target ever touched it and its esbuild build
  strips types without checking them — it was the only unverified code in the repo. It
  now has its own `tsconfig.json` + `eslint.config.mjs` (browser + WebExtension globals)
  and CI runs both, which immediately caught three `unknown`-payload type errors in the
  realtime client and a dead `getPublicKey` import. Socket/notification payloads are now
  narrowed defensively instead of cast, so a malformed event cannot throw inside the
  service worker.
- **Prisma CLI config moved out of `package.json`.** The deprecated
  `package.json#prisma` seed field (removed in Prisma 7) is replaced by
  `packages/database/prisma.config.ts`, which pins the schema/migrations paths to the
  config's directory and loads the environment itself — a config file makes the CLI
  skip `.env` loading. As a side effect `pnpm db:push|seed|migrate` now actually read
  the repo-root `.env` written by `pnpm generate:env` (Prisma previously only looked in
  the package directory, so the documented flow silently required an exported
  `DATABASE_URL`). The config is type-checked via `tsconfig.config.json`.
- **Clean-clone `pnpm typecheck` / `pnpm test` work** — the Nx `typecheck` and
  `test` targets did not depend on their workspace dependencies' `build`, so a
  fresh clone failed with ~209 `TS2307 Cannot find module '@stellar-pay/*'`
  errors until `pnpm build:packages` was run by hand. CI compensated by building
  first, which hid the problem from developers.

### Changed

- **Docs corrected to match the code**: `docs/database.md` described enums,
  models and fields that do not exist in the schema (`PaymentStatus`, `Payment`,
  `fromAccount`, `actorId`, Prisma `Decimal` money, soft deletes);
  `docs/api.md` now documents the escrow/subscription/treasury/on-chain
  invoice/merchant-settlement routes that were missing, plus the webhook SSRF
  rules. `SECURITY.md` and `docs/architecture.md` reflect the audit redaction,
  realtime authorization and webhook guard.
- `prisma/schema.prisma` is formatted with `prisma format` (alignment only, no
  schema changes), and the README's tier-1 verification row now reads
  446 tests / 46 suites.

### Removed

- **`multisig` and `rewards` Soroban contracts** — both were contract-level
  demonstrations with no API module, SDK method, indexer reconciliation or UI,
  so nothing in the platform could invoke them. Shipping them advertised
  capabilities the product did not have. Their already-deployed testnet
  instances remain on-chain but are no longer part of the repo, the deploy
  scripts, or the docs (`contracts/Cargo.toml`, `scripts/*`).

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
