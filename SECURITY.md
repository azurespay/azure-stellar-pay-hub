# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

We take the security of Azure StellarPay Hub seriously. Please **do not** open a
public GitHub issue for security vulnerabilities.

Report vulnerabilities privately by opening a **private security advisory**
(GitHub → Security → Report a vulnerability) or by emailing
`security@stellar-pay.dev` with:

- A description of the vulnerability and its impact
- Steps to reproduce
- Affected components (app, package, contract, endpoint)

You should receive an acknowledgement within 72 hours and a detailed response
within one week.

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

| #   | Threat                                                    | Attack                                                              | Protection                                                                                                                                                         | Status                                                                                                                                                                                        |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fake payment                                              | Client claims "I paid 100" after sending 1; tampered XDR            | Signed-XDR intent verification before submit (amount/recipient/asset/memo) + on-chain confirmation via indexer/inbound from Stellar truth                          | Implemented · Tested (SDK + submit-gate unit tests)                                                                                                                                           |
| 2   | Duplicate payment / replay                                | Same event, transaction, idempotency key or webhook delivered twice | `ChainEvent.eventId` unique, `Transaction.hash` unique, `Idempotency-Key` `@@unique([userId, key])`, atomic guarded state transitions, stable webhook `deliveryId` | Implemented · Tested (unit + tier-3 lifecycle)                                                                                                                                                |
| 3   | Unauthorized access to another user's payment (IDOR/BOLA) | Swap payment id in `GET/POST /payments/:id/…`                       | Every lookup is scoped `{ id, userId }` → returns 404 (no existence oracle)                                                                                        | Implemented · Tested (tier-3 security spec)                                                                                                                                                   |
| 4   | Unauthorized admin action                                 | Call admin endpoints as a normal user                               | Global JWT guard + `@Roles('ADMIN')` RBAC (hierarchy-aware), enforced server-side                                                                                  | Implemented · Tested (tier-3 security spec, 403)                                                                                                                                              |
| 5   | Cross-merchant data disclosure via webhooks               | One merchant's webhook receives another's payment data              | Webhook dispatch is owner-scoped to the paying merchant; events without an attributable merchant are never broadcast                                               | Implemented · Tested (webhook unit suite)                                                                                                                                                     |
| 6   | Fake webhook / forged notification                        | Attacker POSTs a fake "payment received" to a merchant              | Webhooks are outbound-only (no inbound webhook endpoint); deliveries are HMAC-SHA256-signed with a per-merchant secret, retried with backoff                       | Implemented (signature) · Tested (webhook suite) · Inbound ingest only accepts on-chain events the platform itself observed                                                                   |
| 7   | Expired/invalid auth                                      | Reuse revoked session, forge JWT                                    | Short-lived access tokens + server-side session check on every request (revocation)                                                                                | Implemented · Tested (tier-3 security spec)                                                                                                                                                   |
| 8   | Brute force / abuse                                       | Hammer auth or payment endpoints                                    | Global rate limiter (100/min) + stricter auth limits (5–10/min)                                                                                                    | Implemented · Tested (429 in tier-3 security spec)                                                                                                                                            |
| 9   | Payment manipulation at checkout                          | Underpay a fixed-amount link, pay a different recipient/asset       | Fixed-amount links ignore client amounts; checkout fetches server-authoritative details; expired links / closed invoices refused                                   | Implemented · Tested (checkout unit suite)                                                                                                                                                    |
| 10  | Amount tampering on-chain                                 | Pay $1 to a merchant and expect a $100 credit                       | Inbound credit uses the real on-chain amount from Stellar (never the client); invoice matching verifies asset + exact amount                                       | Implemented · Tested (inbound suite + live testnet probe)                                                                                                                                     |
| 11  | Contract abuse                                            | Non-admin calls `set_allowed`/`pause`; unlisted token via `send`    | Admin functions call `stored.require_auth()` + equality (`Unauthorized`); `send`/`send_batch` call `from.require_auth()`; paused state and token allowlist revert  | Implemented (admin `require_auth` is enforced in `lib.rs` but has **no dedicated non-admin test yet** — tracked gap) · Tested (payer auth, zero amount, allowlist, paused in Rust host tests) |
| 12  | Secret leakage                                            | Committed private key / seed                                        | `.env*` gitignored; tracked env files hold placeholders and public testnet contract addresses only; K8s uses `secretKeyRef`; CI runs zizmor + npm audit            | Implemented · Scanned (repo grep) · Tested in CI                                                                                                                                              |
| 13  | Event loss / missed payment                               | Worker crash between chain success and DB write                     | Persistent Redis cursors + `ChainEvent` dedupe backstop + `SUBMITTED` rows re-polled by `getTransaction` until resolved                                            | Implemented · Tested (indexer suite + tier-3)                                                                                                                                                 |
| 14  | CSRF against cookie-authenticated flows                   | Cross-site mutation                                                 | Double-submit cookie CSRF guard; bearer-token requests are exempt (JWT CSRF-safe)                                                                                  | Implemented · Partially tested (guard code review)                                                                                                                                            |
| 15  | Admin/DB credential exposure                              | Reaching Postgres/Redis externally                                  | Credentials via env/K8s secrets only                                                                                                                               | Implemented · **Requires audit** of deployment                                                                                                                                                |
| 16  | Rate-limit / abuse of checkout                            | Mass intent creation                                                | Global throttling applies; per-merchant abuse limits not yet tuned                                                                                                 | Limitation                                                                                                                                                                                    |

## Where each layer is enforced

- **API auth**: global `JwtAuthGuard` verifies the Bearer token and re-checks the
  session row is `ACTIVE`, unexpired, and matches the token subject on **every**
  request (revocation is immediate). `RolesGuard` enforces a role hierarchy
  (`USER < MERCHANT < SUPPORT < ADMIN`).
- **Ownership**: payments/invoices/payment-links/webhooks services scope every
  lookup to the authenticated user or their merchant profile.
- **Payment truth**: success is only recorded from Stellar (submit result or the
  indexer observing the on-chain event/inbound payment), never from the client.
- **Contracts**: see `contracts/payment/README.md` for the authorization model
  (`require_auth` on senders, admin-gated allowlist/pause).

## Honest status (accurate as of 2026-09)

| Item                       | Status                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent security audit | **Not independently audited** — no third-party pentest has been performed                                                                                                                                                                                                                                                                                      |
| Network                    | **Stellar Testnet** only; mainnet is **not deployed**                                                                                                                                                                                                                                                                                                          |
| Contract admin keys        | Development/testnet configuration (deployer key on testnet)                                                                                                                                                                                                                                                                                                    |
| Mainnet readiness          | Not reached — requires contract + integration + E2E + security review first                                                                                                                                                                                                                                                                                    |
| Audit logging              | Implemented (request-level, best-effort): a global `AuditInterceptor` writes an `AuditLog` row per mutating API request that completes (actor, action, resource, IP, user-agent, body metadata); admin listing endpoint reads them. Not an independent audit trail — guard-rejected/non-HTTP work and response bodies aren't captured, no dedicated unit tests |
| Webhook inbound endpoints  | None — webhooks are outbound-only, which removes the forged-webhook receive surface                                                                                                                                                                                                                                                                            |
| Admin console exposure     | Admin endpoints are RBAC-guarded, but the API is not yet behind an allow-list/WAF in all deployment targets                                                                                                                                                                                                                                                    |
| Redis                      | Used for cache/rate-limit/session/locks — no auth currently configured on the local dev Redis (network-isolated in docker-compose)                                                                                                                                                                                                                             |

## Security test suites

- **Tier 1 (unit)**: XDR-intent verification, tamper rejection, duplicate/
  idempotency, owner-scoped webhook delivery, guarded transitions.
- **Tier 3 (integration, runs in CI)**: `apps/api/test/security.e2e-spec.ts` —
  unauthenticated 401, forged JWT 401, revoked-session 401, non-admin 403,
  IDOR 404, rate-limit 429. `payment-lifecycle.e2e-spec.ts` covers duplicate
  chain events.
- **Tier 2 (contracts)**: Rust host tests for payer auth, allowlist, pause,
  amounts in `contracts/payment/src/test.rs`.
- **CI**: zizmor (GitHub Actions) + npm audit.
