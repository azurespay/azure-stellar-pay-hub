---
title: API Reference
description: REST endpoints, authentication, and WebSocket events of the NestJS API.
---

# API Reference

Base URL: `http://localhost:4000` (hosted: your Railway URL). Every route is
served under the global **`/api`** prefix, e.g. the payments list is
`GET http://localhost:4000/api/payments/history`. All request/response bodies
are JSON. This document is generated from the implemented controllers — if a
route is not listed here it does not exist.

## Authentication

Wallet-based auth (no passwords). Flow:

1. `POST /auth/challenge` `{ publicKey }` → `{ nonce, message, expiresAt }`.
   The message is `stellar-pay:auth:<publicKey>:<nonce>`; rate-limited to
   10/min/IP.
2. Sign the message in the wallet (Freighter/xBull/Albedo).
3. `POST /auth/verify` → JWT access + refresh tokens.

| Method | Path                 | Auth                  | Notes                                                                              |
| ------ | -------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/auth/challenge`    | public (rate-limited) | Issue a signable challenge                                                         |
| POST   | `/auth/verify`       | public (rate-limited) | Verify Ed25519 signature → `{ accessToken, refreshToken, expiresInSeconds, user }` |
| POST   | `/auth/refresh`      | public (rate-limited) | `{ refreshToken }` → new access token. Rejects revoked/expired sessions            |
| POST   | `/auth/admin/login`  | public (rate-limited) | `{ email, password }` → same shape (ADMIN/SUPPORT accounts)                        |
| POST   | `/auth/logout`       | ✓                     | Revokes the current session → `204`                                                |
| GET    | `/auth/sessions`     | ✓                     | List the user's sessions                                                           |
| DELETE | `/auth/sessions/:id` | ✓                     | Revoke a session                                                                   |
| GET    | `/auth/devices`      | ✓                     | List devices                                                                       |
| DELETE | `/auth/devices/:id`  | ✓                     | Revoke a device and its sessions                                                   |

Send `Authorization: Bearer <accessToken>` on every protected route. Every
request re-checks the user's **current database role and status** (a suspended
account is rejected immediately; role changes apply without waiting for token
expiry) and, when a `sessionId` is present, that the session is still ACTIVE.

### `POST /auth/verify` request shape

```json
{
  "publicKey": "G…",
  "signature": "<hex or base64 ed25519 signature>",
  "message": "stellar-pay:auth:G…:<nonce>",
  "nonce": "<nonce returned by challenge>",
  "provider": "FREIGHTER",
  "deviceName": "My browser (optional)"
}
```

## Health & metrics

| Method | Path                | Auth   | Notes                                                         |
| ------ | ------------------- | ------ | ------------------------------------------------------------- |
| GET    | `/api/health`       | public | Liveness; reports Postgres reachability                       |
| GET    | `/api/health/ready` | public | 200 only when Postgres **and** Redis respond, else 503        |
| GET    | `/api/metrics`      | public | Prometheus text format; **404 unless `METRICS_ENABLED=true`** |

## Payments

`POST /payments` accepts an optional `Idempotency-Key` header — a retried
request returns the original intent (including the exact unsigned XDR) instead
of creating a second payment.

| Method | Path                           | Auth | Description                                                                                                                                                          |
| ------ | ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/payments`                    | ✓    | Create a payment intent → `{ kind, id, unsignedXdr, message }` (or `{ kind: 'scheduled', id }` for SCHEDULED/RECURRING)                                              |
| POST   | `/payments/simulate`           | ✓    | Fee estimate for an intent                                                                                                                                           |
| POST   | `/payments/request`            | ✓    | Build a `web+stellar:pay` URI + QR payload                                                                                                                           |
| POST   | `/payments/cross-border/quote` | ✓    | FX quote (demo rates — see Known limitations)                                                                                                                        |
| POST   | `/payments/:id/submit`         | ✓    | Submit a wallet-signed XDR (`{ signedXdr }`). Verifies the signed XDR against the recorded intent (amount/recipient/asset/memo) before sending anything              |
| POST   | `/payments/:id/approve`        | ✓    | Build a signable XDR for a scheduler-created scheduled/recurring occurrence                                                                                          |
| GET    | `/payments/history`            | ✓    | Paginated history (`page`, `pageSize`, `status`, `direction`, `assetCode`)                                                                                           |
| GET    | `/payments/scheduled`          | ✓    | Scheduled/recurring plans                                                                                                                                            |
| DELETE | `/payments/scheduled/:id`      | ✓    | Cancel a plan                                                                                                                                                        |
| GET    | `/payments/:id`                | ✓    | Payment detail (owner-scoped)                                                                                                                                        |
| GET    | `/payments/:id/receipt`        | ✓    | IPFS receipt: `{ ipfsCid, url, pinned, receipt? }`. When no pinning backend is reachable the payload is returned inline with `pinned:false` (never a fabricated URL) |

**Intent kinds** (`POST /payments` body): `SEND`, `QR`, `PAYMENT_LINK`,
`SCHEDULED`, `RECURRING`, `BATCH`, `SPLIT`, `INVOICE`, `CROSS_BORDER`,
`ESCROW`, `SUBSCRIPTION`. Every kind uses the same core body:

```json
{
  "type": "SEND",
  "fromPublicKey": "G…",
  "destinations": [{ "publicKey": "G…", "amount": "10", "memo": "optional" }],
  "assetCode": "XLM",
  "assetIssuer": null,
  "memo": "optional invoice ref",
  "memoType": "text",
  "scheduledFor": "2026-09-10T00:00:00.000Z",
  "recurring": { "interval": "daily", "count": 12 }
}
```

> A memo without `memoType` is treated as a **text memo** everywhere — the
> unsigned XDR the wallet signs always contains the memo the submit gate
> verifies.

**Statuses:** `PENDING` → `SUBMITTED` (claim is atomic; only one request can
reach the network) → `SUCCEEDED` (classic) or `CONFIRMED` (Soroban route, set
by the event indexer from the ledger). Transport failures revert `SUBMITTED →
PENDING` for retry; a definitive network rejection persists `FAILED`.

## Wallets, trustlines & assets

| Method | Path                            | Auth   | Description                                                       |
| ------ | ------------------------------- | ------ | ----------------------------------------------------------------- |
| GET    | `/wallet/:publicKey/balances`   | ✓      | Live balances (Horizon); DB fallback when Horizon is unreachable  |
| GET    | `/wallet/:publicKey/trustlines` | ✓      | Stored trustlines                                                 |
| POST   | `/wallet/trustlines`            | ✓      | `{ assetCode, assetIssuer, limit? }` → unsigned `changeTrust` XDR |
| DELETE | `/wallet/trustlines`            | ✓      | Same, `limit 0` (remove)                                          |
| GET    | `/assets`                       | public | Enabled assets                                                    |
| GET    | `/assets/:code`                 | public | Asset by code                                                     |

The wallet public key must belong to the authenticated user
(`assertWalletOwnership`) for payment creation and trustline operations.

## Transactions & explorer

These are intentionally public (power the explorer).

| Method | Path                       | Auth   | Description                                                                           |
| ------ | -------------------------- | ------ | ------------------------------------------------------------------------------------- |
| GET    | `/transactions`            | public | Paginated platform transactions (`page`, `pageSize`, `status`, `assetCode`, `search`) |
| GET    | `/transactions/stats`      | public | Counts + success stats (null when there is no data)                                   |
| GET    | `/transactions/hash/:hash` | public | Lookup by transaction hash                                                            |
| GET    | `/transactions/:id`        | public | Lookup by id                                                                          |

## Merchants, products, invoices, payment links

Merchant resources require the caller to own a merchant profile with status
**ACTIVE** (suspension/rejection and pre-approval are enforced on every call).

| Method | Path                                | Auth | Description                                                                  |
| ------ | ----------------------------------- | ---- | ---------------------------------------------------------------------------- |
| POST   | `/merchants`                        | ✓    | Register (status PENDING, user elevated to MERCHANT)                         |
| GET    | `/merchants/me`                     | ✓    | Own profile (viewable while PENDING; locked when SUSPENDED/REJECTED)         |
| PATCH  | `/merchants/me`                     | ✓    | Update profile                                                               |
| GET    | `/merchants/me/products`            | ✓    | Product catalog                                                              |
| POST   | `/merchants/me/products`            | ✓    | Create a product                                                             |
| DELETE | `/merchants/me/products/:id`        | ✓    | Delete a product                                                             |
| GET    | `/merchants/me/invoices`            | ✓    | List invoices                                                                |
| GET    | `/merchants/me/payment-links`       | ✓    | List payment links                                                           |
| GET    | `/merchants/me/settlements`         | ✓    | List settlements                                                             |
| GET    | `/merchants/me/customers`           | ✓    | List customers                                                               |
| POST   | `/merchants/me/pos-checkout`        | ✓    | Sum products or a custom amount → payment URI + QR                           |
| POST   | `/merchants/me/invoices`            | ✓    | Create an invoice (`items[]`, customer optional); amount computed from items |
| POST   | `/merchants/me/invoices/:id/cancel` | ✓    | Cancel an invoice                                                            |
| POST   | `/merchants/me/payment-links`       | ✓    | Create a payment link (`fixedAmount`, `expiresAt`, …)                        |
| GET    | `/webhooks`                         | ✓    | List webhook endpoints                                                       |
| POST   | `/webhooks`                         | ✓    | Register/update `{ url, events[], secret? }`                                 |
| DELETE | `/webhooks/:id`                     | ✓    | Remove a webhook                                                             |

## Checkout (public hosted pages)

Public and CSRF-exempt by design: these routes authenticate nothing (a payer
without an account), create only a PENDING intent the payer must still sign,
and submission is bound to the exact recorded amount/recipient/asset/memo.
Rate-limited to 30/min/IP.

| Method | Path                                | Description                                                                                  |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/checkout/payment-link/:code`      | Public link data (refuses expired/inactive links)                                            |
| GET    | `/checkout/invoice/:number`         | Public invoice data                                                                          |
| POST   | `/checkout/payment-link/:code/pay`  | `{ publicKey, amount? }` → intent + unsigned XDR. Fixed-amount links ignore customer amounts |
| POST   | `/checkout/invoice/:number/pay`     | `{ publicKey }` → intent + unsigned XDR (refuses non-open invoices)                          |
| POST   | `/checkout/transactions/:id/submit` | `{ signedXdr }` — same anti-manipulation gate as `/payments/:id/submit`                      |

## Users & notifications

| Method | Path                      | Auth | Description                       |
| ------ | ------------------------- | ---- | --------------------------------- |
| GET    | `/users/me`               | ✓    | Profile                           |
| PATCH  | `/users/me`               | ✓    | Update profile                    |
| GET    | `/users/me/preferences`   | ✓    | Preferences                       |
| PUT    | `/users/me/preferences`   | ✓    | Update preferences                |
| GET    | `/users/me/contacts`      | ✓    | Contacts (paged)                  |
| POST   | `/users/me/contacts`      | ✓    | Add a contact                     |
| DELETE | `/users/me/contacts/:id`  | ✓    | Remove a contact                  |
| GET    | `/users/me/beneficiaries` | ✓    | Beneficiaries                     |
| POST   | `/users/me/beneficiaries` | ✓    | Add a beneficiary                 |
| GET    | `/notifications`          | ✓    | In-app notification inbox (paged) |
| POST   | `/notifications/:id/read` | ✓    | Mark read                         |
| POST   | `/notifications/read-all` | ✓    | Mark all read                     |

## Admin (RBAC)

All admin routes require the `ADMIN` role (role is re-read from the database on
every request, so a demotion applies immediately). Analytics additionally
allows `SUPPORT`.

| Method | Path                              | Description                                                    |
| ------ | --------------------------------- | -------------------------------------------------------------- |
| GET    | `/admin/users`                    | Users (`page`, `pageSize`, `search`)                           |
| PATCH  | `/admin/users/:id/status`         | Suspend/activate a user (`{ status, reason? }`)                |
| POST   | `/admin/roles`                    | Assign a role `{ userId, role }`                               |
| GET    | `/admin/merchants`                | Merchants                                                      |
| PATCH  | `/admin/merchants/:id/status`     | Approve/suspend a merchant                                     |
| GET    | `/admin/transactions`             | All transactions (`status`)                                    |
| GET    | `/admin/audit-logs`               | Audit log (mutating requests, best-effort)                     |
| GET    | `/admin/assets`                   | Asset registry                                                 |
| POST   | `/admin/assets`                   | Create an asset                                                |
| GET    | `/admin/notifications`            | All notifications                                              |
| GET    | `/admin/settings`                 | Settings (keys incl. `maintenance_mode`, `min_payment_amount`) |
| PUT    | `/admin/settings`                 | Upsert a setting `{ key, value }`                              |
| GET    | `/admin/analytics/dashboard`      | KPIs + per-asset volume + top merchants                        |
| GET    | `/admin/analytics/volume?range=7d | 30d                                                            | 90d` | Daily volume series |

> Volume/revenue figures are aggregated **per asset** (`volumeByAsset`); a
> single scalar is only reported when one asset is present — mixed-asset totals
> are never mislabeled as a single currency. `paymentSuccessRate` is `null`
> (not a fabricated 100%) when there is no data.

## Webhooks (outbound)

Merchants register endpoints with the events they care about
(`payment.received`, `payment.failed`, `invoice.paid`,
`settlement.completed`, `customer.created`). Deliveries are:

- **Owner-scoped** — a merchant only ever receives its own payment data.
- **Signed** — each POST carries `x-stellar-pay-signature: HMAC-SHA256(secret, body)`.
- **Exactly-deduplicable** — the payload embeds a stable `deliveryId`; retries
  re-attempt the same delivery row and body.
- **Retried** by the scheduler with backoff (max 5 attempts) when the endpoint
  is down.

## WebSocket events (realtime)

Connect to the Socket.IO `/realtime` namespace (engine path `/socket.io`) with
`auth: { token: <accessToken> }`. Each user joins a private room `user:<id>`.
Fan-out uses the **Redis Socket.IO adapter**, so events work across API
instances.

```
notification          the full notification record
transaction.updated   { id, status }  // SUBMITTED | SUCCEEDED | FAILED | CONFIRMED
payment.received      { transactionId, status: 'CONFIRMED', fromPublicKey, toPublicKey, amount, assetCode, source }
```

## Errors

Every error uses Nest's envelope; unknown errors are normalized to a safe 500:

```json
{
  "statusCode": 400,
  "message": "Request validation failed",
  "details": { "fieldErrors": { "amount": ["Required"] } }
}
```

Codes: `400` validation/bad request · `401` missing/invalid token or inactive
account · `403` role/status forbidden · `404` not found (owner-scoped routes
return 404 — no existence oracle) · `409` conflict · `429` rate limited
(Rate-Limit headers are set) · `500` internal.

## Validation, rate limits & CSRF

- **Every input** is validated with Zod before it reaches a service
  (body/query/params pipes).
- **Rate limits** are global (100 req/min/IP by default), tighter on auth
  (5-10/min) and public checkout (30/min), and are stored in **Redis** so they
  hold across API instances.
- **CSRF:** the API authenticates with Bearer tokens (never cookies), so
  authenticated and wallet-signed flows are CSRF-safe by construction. The
  double-submit-cookie guard covers any unauthenticated mutating endpoints
  that are not explicitly CSRF-bypassed; the public checkout surface is
  CSRF-bypassed and instead relies on wallet signatures + rate limits (see
  Checkout).
