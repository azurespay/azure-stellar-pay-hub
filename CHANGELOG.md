# Changelog

All notable changes to Azure StellarPay Hub are documented in this file.

This project follows [Semantic Versioning](https://semver.org/) and
[Conventional Commits](https://www.conventionalcommits.org/).

---

## [Unreleased]

### Added

- **Scheduled and split/batch payment intents are covered end to end.** A new
  tier-3 spec (`apps/api/test/scheduled-split.e2e-spec.ts`) drives both create
  paths through real HTTP routes against Postgres + Redis: a scheduled/recurring
  intent is stored `ACTIVE` with its next run (no XDR is built and no
  `Transaction` row is written) and its list/cancel routes are scoped to the
  owner, and a 3-recipient split produces one `Operation.payment` per recipient
  with the exact amounts and a recorded intent holding the summed total. The
  live testnet suite (`tests/e2e/auth-payment-flow.mjs`) gained the matching
  end-to-end legs — create → list → cancel for a schedule, and create → sign →
  submit → `SUCCEEDED` for a 3-recipient split — taking it to **32 assertions**
  in both classic and contract mode. Tier 3: **19 → 24 tests**.
- **The notifications and logger packages cover their untested paths.**
  `packages/notifications/src/providers.smtp.test.ts` virtual-mocks nodemailer to
  assert the transport options (host/port/`secure`/auth, including the
  STARTTLS-without-credentials case), the mail envelope the email provider builds,
  the non-`MODULE_NOT_FOUND` transport failure that must propagate rather than
  degrade, and the placeholder-host short-circuit — with no mail dependency
  added. `packages/logger/src/index.test.ts` now also captures stdout to assert
  the JSON record emitted per level, the service and child bindings it carries,
  and that the configured threshold actually suppresses the levels below it.
  Tier 1: **562 → 570 tests in 63 suites**.
- **The escrow refund path is now covered by the live testnet E2E.**
  `tests/e2e/contracts-flow.mjs` exercised escrow create → fund → release but
  never the refund escape hatch, so `POST /escrows/:id/refund` (and its on-chain
  `refund` event, indexer reconciliation and `REFUNDED` state) had unit and Rust
  coverage only. The harness now also runs create → FUNDED → refund → REFUNDED
  against the deployed escrow contract, plus a duplicate-refund assertion that the
  escrow stays `REFUNDED` and cannot credit the initiator twice. Contract
  integrations E2E: **28 → 33 assertions**.
- **The Developer Certificate of Origin is enforced in CI.** Every commit in a
  pull request must carry a `Signed-off-by:` trailer whose address matches the
  commit author; `.github/workflows/dco.yml` fails the check otherwise and lists
  each offending commit with the fix (`git rebase --signoff main`). The check is
  the repository's own `scripts/check-dco.mjs` — runnable as `pnpm dco` — rather
  than a third-party action, so it is auditable and adds nothing to the supply
  chain. Merge commits are skipped and dependency-bot commits are exempt.
- **The four Next.js apps have real test suites.** `apps/web`, `apps/admin`,
  `apps/explorer` and `apps/docs` shipped `"test": "jest --passWithNoTests"` with
  no Jest configuration, no jsdom and no test files, so four of the seventeen Nx
  projects passed their `test` target unconditionally. Each now runs `next/jest`
  plus React Testing Library in jsdom with its own `jest.config.mjs` and
  `jest.setup.ts`: **54 tests in 10 suites** covering the wallet
  connect/switch/disconnect menu, the header's active-route highlighting, the
  realtime hook's token handshake and teardown, the explorer's
  account-vs-transaction routing, the admin sidebar, the docs loader and the docs
  router's 404 path, plus the shared formatting helpers. The `--passWithNoTests`
  flag is gone, so an empty suite now fails instead of passing. Tier 1 is
  **562 tests in 62 suites**.
- **OpenSSF Scorecard runs on the repository.** `.github/workflows/scorecard.yml`
  scores the supply chain on every push to `main`, weekly, and whenever a branch
  protection rule changes; the result is published to the public Scorecard API and
  to the code-scanning dashboard. It is a report rather than a gate, and both the
  enforced checks and the accepted findings are written down in `SECURITY.md`.
- **CodeQL analyses the TypeScript/JavaScript surface.**
  `.github/workflows/codeql.yml` runs `security-extended` queries over the API, the
  frontend apps and the shared packages on pulls requests and pushes to `main`,
  plus a weekly sweep, filing code-scanning alerts rather than failing the build.
  Pull requests from forks are skipped (a fork's token cannot be granted
  `security-events: write`), and the Soroban contracts are out of scope for CodeQL
  — they stay covered by the Rust host suite and the live testnet flows.
- **Project governance is written down.** [`GOVERNANCE.md`](GOVERNANCE.md) records
  how decisions are made, how releases are cut and how a contributor becomes a
  maintainer; [`MAINTAINERS.md`](MAINTAINERS.md) lists who holds commit access
  and which paths need their review; [`.github/CODEOWNERS`](.github/CODEOWNERS)
  encodes that at the path level; and `CONTRIBUTING.md` now documents the
  Developer Certificate of Origin every commit must be signed off under.
- **Every package manifest declares its license.** All 19 `package.json` files
  (root, apps and packages) now carry `"license": "MIT"`, and the root manifest
  also carries `repository`, `homepage`, `bugs` and `author`, so SPDX/SBOM and
  license tooling sees the same MIT terms as the `LICENSE` file.

### Security

- **Ten known dependency advisories cleared, and `pnpm audit` is now a required
  CI gate.** The installed tree carried 10 vulnerabilities (2 critical, 7 high,
  1 low): `next` 16.3.0 (GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36 — both
  critical), `multer` 2.2.0 — reached only through an **exact** pin in
  `@nestjs/platform-express` — with four advisories, `sharp` via `next`
  (GHSA-rgj7-g3m4-5g8c), and the dev-only `js-yaml` (two majors,
  GHSA-2883-xcg3-v3hh) and `smol-toml` (GHSA-7w5x-hrqm-74c2) chains. The four
  frontends move to `next@^16.3.3` (16.3.5 resolves, which also raises its own
  `sharp` requirement to `^0.35.4`), and `multer`, `smol-toml` and both
  `js-yaml` majors are lifted through the `overrides` block in
  `pnpm-workspace.yaml` — the exact pins upstream make an override the only way
  to reach the patched releases. `pnpm audit --audit-level high` now reports no
  findings, and the CI step no longer sets `continue-on-error`, so a newly
  disclosed high or critical advisory fails the build instead of printing a
  warning.
- **The Railway deploy pins its CLI.** `npx -y @railway/cli@3` executed
  whatever the registry served inside a job holding `RAILWAY_TOKEN`; it is now
  pinned to `@railway/cli@3.23.0`.
- **The Chrome extension installs from a lockfile.** `apps/extension` sits
  outside the pnpm workspace, so CI and the release job ran a bare
  `npm install` — the one dependency graph in the repository that could float,
  in the job that attaches a published ZIP. It now has a committed
  `package-lock.json` (the root `.gitignore` rule that excluded lockfiles is
  negated for this path) and both workflows use `npm ci`.

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
- **The admin sidebar no longer advertises the project as mainnet-ready.** The
  version footer read "v0.1.0 · mainnet-ready scaffolding" while `README.md`,
  `SECURITY.md` and `docs/architecture.md` all state that nothing is deployed to
  Stellar mainnet and that mainnet readiness has not been reached. It now reads
  "v0.1.0 · Stellar testnet demo", and a test asserts that the footer never claims
  mainnet.
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
- The root `package.json` description no longer calls the project
  "production-ready" — nothing is deployed to Stellar mainnet, and the README
  and `SECURITY.md` already say so.
- **Workflow `permissions` are scoped per job.** `publish-extension.yml`,
  `pr-labeler.yml` and `update-badges.yml` declared their write scopes at the
  workflow level, which grants them to every job in the file — OpenSSF Scorecard's
  Token-Permissions check reads that as a broad grant. The scopes now sit on the
  single job that needs each one (`contents: read` is declared alongside, since
  specifying `permissions` sets every unlisted scope to `none`).

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
