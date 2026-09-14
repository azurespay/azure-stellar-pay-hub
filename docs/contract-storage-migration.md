---
title: Contract storage migration — per-key entries & TTL budgets
description: Why the six Soroban contracts moved off instance-storage Maps, what the new interfaces are, and how to redeploy.
---

# Contract storage migration — per-key entries & TTL budgets

This document records the storage redesign prompted by the
[2026-09-14 clean-room audit](audit-2026-09-14.md), which flagged three
contract-level blockers: unbounded instance-storage `Map` collections, an
escrow that could lock funds forever, and a uniform short TTL with no restore
path. All three are addressed in the current source.

**This is a storage-format change, so it requires a fresh deployment.** The
existing testnet contract instances keep the old layout; the addresses deployed
on 2026-08-10 (see [`testnet-deploy.md`](testnet-deploy.md)) predate it.

- [What changed](#what-changed)
- [Old vs new layout](#old-vs-new-layout)
- [Entry-point changes](#entry-point-changes)
- [TTL budgets](#ttl-budgets)
- [Restore helpers](#restore-helpers)
- [Migration procedure](#migration-procedure)
- [Rollback](#rollback)
- [Verification](#verification)

---

## What changed

Every collection moved out of a single instance-storage entry and into **one
persistent entry per record**, and every collection gained a **paginated
listing** entry point. Previously a single call — approve one withdrawal,
renew one subscription, issue one invoice — deserialised and rewrote the whole
collection, and the list functions returned the entire id set in one response.
Cost and ledger-entry size therefore grew linearly with the number of records,
and could exceed Soroban's per-entry and instruction limits.

Two O(n) scans hidden inside ordinary writes were also removed:

| Where                      | Before                                                                       | After                                                       |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `subscriptions::subscribe` | iterated **every subscription in the contract** to reject a duplicate signup | one indexed lookup on `ActiveSub(plan, subscriber)`         |
| `invoices::create`         | appended to a per-merchant `Vec<u64>` that grew without bound                | one key per index position + an explicit per-merchant count |

## Old vs new layout

Ids remain **monotonic from 1 and are never reused**, so a paginated listing
needs no secondary index: a caller simply walks the id range. That is what keeps
`list_ids(start, limit)` O(page) rather than O(collection).

| Contract        | Old (all instance storage)                                  | New                                                                                                    |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `payment`       | `Admin`, `Paused`, `Allowed(token)`                         | `Admin`, `Paused` in instance; **`Allowed(token)` persistent**                                         |
| `escrow`        | `Map<u64, Escrow>` under `Escrows`                          | `Escrow(id)` persistent                                                                                |
| `treasury`      | `Map<u64, WithdrawalProposal>` under `Withdrawals`          | `Withdrawal(id)` persistent; `Allowed(token)` / `MaxWithdrawal(token)` persistent                      |
| `subscriptions` | `Map<u64, Plan>`, `Map<u64, Subscription>`                  | `Plan(id)`, `Subscription(id)`, `ActiveSub(plan, subscriber)` persistent                               |
| `invoices`      | `Map<u64, Invoice>`, `Map<Address, Vec<u64>>`               | `Invoice(id)`, `MerchantInvoiceIndex(merchant, position)`, `MerchantInvoiceCount(merchant)` persistent |
| `merchant`      | `Map<u64, MerchantProfile>`, `Map<u64, Map<Address, i128>>` | `Merchant(id)`, `Balance(id, token)` persistent                                                        |

Instance storage now holds only small, bounded state: the admin, pause flag, id
counters, and (in `treasury`) the governance member list and threshold.

### Escrow refund window

`create(..., expiry: None)` used to store `expiry = u64::MAX`, and `refund`
requires `now > expiry` once `release_time` has passed — so if the counterparty
never released, the initiator could never reclaim. Funds were locked forever.

An escrow created without an explicit expiry now gets
`expiry = release_time + DEFAULT_REFUND_WINDOW` (30 days). The counterparty keeps
the exclusive release right for the whole window, and after it the initiator can
always refund. An explicit `expiry` still overrides the default, and a refund
before `release_time` is unchanged.

## Entry-point changes

Breaking for any caller of the old interfaces (the platform itself is unaffected
— see [Migration procedure](#migration-procedure)):

| Contract        | Removed                 | Added                                                                                                                                                                                                                      |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow`        | `all_ids()`             | `count()`, `list_ids(start, limit)`, `list(start, limit)`, `bump_instance_ttl()`, `bump_escrow_ttl(id)`                                                                                                                    |
| `payment`       | —                       | `bump_instance_ttl()`, `bump_token_ttl(token)`                                                                                                                                                                             |
| `treasury`      | —                       | `count_withdrawals()`, `list_withdrawal_ids(start, limit)`, `bump_instance_ttl()`, `bump_withdrawal_ttl(id)`, `bump_token_ttl(token)`                                                                                      |
| `subscriptions` | —                       | `is_subscribed(plan, subscriber)`, `count_plans()`, `count_subscriptions()`, `list_plan_ids(start, limit)`, `list_subscription_ids(start, limit)`, `bump_instance_ttl()`, `bump_plan_ttl(id)`, `bump_subscription_ttl(id)` |
| `invoices`      | `invoices_of(merchant)` | `count()`, `list_ids(start, limit)`, `invoices_of(merchant, start, limit)`, `invoices_of_count(merchant)`, `bump_instance_ttl()`, `bump_invoice_ttl(id)`, `bump_merchant_index_ttl(merchant, start, limit)`                |
| `merchant`      | —                       | `count()`, `list_ids(start, limit)`, `list(start, limit)`, `bump_instance_ttl()`, `bump_merchant_ttl(id)`, `bump_balance_ttl(id, token)`                                                                                   |

`invoices_of` keeps its old name but takes a 1-based **position** in the
merchant's history plus a page size, not just the merchant:

```rust
// Before — returns every invoice id the merchant ever issued.
let ids = client.invoices_of(&merchant);

// After — page 1, up to 50 ids; bounded work, bounded response.
let total = client.invoices_of_count(&merchant);
let ids = client.invoices_of(&merchant, &1, &50);
```

Every listing clamps its page size to `MAX_PAGE_SIZE` (100), so no single call
can be made to return an unbounded set.

### Behaviour change in `set_governance`

`set_governance` used to reset the withdrawal counter to 1 and replace the
proposals `Map` with an empty one — silently discarding every outstanding
proposal. Per-key entries cannot be enumerated for deletion, and reusing ids
would overwrite live proposals, so the counter is now seeded once and stays
monotonic across governance changes. Outstanding proposals survive a
reconfiguration. A test asserts ids keep advancing.

## TTL budgets

Every contract previously called `extend_ttl(5000, 5000)` on all paths — about
7 hours of ledgers — and because all state lived in the instance entry,
archival froze the whole contract.

Each contract now declares its own budget (ledgers close ~5 s, so 17 280 ≈ 1 day
and 518 400 ≈ 30 days):

| Storage                                             | Threshold | Extend to | Rationale                                          |
| --------------------------------------------------- | --------- | --------- | -------------------------------------------------- |
| Instance (admin, counters, governance)              | 17 280    | 518 400   | long-lived configuration                           |
| Record entries (escrow, invoice, plan, proposal, …) | 17 280    | 518 400   | must outlive the workflow, which may run for weeks |
| Held funds (`merchant::Balance`)                    | 17 280    | 518 400   | the contract still owes these tokens               |
| Allowlists / caps                                   | 17 280    | 518 400   | rarely written, read on every payment              |

Entries are bumped on **both read and write** ("touch on read"), so an actively
used contract or record never drifts toward archival. 518 400 ledgers is
deliberately inside the maximum entry TTL of every network, avoiding an
`extend_ttl` panic.

## Restore helpers

Each contract exposes **permissionless** maintenance entry points — none call
`require_auth`, so any account can pay the rent to keep a contract or a single
record alive. They are the restore path: reading a persistent entry puts it in
the invocation footprint, so the host restores an archived entry and the
`extend_ttl` that follows re-arms its budget.

| Contract        | Helpers                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `payment`       | `bump_instance_ttl`, `bump_token_ttl(token)`                                                   |
| `escrow`        | `bump_instance_ttl`, `bump_escrow_ttl(id)`                                                     |
| `treasury`      | `bump_instance_ttl`, `bump_withdrawal_ttl(id)`, `bump_token_ttl(token)`                        |
| `subscriptions` | `bump_instance_ttl`, `bump_plan_ttl(id)`, `bump_subscription_ttl(id)`                          |
| `invoices`      | `bump_instance_ttl`, `bump_invoice_ttl(id)`, `bump_merchant_index_ttl(merchant, start, limit)` |
| `merchant`      | `bump_instance_ttl`, `bump_merchant_ttl(id)`, `bump_balance_ttl(id, token)`                    |

Helpers that take an id return the contract's `NotFound`-style error when the id
was never used (or, for `merchant::bump_balance_ttl`, `NoBalance` when nothing is
held), so an operator can distinguish "nothing to restore" from a failed call.

> A restore only succeeds if the ledger entry is included in the call's
> footprint. Soroban SDK clients resolve that from simulation, so calling the
> helper through `soroban contract invoke` or the SDK is the supported path.

## Migration procedure

**The platform's API is unaffected by the interface changes.** It never reads a
contract collection: it prepares and submits mutations (`create`, `create_plan`,
`propose_withdraw`, …) and derives state from the event indexer. Only the Rust
tests and these docs consumed the view functions. Verify this still holds before
deploying by grepping for the removed names:

```bash
rg 'all_ids|invoices_of\(' --glob '!contracts/**'
```

Redeploy:

```bash
# 1. Build and test the new revision
pnpm contracts:verify

# 2. Deploy to a fresh set of contract ids (stable per-contract salts make
#    re-runs idempotent, but a storage change needs new instances because the
#    layout is not readable by the old code)
export STELLAR_SECRET_KEY=S...
pnpm deploy:contracts         # writes .deployed-contracts.env

# 3. Initialize + allowlist on-chain
pnpm contracts:init

# 4. Point the API at the new ids and restart it
#    CONTRACT_STELLAR_PAY_PAYMENT / _ESCROW / _TREASURY / _SUBSCRIPTIONS
#    / _INVOICES / _MERCHANT  (from .deployed-contracts.env)

# 5. Re-establish off-chain state that mirrored on-chain ids
pnpm db:seed                  # demo data, if this is the demo environment

# 6. Re-run the live integration flows
node tests/e2e/contracts-flow.mjs
E2E_CONTRACT=1 node tests/e2e/auth-payment-flow.mjs
```

**There is no in-place data migration, by design.** The old state is only
reachable through the old code, and the previous instances were testnet demo
data (demo merchant registration, seeded escrows and invoices) rather than
production records. If a deployment did hold real state, the migration has to be
a read-old → write-new script: enumerate ids with the _old_ contract's
`all_ids()`/`Map` readers, then replay them against the new instance with the
same entry points (`register`, `create`, …) so the events and the indexer see
them. Because ids are assigned by the new contract, preserve the mapping in the
off-chain tables rather than assuming ids match.

Also update the addresses recorded in
[`testnet-deploy.md`](testnet-deploy.md) and any `CONTRACT_*` values in
`.env`/`.deployed-contracts.env` and the deployment platform.

## Rollback

The old contract instances are untouched by this change and keep serving the old
interface, so rollback is a configuration revert: restore the previous
`CONTRACT_STELLAR_PAY_*` values and restart the API. Because ids are assigned per
contract instance, records created against the new instance are not visible to
the old one — treat a rollback as abandoning (not merging) post-migration
records.

## Verification

`pnpm contracts:verify` runs the `wasm32v1-none` release build for all six
contracts and the Rust test suite. The suite grew from 76 to **116 tests**, with
new coverage per contract for:

- records living in persistent storage rather than an instance collection,
- paginated listings (first/last page, past-the-end, page-size clamp),
- the `subscriptions` duplicate index, including re-subscribing after cancel,
- `merchant` settling clearing the balance entry,
- `treasury` governance reconfiguration keeping proposal ids monotonic,
- the escrow default refund window, and
- every restore helper (permissionless success + unknown-target errors).

| Contract        | Tests   |
| --------------- | ------- |
| `payment`       | 16      |
| `escrow`        | 23      |
| `treasury`      | 25      |
| `subscriptions` | 11      |
| `invoices`      | 24      |
| `merchant`      | 17      |
| **Total**       | **116** |
