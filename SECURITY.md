# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

We take the security of Azure StellarPay Hub seriously. Please **do not** open a
public GitHub issue for security vulnerabilities.

Report vulnerabilities privately by opening a **private security advisory**
(GitHub → Security → Report a vulnerability). That is the project's only intake
channel today, so a report never lands in a mailbox nobody reads; the same form
is the first contact link offered on the
[new-issue page](.github/ISSUE_TEMPLATE/config.yml). A report should include:

- A description of the vulnerability and its impact
- Steps to reproduce
- Affected components (app, package, contract, endpoint)

You should receive an acknowledgement within 72 hours and a detailed response
within one week.

> There is no dedicated security email address. Earlier revisions of this policy
> listed one on a domain that was never provisioned, which meant a report sent
> there went nowhere — a published contact that cannot be reached is worse than
> none, so it has been removed rather than left as a promise.

## Scope

The following are in scope:

- Smart contracts under `contracts/` (Soroban/Rust)
- Backend API under `apps/api`
- Frontend applications under `apps/web`, `apps/admin`, `apps/explorer`
- Shared packages under `packages/`
- CI/CD configuration under `.github/`

## Out of scope

- Stellar Core / Horizon infrastructure operated by third parties
- Wallets (Freighter, xBull, Albedo) - report directly to their maintainers

## Disclosure

We will credit researchers who report valid vulnerabilities in the release notes
(unless anonymity is requested) and will not pursue legal action for good-faith
research conducted in accordance with this policy.

---

# Threat Model

Status legend: **Implemented** (code exists) · **Tested** (automated coverage) ·
**Limitation** (known gap, tracked honestly) · **Requires audit** (external).

| #   | Threat                                                    | Attack                                                                                          | Protection                                                                                                                                                                                                                                                                                                         | Status                                                                                                                                                                                        |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fake payment                                              | Client claims "I paid 100" after sending 1; tampered XDR                                        | Signed-XDR intent verification before submit (amount/recipient/asset/memo) + on-chain confirmation via indexer/inbound from Stellar truth                                                                                                                                                                          | Implemented · Tested (SDK + submit-gate unit tests)                                                                                                                                           |
| 2   | Duplicate payment / replay                                | Same event, transaction, idempotency key or webhook delivered twice                             | `ChainEvent.eventId` unique, `Transaction.hash` unique, `Idempotency-Key` `@@unique([userId, key])`, atomic guarded state transitions, stable webhook `deliveryId`                                                                                                                                                 | Implemented · Tested (unit + tier-3 lifecycle)                                                                                                                                                |
| 3   | Unauthorized access to another user's payment (IDOR/BOLA) | Swap payment id in `GET/POST /payments/:id/…`                                                   | Every lookup is scoped `{ id, userId }` → returns 404 (no existence oracle)                                                                                                                                                                                                                                        | Implemented · Tested (tier-3 security spec)                                                                                                                                                   |
| 4   | Unauthorized admin action                                 | Call admin endpoints as a normal user                                                           | Global JWT guard + `@Roles('ADMIN')` RBAC (hierarchy-aware), enforced server-side                                                                                                                                                                                                                                  | Implemented · Tested (tier-3 security spec, 403)                                                                                                                                              |
| 5   | Cross-merchant data disclosure via webhooks               | One merchant's webhook receives another's payment data                                          | Webhook dispatch is owner-scoped to the paying merchant; events without an attributable merchant are never broadcast                                                                                                                                                                                               | Implemented · Tested (webhook unit suite)                                                                                                                                                     |
| 6   | Fake webhook / forged notification                        | Attacker POSTs a fake "payment received" to a merchant                                          | Webhooks are outbound-only (no inbound webhook endpoint); deliveries are HMAC-SHA256-signed with a per-merchant secret, retried with backoff                                                                                                                                                                       | Implemented (signature) · Tested (webhook suite) · Inbound ingest only accepts on-chain events the platform itself observed                                                                   |
| 7   | Expired/invalid auth                                      | Reuse revoked session, forge JWT                                                                | Short-lived access tokens + server-side session check on every request (revocation)                                                                                                                                                                                                                                | Implemented · Tested (tier-3 security spec)                                                                                                                                                   |
| 8   | Brute force / abuse                                       | Hammer auth or payment endpoints                                                                | Global rate limiter (100/min) + stricter auth limits (5–10/min)                                                                                                                                                                                                                                                    | Implemented · Tested (429 in tier-3 security spec)                                                                                                                                            |
| 9   | Payment manipulation at checkout                          | Underpay a fixed-amount link, pay a different recipient/asset                                   | Fixed-amount links ignore client amounts; checkout fetches server-authoritative details; expired links / closed invoices refused                                                                                                                                                                                   | Implemented · Tested (checkout unit suite)                                                                                                                                                    |
| 10  | Amount tampering on-chain                                 | Pay $1 to a merchant and expect a $100 credit                                                   | Inbound credit uses the real on-chain amount from Stellar (never the client); invoice matching verifies asset + exact amount                                                                                                                                                                                       | Implemented · Tested (inbound suite + live testnet probe)                                                                                                                                     |
| 11  | Contract abuse                                            | Non-admin calls `set_allowed`/`pause`; unlisted token via `send`                                | Admin functions call `stored.require_auth()` + equality (`Unauthorized`); `send`/`send_batch` call `from.require_auth()`; paused state and token allowlist revert                                                                                                                                                  | Implemented (admin `require_auth` is enforced in `lib.rs` but has **no dedicated non-admin test yet** — tracked gap) · Tested (payer auth, zero amount, allowlist, paused in Rust host tests) |
| 12  | Secret leakage                                            | Committed private key / seed                                                                    | `.env*` gitignored; tracked env files hold placeholders and public testnet contract addresses only; K8s uses `secretKeyRef`; CI runs zizmor + npm audit (blocking at `high`)                                                                                                                                       | Implemented · Scanned (repo grep) · Tested in CI                                                                                                                                              |
| 13  | Event loss / missed payment                               | Worker crash between chain success and DB write                                                 | Persistent Redis cursors + `ChainEvent` dedupe backstop + `SUBMITTED` rows re-polled by `getTransaction` until resolved                                                                                                                                                                                            | Implemented · Tested (indexer suite + tier-3)                                                                                                                                                 |
| 14  | CSRF against cookie-authenticated flows                   | Cross-site mutation                                                                             | Double-submit cookie CSRF guard; bearer-token requests are exempt (JWT CSRF-safe)                                                                                                                                                                                                                                  | Implemented · Partially tested (guard code review)                                                                                                                                            |
| 15  | Admin/DB credential exposure                              | Reaching Postgres/Redis externally                                                              | Credentials via env/K8s secrets only                                                                                                                                                                                                                                                                               | Implemented · **Requires audit** of deployment                                                                                                                                                |
| 16  | Rate-limit / abuse of checkout                            | Mass intent creation                                                                            | Global throttling applies; per-merchant abuse limits not yet tuned                                                                                                                                                                                                                                                 | Limitation                                                                                                                                                                                    |
| 17  | SSRF via merchant-controlled webhook URL                  | Register `http://169.254.169.254/…` (or a hostname resolving there) and harvest the signed POST | Webhook URLs must be http(s), FQDN, credential-free and non-private at registration, **and** every delivery re-checks the resolved DNS answer against loopback/private/link-local/CGNAT ranges (single-label and `*.svc`/`*.local`/`*.internal` hosts rejected); blocked targets are recorded once and not retried | Implemented · Tested (validation + webhook service unit suites)                                                                                                                               |

## Where each layer is enforced

- **API auth**: global `JwtAuthGuard` verifies the Bearer token and re-checks the
  session row is `ACTIVE`, unexpired, and matches the token subject on **every**
  request (revocation is immediate). `RolesGuard` enforces a role hierarchy
  (`USER < MERCHANT < SUPPORT < ADMIN`). The Socket.IO gateway applies the same
  authority at handshake time, so a revoked session or suspended account cannot
  open a realtime channel with a still-valid JWT.
- **Outbound webhooks**: owner-scoped dispatch, HMAC-SHA256 signed bodies, bounded
  request timeout, and an SSRF guard that re-resolves the target on every attempt.
- **Audit metadata**: request bodies are journaled with credentials (passwords,
  tokens, secrets, signatures) replaced by `[REDACTED]`, so the audit trail can
  never become a credential store.
- **Ownership**: payments/invoices/payment-links/webhooks services scope every
  lookup to the authenticated user or their merchant profile.
- **Payment truth**: success is only recorded from Stellar (submit result or the
  indexer observing the on-chain event/inbound payment), never from the client.
- **Contracts**: see `contracts/payment/README.md` for the authorization model
  (`require_auth` on senders, admin-gated allowlist/pause).

## Honest status (accurate as of 2026-09)

| Item                       | Status                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent security audit | **Not independently audited** — no third-party pentest has been performed                                                                                                                                                                                                                                                                                                                                 |
| Network                    | **Stellar Testnet** only; mainnet is **not deployed**                                                                                                                                                                                                                                                                                                                                                     |
| Contract admin keys        | Development/testnet configuration (deployer key on testnet)                                                                                                                                                                                                                                                                                                                                               |
| Mainnet readiness          | Not reached — requires contract + integration + E2E + security review first                                                                                                                                                                                                                                                                                                                               |
| Audit logging              | Implemented (request-level, best-effort): a global `AuditInterceptor` writes an `AuditLog` row per mutating API request that completes (actor, action, resource, IP, user-agent, body metadata); admin listing endpoint reads them; dedicated unit tests cover the write path and credential redaction. Not an independent audit trail — guard-rejected/non-HTTP work and response bodies aren't captured |
| Webhook inbound endpoints  | None — webhooks are outbound-only, which removes the forged-webhook receive surface                                                                                                                                                                                                                                                                                                                       |
| Admin console exposure     | Admin endpoints are RBAC-guarded, but the API is not yet behind an allow-list/WAF in all deployment targets                                                                                                                                                                                                                                                                                               |
| Redis                      | Used for cache/rate-limit/session/locks — no auth currently configured on the local dev Redis (network-isolated in docker-compose)                                                                                                                                                                                                                                                                        |

## Security test suites

- **Tier 1 (unit)**: XDR-intent verification, tamper rejection, duplicate/
  idempotency, owner-scoped webhook delivery, guarded transitions.
- **Tier 3 (integration, runs in CI)**: `apps/api/test/security.e2e-spec.ts` —
  unauthenticated 401, forged JWT 401, revoked-session 401, non-admin 403,
  IDOR 404, rate-limit 429. `payment-lifecycle.e2e-spec.ts` covers duplicate
  chain events.
- **Tier 2 (contracts)**: Rust host tests for payer auth, allowlist, pause,
  amounts in `contracts/payment/src/test.rs`.
- **CI**: zizmor (GitHub Actions) + `pnpm audit --audit-level high`. Both are
  **blocking**: a newly disclosed high or critical advisory, or a new zizmor
  finding, fails the build. The tree currently audits clean — the advisories that
  used to be reachable only through exact upstream pins (`multer` via
  `@nestjs/platform-express`, `smol-toml` via `nx`) are lifted by the `overrides`
  block in `pnpm-workspace.yaml`, and `next` is on a patched 16.3.x.

## Supply-chain checks (OpenSSF Scorecard)

[`.github/workflows/scorecard.yml`](.github/workflows/scorecard.yml) runs
[OpenSSF Scorecard](https://scorecard.dev/) on every push to `main`, weekly, and
whenever a branch protection rule changes. The score is public:
`https://scorecard.dev/viewer/?uri=github.com/azurespay/azure-stellar-pay-hub`.
It is a report, not a gate — the findings are listed here so the score can be read
against what the project has decided on purpose.

**Enforced in the repository** (checked, not merely intended):

| Check                  | State                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned dependencies    | every `uses:` is pinned to a commit SHA; `@railway/cli` is pinned to an exact version; the Chrome extension installs with `npm ci` against a committed lockfile                                                                                                             |
| Token permissions      | every workflow declares `permissions`, and write scopes are granted per **job** rather than per file                                                                                                                                                                        |
| Dangerous workflows    | no `pull_request_target` or `workflow_run`; no `${{ … }}` interpolation inside a `run:` block (untrusted values travel through `env:`)                                                                                                                                      |
| Static analysis (SAST) | [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) — CodeQL with `security-extended` over the TypeScript/JavaScript surface                                                                                                                                     |
| Dependency updates     | Dependabot, weekly, npm + Cargo                                                                                                                                                                                                                                             |
| Vulnerabilities        | `pnpm audit --audit-level high` is a **blocking** CI gate and currently reports none                                                                                                                                                                                        |
| License / packaging    | `LICENSE` (MIT), this policy, and `"license": "MIT"` in every package manifest                                                                                                                                                                                              |
| Commit provenance      | every commit in a pull request carries a DCO sign-off ([`.github/workflows/dco.yml`](.github/workflows/dco.yml))                                                                                                                                                            |
| Container images       | every `FROM` in `infrastructure/docker/*.Dockerfile` and every service in `docker-compose.yml` is pinned by tag **and** digest, and Dependabot's `docker` ecosystem (directory `/infrastructure/docker`) bumps them weekly — each pin was verified with `docker pull <ref>` |

**Accepted findings** — deliberately not "fixed":

| Check                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary-Artifacts                           | the pitch video, thumbnail and preview are tracked on purpose — they are a project deliverable, and the pipeline that regenerates them is documented in [`video/README.md`](video/README.md)                                                                                                                                                                                                                                                 |
| Fuzzing                                    | no fuzz target yet. The contracts are covered by the Rust host suite (116 entry-point tests) and the live testnet integration flows; adding `cargo-fuzz` targets is follow-up work                                                                                                                                                                                                                                                           |
| Signed-Releases                            | releases are not signed yet. Nothing is published to a package registry (every workspace is `private`), so signing has no consumer to protect yet                                                                                                                                                                                                                                                                                            |     | CII-Best-Practices | scores 0 until the project is registered with the OpenSSF Best Practices badge programme. The questionnaire is prepared criterion-by-criterion with evidence in [`docs/openssf-best-practices.md`](docs/openssf-best-practices.md); what remains is a maintainer's GitHub login at bestpractices.dev, which no automation token can perform |
| Branch-Protection / Code-Review / Webhooks | repository settings rather than tracked files; see [`GOVERNANCE.md`](GOVERNANCE.md) and [`.github/CODEOWNERS`](.github/CODEOWNERS) for the review policy they should encode                                                                                                                                                                                                                                                                  |
| Contributors                               | a single-maintainer project at this stage                                                                                                                                                                                                                                                                                                                                                                                                    |
| Kubernetes / workflow images               | the Dockerfiles and `docker-compose.yml` are digest-pinned, but the Kubernetes manifests and the CI `services:` blocks still name tags. The manifests' own images are overridden with the commit-SHA tag by `kustomize edit set image` at deploy time (so the deployed artefact is pinned by SHA), and the CI service images are not covered by any Dependabot ecosystem yet — pinning them without an updater would only move the staleness |
| Rust static analysis                       | CodeQL does not analyse Rust; the contracts rely on the Rust test suite and review                                                                                                                                                                                                                                                                                                                                                           |
