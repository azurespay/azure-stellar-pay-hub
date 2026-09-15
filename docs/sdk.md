---
title: SDK
description: Usage guide for @stellar-pay/sdk — the type-safe API client and Stellar transaction helpers.
---

# SDK

`@stellar-pay/sdk` is the single client used by all apps. It is fully typed and works in
browsers (the web app) and Node (the API, scripts, tests).

It is a **workspace package** (`"private": true`): it is consumed from this monorepo with
`"@stellar-pay/sdk": "workspace:*"` and is not published to npm. Build it with:

```bash
pnpm --filter @stellar-pay/sdk build
```

## The API base URL

The API is mounted under the global **`/api`** prefix (`apps/api/src/main.ts`). The client
builds request URLs as `` `${baseUrl}${path}` `` from paths like `/auth/challenge`, so
`baseUrl` must carry the prefix:

```ts
const api = new ApiClient({ baseUrl: 'http://localhost:4000/api' });
```

A bare origin sends every request to `/auth/challenge` instead of `/api/auth/challenge`
and 404s. Each app's `src/lib/api.ts` normalises its `NEXT_PUBLIC_API_URL` (adding the
prefix when absent, treating a blank variable as unset) — see
[`docs/vercel-deploy.md`](vercel-deploy.md).

## `ApiClient` — typed HTTP client

```ts
import { ApiClient, ApiClientError } from '@stellar-pay/sdk';

const api = new ApiClient({
  baseUrl: 'http://localhost:4000/api',
  getToken: () => token, // called per request, so refresh/rotation stays transparent
  onUnauthorized: () => clearTokens(), // fired on any 401
});

const { accessToken } = await api.auth.verify({
  publicKey,
  signature,
  message,
  nonce,
  provider: 'FREIGHTER',
});
token = accessToken;
const me = await api.users.me();
```

Options: `baseUrl` (required), `getToken`, `fetchImpl` (injectable for tests) and
`onUnauthorized`. Every request carries a 15 s `AbortSignal.timeout`; a timeout or an
unreachable API is thrown as an `ApiClientError` with `status: 0` and an explicit message,
so a dead backend is distinguishable from a rejected request. `request<T>({ method, path,
body, query })` is public for endpoints the namespaces do not cover.

Endpoints are grouped into namespaces:

| Namespace           | Methods                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`              | `challenge`, `verify`, `refresh`, `logout`, `sessions`, `revokeSession`                                                                                                                                   |
| `users`             | `me`, `updateProfile`, `preferences`, `updatePreferences`, `contacts`, `createContact`, `deleteContact`, `beneficiaries`, `createBeneficiary`, `devices`, `revokeDevice`                                  |
| `wallet`            | `balances`, `trustlines`, `addTrustline`, `removeTrustline`                                                                                                                                               |
| `payments`          | `create`, `list`, `get`, `receipt`, `request`, `simulate`, `scheduled`, `cancelScheduled`                                                                                                                 |
| `assets`            | `list`, `get`                                                                                                                                                                                             |
| `merchants`         | `register`, `me`, `update`, `products`, `createProduct`, `deleteProduct`, `invoices`, `createInvoice`, `paymentLinks`, `createPaymentLink`, `settlements`, `customers`, `posCheckout`                     |
| `checkout`          | `paymentLink`, `invoice`, `payLink`, `payInvoice` (public — no bearer token)                                                                                                                              |
| `admin`             | `dashboard`, `volume`, `users`, `merchants`, `transactions`, `auditLogs`, `assets`, `createAsset`, `notifications`, `settings`, `updateSetting`, `updateUserStatus`, `updateMerchantStatus`, `assignRole` |
| `escrows`           | `list`, `get`, `create`, `submit`, `release`, `refund`, `confirmRelease`, `confirmRefund`                                                                                                                 |
| `subscriptionPlans` | `list`, `create`, `submit`, `subscribe`                                                                                                                                                                   |
| `subscriptions`     | `list`, `submit`, `renew`, `confirmRenew`, `cancel`, `confirmCancel`                                                                                                                                      |
| `treasury`          | `operations`, `withdrawals`, `deposit`, `submitDeposit`, `proposeWithdrawal`, `submitProposal`                                                                                                            |
| `invoiceOnChain`    | `issue`, `submitIssue`, `cancel`, `submitCancel`, `pay`, `submitPay`                                                                                                                                      |
| `notifications`     | `list`, `markRead`, `markAllRead`                                                                                                                                                                         |

List endpoints return the API envelope `ApiResponse<T>` — `{ data, meta? }`, where `meta`
carries pagination. `ApiClientError` exposes `statusCode` and `message` (the API's own error
message when the body has one).

### Payments

`payments.create` takes the same body as `POST /api/payments` (see
[`docs/api.md`](api.md)) — a `type`, the source account, and one destination per
recipient (a split or batch payment is simply more than one):

```ts
const intent = await api.payments.create({
  type: 'SEND', // SEND · QR · PAYMENT_LINK · SCHEDULED · RECURRING · BATCH · SPLIT · INVOICE · CROSS_BORDER
  fromPublicKey: 'G…',
  destinations: [{ publicKey: 'G…', amount: '10' }],
  assetCode: 'XLM',
});

if (intent.kind === 'pending') {
  // intent.unsignedXdr is the pre-built, server-validated envelope.
  const signedXdr = await signTx(intent.unsignedXdr);

  // The API re-verifies the signed envelope (amount, recipient, asset, memo)
  // before submitting — see `verifySignedPaymentMatchesIntent` below.
  await api.request({ method: 'POST', path: `/payments/${intent.id}/submit`, body: { signedXdr } });
}
// `intent.kind === 'scheduled'` means the payment is registered for a future run
// and no XDR exists yet; list/cancel it through `payments.scheduled` /
// `payments.cancelScheduled`, and approve a due occurrence with
// `POST /api/payments/:id/approve`.
```

To make the create idempotent, pass the second argument:
`api.payments.create(body, { idempotencyKey: 'order-42' })`. The API stores the key
under a unique `(userId, idempotencyKey)` pair and returns the original payment on a
repeat instead of creating a second one; low-level callers can send the same header via
`api.request({ …, headers: { 'Idempotency-Key': 'order-42' } })`.

## `StellarNetwork` — Horizon + Soroban helpers

```ts
import { createStellarNetwork, StellarNetwork } from '@stellar-pay/sdk';

const network = new StellarNetwork({
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET, // from @stellar/stellar-sdk
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org', // needed by the contract route only
  requestTimeoutMs: 30_000, // default; applied to the Horizon + RPC clients
  retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 }, // optional partial override
});

StellarNetwork.forTestnet(); // shorthand for the testnet Horizon URL + passphrase
createStellarNetwork(config); // factory with the same arguments
```

| Method                                                                                                                          | Purpose                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getBalances(publicKey)`                                                                                                        | Native + issued balances for an account                                                                                                          |
| `getAccount(publicKey)`                                                                                                         | The account, or `null` when it does not exist yet                                                                                                |
| `buildPaymentTransaction(input)`                                                                                                | Base64 XDR for wallet signing (`from`, `to`, `amount`, asset, memo)                                                                              |
| `estimateFee(input)`                                                                                                            | Fee quote from Horizon `feeStats`, with warnings                                                                                                 |
| `verifySignedPaymentMatchesIntent(signedXdr, expected)`                                                                         | Signed-XDR gate: one payment op, exact stroop amount, recipient, asset + issuer, memo — returns `{ matches: false, reason }` instead of throwing |
| `buildTrustlineTransaction(input)`                                                                                              | Add/remove a trustline                                                                                                                           |
| `prepareContractCall` / `signContractCall` / `submitContractCall`                                                               | Soroban invoke → simulate → assemble → sign → submit                                                                                             |
| `buildSorobanSendTransaction` / `prepareSorobanSendTransaction` / `signSorobanSendTransaction` / `submitSorobanSendTransaction` | The `payment` contract's `send` route                                                                                                            |
| `submitSignedTransaction(signedXdr)`                                                                                            | Classic Horizon submission; a Soroban envelope fails fast with `SorobanSubmissionError` instead of leaking Horizon's 400                         |
| `isSorobanTransaction(signedXdr)`, `sorobanRpc()`, `sorobanTokenAddress(code, issuer)`                                          | Envelope inspection, the lazily-built RPC client, and SAC addresses                                                                              |
| `accountScVal` / `stringScVal` / `optionScVal` / `boolScVal`                                                                    | `xdr.ScVal` builders used by the contract helpers                                                                                                |

Soroban failures surface as `SorobanSubmissionError`, which carries the on-chain reason.

### Retry policy

Neither `Horizon.Server` nor the Soroban RPC client retries, so a single `429`, `5xx` or
dropped connection used to surface to the user as a failed payment. Every Horizon and
Soroban RPC round trip now goes through `packages/sdk/src/retry.ts`:

```ts
import { DEFAULT_STELLAR_RETRY, isRetryableStellarError, withRetry } from '@stellar-pay/sdk';

DEFAULT_STELLAR_RETRY; // { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 }
withRetry(() => fetchSomething(), DEFAULT_STELLAR_RETRY, { onRetry: log });
```

Three attempts by default, equal-jitter exponential backoff from 250 ms capped at 4 s.
Only transient failures repeat — `408`, `429`, `5xx`, and the errno/fetch transport codes.
A `4xx` and a transaction the network already rejected (`tx_bad_seq`, `op_no_destination`)
fail on the first attempt, because re-sending them can only reproduce the same answer.
Re-submission is idempotent by construction: the envelope carries the same sequence number,
so a duplicate can only be rejected, never applied twice — and the API keeps an
inconclusive submission `PENDING` for the event indexer, so a retry cannot manufacture a
false success. Set `retry: { maxAttempts: 1 }` to disable retrying.

## Wallet package

`@stellar-pay/wallet` provides the React context for connecting wallets:

```tsx
import { WalletProvider, useWallet } from '@stellar-pay/wallet';

function App() {
  return (
    <WalletProvider defaultNetwork="testnet" onConnected={linkToApi}>
      <Dashboard />
    </WalletProvider>
  );
}

function Dashboard() {
  const { connect, disconnect, publicKey, connected, signTx, signMessage } = useWallet();
  // …
}
```

`useWallet()` returns `{ provider, publicKey, network, connected, connecting, error,
preferredNetwork, connect, disconnect, signTx, signMessage, switchWallet }`.

Supported wallets: **Freighter**, **xBull**, **Albedo** — with automatic detection,
network switching, and reconnect from `localStorage`.
