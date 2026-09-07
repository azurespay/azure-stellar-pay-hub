# @stellar-pay/api

NestJS backend for Azure StellarPay Hub.

## Modules

- **auth** – wallet challenge/verify (Freighter, xBull, Albedo), JWT + refresh
  tokens, sessions & device management, admin login
- **wallet** – link wallets, balances, trustlines (changeTrust)
- **users** – profiles, contacts/address book, beneficiaries, preferences
- **payments** – send/batch/split/scheduled/recurring, simulation, receipts,
  payment requests & QR payloads, payment history
- **assets** – asset discovery & metadata
- **merchants / invoices / payment-links** – onboarding, products, checkout
- **checkout** – public hosted checkout for payment links & invoices
- **notifications** – in-app (DB + WebSocket), email, SMS, push, webhook
- **webhooks** – merchant webhook registration + HMAC-signed delivery/retry
- **analytics** – volume, success rates, top merchants, cross-border metrics
- **admin** – user/merchant/asset management, audit-log listing, settings, RBAC
- **realtime** – Socket.IO gateway for live payment/notification events
- **scheduler** – timers for scheduled/recurring payments, renewals, retries

## Development

```bash
pnpm install
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis
pnpm db:push && pnpm db:seed
pnpm dev:api
```

The API validates every input with Zod schemas from `@stellar-pay/validation`
and writes an `AuditLog` row for every mutating request that completes via the
global `AuditInterceptor` (best-effort; failures are logged, not thrown).
See `docs/architecture.md` for the exact semantics and limitations.
