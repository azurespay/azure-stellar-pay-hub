---
title: Database
description: Prisma schema overview — models, relationships, and indexes.
---

# Database

PostgreSQL via Prisma. The schema lives in `packages/database/prisma/schema.prisma` and is
shared by every app through `@stellar-pay/database`.

## Core models

```text
User ─┬─ Wallet (verified public keys, provider, network)
      ├─ UserPreference (currency, theme, notification prefs)
      ├─ Contact (address book) / Beneficiary (payout targets)
      ├─ Session (server-side revocable sessions) / Device
      ├─ ApiKey
      ├─ Trustline ─ Asset (code + issuer)
      ├─ Transaction (classic + contract sends)
      ├─ ScheduledPayment (one-off + recurring occurrences)
      ├─ Merchant ─┬─ Product
      │            ├─ Customer (buyer identity, optional invoice link)
      │            ├─ Invoice (optional Customer link)
      │            ├─ PaymentLink
      │            ├─ Settlement
      │            └─ Webhook ─ WebhookDelivery
      ├─ Notification
      ├─ Escrow (Soroban)
      ├─ SubscriptionPlan ─ Subscription (Soroban)
      ├─ TreasuryOperation / TreasuryWithdrawal (Soroban multisig)
      └─ AuditLog (who did what, when)

Role ─ RolePermission ─ Permission   (RBAC catalogue)
Setting                              (admin-editable key/value gates)
ChainEvent                           (on-chain event dedupe ledger)
```

## Highlights

- **Enums** — `UserRole`, `UserStatus`, `WalletProvider`, `WalletStatus`,
  `SessionStatus`, `TransactionStatus`, `TransactionDirection`, `AssetType`,
  `TrustlineStatus`, `MerchantStatus`, `ProductStatus`, `InvoiceStatus`,
  `PaymentLinkStatus`, `NotificationChannel`/`NotificationType`/`NotificationStatus`,
  plus the contract-lifecycle statuses `EscrowStatus`, `SubscriptionPlanStatus`,
  `SubscriptionStatus`, `TreasuryOperationStatus`, `TreasuryWithdrawalStatus`.
- **Indexes & constraints** — FKs and hot lookup columns are indexed, including
  `Transaction.(userId, toPublicKey, status, createdAt)`, `Session.(userId, expiresAt)`,
  `AuditLog.(userId, resource, createdAt)`, `WebhookDelivery.(status, nextRetryAt)` and
  `ChainEvent` (`eventId @unique`, `source`, `createdAt`). Uniqueness is what makes
  replay safe: `Transaction.hash`, `Transaction.(userId, idempotencyKey)`,
  `ChainEvent.eventId`, `PaymentLink.code`, `Invoice.number`, `Merchant.slug`,
  `Escrow.contractId`, `Invoice.onChainId`, and the contract ids on
  `SubscriptionPlan`/`Subscription`/`TreasuryWithdrawal`.
- **Money** — amounts are decimal _strings_ (`String`/`AmountString`), never floats and
  never Prisma `Decimal`: arithmetic goes through the stroop bigint helpers in
  `@stellar-pay/shared` (`toStroops`/`fromStroops`/`addAmounts`).
- **Lifecycle over soft-delete** — models carry `createdAt`/`updatedAt` and (where a
  record has a lifecycle) an explicit status enum. There is no `deletedAt` soft delete:
  status transitions are the source of truth and are advanced only by evidence
  (an on-chain event, an indexer observation, or a guarded atomic update).

## Workflow

```bash
pnpm db:generate   # build client from schema
pnpm db:push       # push schema to dev DB (no migration files)
pnpm db:migrate    # create + apply a migration
pnpm db:seed       # seed admin user, demo merchant, assets
pnpm db:studio     # Prisma Studio
```

The generated client (`packages/database/src/generated/prisma`) is **build output, not
source**: it is gitignored, and `prisma generate` runs in the database package's `build`
and `typecheck` scripts (and explicitly in CI before lint/typecheck/tests). Nothing else
should import from that path directly — always through `@stellar-pay/database`.

## Prisma CLI configuration

`packages/database/prisma.config.ts` is the single source of Prisma CLI configuration
(schema path, migrations directory, seed command). It replaces the
`package.json#prisma` field, which Prisma 7 removes — a config file takes precedence
over it, so the two must not drift.

Two things the config does explicitly, because **the CLI stops loading `.env` on its own
as soon as a config file exists** (it prints "Prisma config detected, skipping
environment variable loading"):

1. **Loads the environment** — `packages/database/.env` first, then the repo-root `.env`
   that `pnpm generate:env` writes. A variable that is already exported wins (dotenv
   never overrides), which is how CI injects `DATABASE_URL`.
2. **Pins paths to the config file's directory** (`__dirname`), so the `db:*` scripts
   behave the same when run from the package directory or the repo root.

`prisma.config.ts` is type-checked separately (`tsconfig.config.json`, wired into the
package's `typecheck` script) because the CLI transpiles it without type-checking.

## ERD generation

```bash
npx --yes prisma-erd-generator --schema packages/database/prisma/schema.prisma
```

produces `packages/database/ERD.svg` for visual review.
