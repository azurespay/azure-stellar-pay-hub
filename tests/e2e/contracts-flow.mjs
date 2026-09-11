#!/usr/bin/env node
/**
 * E2E: Soroban contract integrations (escrow / treasury / invoices /
 * subscriptions) against a running API **and live Stellar testnet**.
 *
 * Each flow follows the platform's real lifecycle — prepare (simulate +
 * assemble) → wallet signs → submit via Soroban RPC → **event indexer
 * reconciles the DB row from on-chain evidence**:
 *
 *   1. Escrow:     create → FUNDED (indexed `created`) → release → RELEASED
 *   2. Treasury:   deposit → CONFIRMED (indexed `deposit`)
 *   3. Invoice:    issue on-chain (indexed `issued`) → pay (indexed `paid` → PAID)
 *   4. Merchant:   on-chain register (indexed `reg`) → plan create (indexed
 *                  `plan`) → subscribe (indexed `sub`) → record_sale +
 *                  settle (indexed `settle` → Settlement COMPLETED)
 *
 * The API must boot with every deployed contract address configured
 * (CONTRACT_STELLAR_PAY_*); without them the features return 503 and the
 * relevant flow reports as skipped/failed — never silently DB-only.
 *
 * Usage (boots the API itself against local Postgres + Redis):
 *   node tests/e2e/contracts-flow.mjs
 *
 * Or against an already-running API:
 *   API_URL=https://stellar-pay-api.up.railway.app/api node tests/e2e/contracts-flow.mjs
 */

import { Keypair, Networks } from '@stellar/stellar-sdk';
import { ApiClient, StellarNetwork } from '../../packages/sdk/dist/index.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
// Direct import of the generated Prisma client (the E2E harness may activate
// a fresh merchant row to ACTIVE — admin approval is out of scope here).
import { PrismaClient } from '../../packages/database/src/generated/prisma/client.js';

const INPUT_API_URL = process.env.API_URL ?? 'http://localhost:4000/api';
const BOOT_API = !process.env.API_URL;
const apiUrl = BOOT_API ? 'http://localhost:4100/api' : INPUT_API_URL.replace(/\/$/, '');

// The harness both boots the API and connects to Postgres directly (to activate
// the E2E merchant). Resolve the same local defaults into *this* process so
// `new PrismaClient()` works even when the caller has not exported DATABASE_URL
// — otherwise merchant activation throws and every merchant-gated flow (invoice,
// subscriptions, settlement) fails with "Merchant account is not active".
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.DATABASE_URL ??= DATABASE_URL;
process.env.REDIS_URL ??= REDIS_URL;

// ── Robust HTTP helpers ─────────────────────────────────────────────────────
//
// The SDK ApiClient already bounds its own requests (15s AbortSignal); these
// cover harness-level fetches (Friendbot, health) so a hung endpoint can never
// stall the run, and every failure reports a readable detail instead of a bare
// `err.message` (which is empty for many HTTP/Prisma errors).
const HTTP_TIMEOUT_MS = Number(process.env.E2E_HTTP_TIMEOUT_MS ?? 20_000);

async function fetchWithTimeout(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/** Readable failure detail — name, HTTP status, message, and cause. */
function describeError(err) {
  if (!err) return 'unknown error';
  const status = err.statusCode ? ` [HTTP ${err.statusCode}]` : '';
  const cause = err.cause ? ` (cause: ${err.cause?.message ?? err.cause})` : '';
  return `${err.name ?? 'Error'}${status}: ${err.message || String(err)}${cause}`;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function bootApi() {
  console.log('Booting API (contract integrations E2E)…');
  const child = spawn('pnpm', ['--filter', '@stellar-pay/api', 'start'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      API_PORT: '4100',
      NODE_ENV: 'development',
      JWT_SECRET: 'e2e-contracts-secret-16-chars',
      ADMIN_PASSWORD: 'E2eTest123!',
      WEBHOOK_SIGNING_SECRET: 'e2e-webhook-secret-16-chars',
      DATABASE_URL,
      REDIS_URL,
      STELLAR_NETWORK: 'testnet',
      SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
      PAYMENT_ROUTE: process.env.PAYMENT_ROUTE ?? 'classic',
      CONTRACT_STELLAR_PAY_PAYMENT:
        process.env.CONTRACT_STELLAR_PAY_PAYMENT ??
        'CBDOGRJIOX46MEHIYRGU7BFKLT2OOPT7QIN7ZU53DH5WK7FF5QK7IN4Q',
      CONTRACT_STELLAR_PAY_ESCROW:
        process.env.CONTRACT_STELLAR_PAY_ESCROW ??
        'CDWVUTCME6JSATWKKWIFVBEO4NAZSJCCX2ECNRQN3L33W65EFT3AMUEY',
      CONTRACT_STELLAR_PAY_INVOICES:
        process.env.CONTRACT_STELLAR_PAY_INVOICES ??
        'CB3XBXQUY4LHSFPWJ4XZL6T7A2ITNMBWMCTT2QOS6LB7PF7RPJBTVDHZ',
      CONTRACT_STELLAR_PAY_SUBSCRIPTIONS:
        process.env.CONTRACT_STELLAR_PAY_SUBSCRIPTIONS ??
        'CCMQF6EB5DT6HKWGOB5BTRMD6Q66D5MVBQQN5HOK3565WHATXINOLBNI',
      CONTRACT_STELLAR_PAY_TREASURY:
        process.env.CONTRACT_STELLAR_PAY_TREASURY ??
        'CCKWXDASGA7W3KWMEOEXYWMV5RVDLV2WGEJOHO3SYHKMXHZ3X4UWRMKZ',
      CONTRACT_STELLAR_PAY_MERCHANT:
        process.env.CONTRACT_STELLAR_PAY_MERCHANT ??
        'CDNQTYF4XSOPNY6ID6MHUROAC2BNIQTYWHJYVGXWMU5WFA5AOQGDQUEU',
    },
    shell: false,
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    await delay(1_000);
    try {
      const res = await fetchWithTimeout(`${apiUrl}/health`, {}, 5_000);
      if (res.ok) return child;
    } catch {
      /* booting */
    }
  }
  child.kill();
  throw new Error('API failed to start within 40s');
}

async function fundAccount(publicKey, label) {
  try {
    const fbResp = await fetchWithTimeout(`https://friendbot.stellar.org?addr=${publicKey}`);
    const fbData = await fbResp.json();
    check(
      `Friendbot funded ${label}`,
      fbData?.successful === true,
      fbData?.hash?.slice(0, 8) ?? '',
    );
    if (fbData?.successful) await delay(3_000);
    return fbData?.successful === true;
  } catch (err) {
    check(`Friendbot funded ${label}`, false, describeError(err));
    return false;
  }
}

async function authUser(client, keypair) {
  const challenge = await client.auth.challenge(keypair.publicKey());
  const signature = Buffer.from(keypair.sign(Buffer.from(challenge.message, 'utf8'))).toString(
    'hex',
  );
  const auth = await client.auth.verify({
    publicKey: keypair.publicKey(),
    signature,
    message: challenge.message,
    nonce: challenge.nonce,
    provider: 'FREIGHTER',
    deviceName: 'contracts-e2e',
  });
  return new ApiClient({ baseUrl: apiUrl, getToken: () => auth.accessToken });
}

/** Sign an assembled Soroban envelope (auth entries + envelope). */
async function signXdr(unsignedXdr, keypair) {
  const network = new StellarNetwork({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  });
  return network.signContractCall(unsignedXdr, keypair);
}

async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last) return last;
    await delay(5_000);
  }
  throw new Error(`Timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

async function run() {
  let child = null;
  if (BOOT_API) child = await bootApi();

  try {
    const health = await fetchWithTimeout(`${apiUrl}/health`).then((r) => r.json());
    check('API healthy', health?.status === 'ok');

    // Keypairs: initiator + counterparty (escrow), merchant, customer.
    const initiatorKp = Keypair.random();
    const counterpartyKp = Keypair.random();
    const merchantKp = Keypair.random();
    const customerKp = Keypair.random();

    const client = new ApiClient({ baseUrl: apiUrl });
    const initiator = await authUser(client, initiatorKp);
    const counterparty = await authUser(client, counterpartyKp);
    const merchantUser = await authUser(client, merchantKp);
    const customer = await authUser(client, customerKp);

    const funded = await fundAccount(initiatorKp.publicKey(), 'initiator');
    await fundAccount(counterpartyKp.publicKey(), 'counterparty');
    await fundAccount(merchantKp.publicKey(), 'merchant');
    await fundAccount(customerKp.publicKey(), 'customer');
    if (!funded) {
      console.error('  Friendbot unavailable — cannot run on-chain flows');
      return;
    }

    // ── Escrow: create → FUNDED → release → RELEASED ─────────────────────
    console.log('\n1. Escrow (create → fund → release)');
    try {
      // The contract rejects release until release_time passes (TooEarly) —
      // set the window comfortably in the future and wait for it after FUNDED.
      const releaseTimeMs = Date.now() + 60_000;
      const created = await initiator.request({
        method: 'POST',
        path: '/escrows',
        body: {
          initiatorPublicKey: initiatorKp.publicKey(),
          counterpartyPublicKey: counterpartyKp.publicKey(),
          assetCode: 'XLM',
          amount: '5',
          releaseTime: new Date(releaseTimeMs).toISOString(),
        },
      });
      check(
        'Escrow created (prepare)',
        !!created?.id && !!created?.unsignedXdr,
        `id=${created?.id?.slice(0, 8)}`,
      );
      const signed = await signXdr(created.unsignedXdr, initiatorKp);
      const submitted = await initiator.request({
        method: 'POST',
        path: `/escrows/${created.id}/submit`,
        body: { signedXdr: signed },
      });
      check(
        'Escrow create submitted',
        submitted?.status === 'SUBMITTED',
        `status=${submitted?.status}`,
      );
      const fundedEscrow = await poll(
        async () => {
          const e = await initiator.request({ method: 'GET', path: `/escrows/${created.id}` });
          return e?.status === 'FUNDED' ? e : null;
        },
        150_000,
        'escrow FUNDED (indexed `created`)',
      );
      check(
        'Escrow FUNDED on-chain (event indexer)',
        fundedEscrow?.status === 'FUNDED',
        `contractId=${fundedEscrow?.contractId}`,
      );

      // Wait for the release window to open (release_time passes on the ledger).
      const waitMs = releaseTimeMs - Date.now() + 15_000;
      if (waitMs > 0) {
        console.log(`  … waiting ${Math.ceil(waitMs / 1000)}s for the release window`);
        await delay(waitMs);
      }
      const releasePrepared = await counterparty.request({
        method: 'POST',
        path: `/escrows/${created.id}/release`,
        body: { callerPublicKey: counterpartyKp.publicKey() },
      });
      check('Release prepared (window open)', !!releasePrepared?.unsignedXdr);
      const signedRelease = await signXdr(releasePrepared.unsignedXdr, counterpartyKp);
      await counterparty.request({
        method: 'POST',
        path: `/escrows/${created.id}/release/confirm`,
        body: { signedXdr: signedRelease },
      });
      const released = await poll(
        async () => {
          const e = await initiator.request({ method: 'GET', path: `/escrows/${created.id}` });
          return e?.status === 'RELEASED' ? e : null;
        },
        150_000,
        'escrow RELEASED (indexed `released`)',
      );
      check(
        'Escrow RELEASED on-chain',
        released?.status === 'RELEASED',
        `hash=${released?.releaseHash?.slice(0, 8)}`,
      );
    } catch (err) {
      check('Escrow flow', false, describeError(err));
    }

    // ── Treasury: deposit → CONFIRMED ────────────────────────────────────
    console.log('\n2. Treasury deposit');
    try {
      const deposit = await initiator.request({
        method: 'POST',
        path: '/treasury/deposits',
        body: { fromPublicKey: initiatorKp.publicKey(), assetCode: 'XLM', amount: '2' },
      });
      check(
        'Deposit prepared',
        !!deposit?.id && !!deposit?.unsignedXdr,
        `id=${deposit?.id?.slice(0, 8)}`,
      );
      const signedDeposit = await signXdr(deposit.unsignedXdr, initiatorKp);
      await initiator.request({
        method: 'POST',
        path: `/treasury/deposits/${deposit.id}/submit`,
        body: { signedXdr: signedDeposit },
      });
      const confirmedDeposit = await poll(
        async () => {
          const ops = await initiator.request({ method: 'GET', path: '/treasury/operations' });
          const op = ops.find((o) => o.id === deposit.id);
          return op?.status === 'CONFIRMED' ? op : null;
        },
        150_000,
        'deposit CONFIRMED (indexed `deposit`)',
      );
      check(
        'Treasury deposit CONFIRMED on-chain',
        confirmedDeposit?.status === 'CONFIRMED',
        `hash=${confirmedDeposit?.hash?.slice(0, 8)}`,
      );
    } catch (err) {
      check('Treasury deposit flow', false, describeError(err));
    }

    // ── Invoice: create → issue on-chain → pay on-chain → PAID ───────────
    console.log('\n3. On-chain invoice (issue → pay)');
    try {
      const merchantReg = await merchantUser.request({
        method: 'POST',
        path: '/merchants',
        body: {
          name: 'E2E Contracts Merchant',
          slug: `e2e-contracts-${Date.now().toString(36)}`,
          settlementPublicKey: merchantKp.publicKey(),
          settlementAssetCode: 'XLM',
        },
      });
      check('Merchant registered (DB)', !!merchantReg?.id);
      // The on-chain invoice route requires an ACTIVE merchant — the E2E
      // harness activates the row directly (admin approval is out of scope).
      const prisma = new PrismaClient();
      await prisma.merchant.update({ where: { id: merchantReg.id }, data: { status: 'ACTIVE' } });
      await prisma.$disconnect();

      const invoice = await merchantUser.request({
        method: 'POST',
        path: '/merchants/me/invoices',
        body: {
          title: 'On-chain invoice E2E',
          items: [{ name: 'Service', quantity: 1, unitPrice: '3', currency: 'USD' }],
          assetCode: 'XLM',
          customerPublicKey: customerKp.publicKey(),
          dueDate: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      check('Invoice created (DB)', !!invoice?.id);

      const issued = await merchantUser.request({
        method: 'POST',
        path: `/merchants/me/invoices/${invoice.id}/issue-onchain`,
      });
      check('On-chain issue prepared', !!issued?.unsignedXdr);
      const signedIssue = await signXdr(issued.unsignedXdr, merchantKp);
      await merchantUser.request({
        method: 'POST',
        path: `/merchants/me/invoices/${invoice.id}/issue-onchain/submit`,
        body: { signedXdr: signedIssue },
      });
      const issuedInvoice = await poll(
        async () => {
          const list = await merchantUser.request({
            method: 'GET',
            path: '/merchants/me/invoices',
          });
          const row = list.find((i) => i.id === invoice.id);
          return row?.onChainId ? row : null;
        },
        150_000,
        'invoice onChainId (indexed `issued`)',
      );
      check(
        'Invoice issued on-chain',
        !!issuedInvoice?.onChainId,
        `onChainId=${issuedInvoice?.onChainId}`,
      );

      const payPrepared = await customer.request({
        method: 'POST',
        path: `/invoices/${invoice.id}/pay-onchain`,
        body: { payerPublicKey: customerKp.publicKey() },
      });
      check('On-chain pay prepared', !!payPrepared?.unsignedXdr);
      const signedPay = await signXdr(payPrepared.unsignedXdr, customerKp);
      await customer.request({
        method: 'POST',
        path: `/invoices/${invoice.id}/pay-onchain/confirm`,
        body: { signedXdr: signedPay },
      });
      const paidInvoice = await poll(
        async () => {
          const list = await merchantUser.request({
            method: 'GET',
            path: '/merchants/me/invoices',
          });
          const row = list.find((i) => i.id === invoice.id);
          return row?.status === 'PAID' ? row : null;
        },
        150_000,
        'invoice PAID (indexed `paid`)',
      );
      check('Invoice PAID on-chain (event indexer)', paidInvoice?.status === 'PAID');
    } catch (err) {
      check('Invoice flow', false, describeError(err));
    }

    // ── Merchant on-chain + subscriptions ────────────────────────────────
    console.log('\n4. Merchant on-chain register + subscription plan + sale/settle');
    try {
      const reg = await merchantUser.request({
        method: 'POST',
        path: '/merchants/me/onchain/register',
        body: {
          ownerPublicKey: merchantKp.publicKey(),
          name: 'E2E Contracts Merchant',
          settlementPublicKey: merchantKp.publicKey(),
          commissionBps: 100,
        },
      });
      check('Merchant register prepared', !!reg?.unsignedXdr);
      const signedReg = await signXdr(reg.unsignedXdr, merchantKp);
      await merchantUser.request({
        method: 'POST',
        path: '/merchants/me/onchain/register/submit',
        body: { signedXdr: signedReg },
      });
      const registered = await poll(
        async () => {
          const me = await merchantUser.request({ method: 'GET', path: '/merchants/me' });
          return me?.onChainMerchantId ? me : null;
        },
        150_000,
        'merchant onChainMerchantId (indexed `reg`)',
      );
      check(
        'Merchant registered on-chain',
        !!registered?.onChainMerchantId,
        `id=${registered?.onChainMerchantId}`,
      );

      const plan = await merchantUser.request({
        method: 'POST',
        path: '/subscription-plans',
        body: { name: 'E2E Plan', assetCode: 'XLM', amount: '1', intervalSeconds: 60 },
      });
      check('Plan prepared', !!plan?.id && !!plan?.unsignedXdr);
      const signedPlan = await signXdr(plan.unsignedXdr, merchantKp);
      await merchantUser.request({
        method: 'POST',
        path: `/subscription-plans/${plan.id}/submit`,
        body: { signedXdr: signedPlan },
      });
      const activePlan = await poll(
        async () => {
          const plans = await merchantUser.request({ method: 'GET', path: '/subscription-plans' });
          const row = plans.find((p) => p.id === plan.id);
          return row?.status === 'ACTIVE' ? row : null;
        },
        150_000,
        'plan ACTIVE (indexed `plan`)',
      );
      check(
        'Subscription plan ACTIVE on-chain',
        activePlan?.status === 'ACTIVE',
        `contractPlanId=${activePlan?.contractPlanId}`,
      );

      const sub = await customer.request({
        method: 'POST',
        path: `/subscription-plans/${plan.id}/subscribe`,
        body: { subscriberPublicKey: customerKp.publicKey() },
      });
      check('Subscribe prepared', !!sub?.id && !!sub?.unsignedXdr);
      const signedSub = await signXdr(sub.unsignedXdr, customerKp);
      await customer.request({
        method: 'POST',
        path: `/subscriptions/${sub.id}/submit`,
        body: { signedXdr: signedSub },
      });
      const activeSub = await poll(
        async () => {
          const subs = await customer.request({ method: 'GET', path: '/subscriptions' });
          const row = subs.find((s) => s.id === sub.id);
          return row?.status === 'ACTIVE' ? row : null;
        },
        150_000,
        'subscription ACTIVE (indexed `sub`)',
      );
      check(
        'Subscription ACTIVE on-chain (first payment executed)',
        activeSub?.status === 'ACTIVE',
        `contractSubscriptionId=${activeSub?.contractSubscriptionId}`,
      );

      // record_sale → settle: full merchant settlement lifecycle on-chain.
      const myMerchant = await merchantUser.request({ method: 'GET', path: '/merchants/me' });
      const sale = await customer.request({
        method: 'POST',
        path: `/merchants/${myMerchant.id}/onchain/sale`,
        body: { payerPublicKey: customerKp.publicKey(), assetCode: 'XLM', amount: '2' },
      });
      check('Record-sale prepared', !!sale?.unsignedXdr);
      const signedSale = await signXdr(sale.unsignedXdr, customerKp);
      await customer.request({
        method: 'POST',
        path: `/merchants/${sale.merchantId}/onchain/sale/submit`,
        body: { signedXdr: signedSale },
      });
      const credited = await poll(
        async () => {
          const txs = await merchantUser.request({
            method: 'GET',
            path: '/transactions',
            query: {},
          });
          return txs?.data?.some((t) => t.kind === 'merchant_sale') ? true : null;
        },
        150_000,
        'merchant sale credited (indexed `sale`)',
      );
      check('Merchant sale credited on-chain', credited === true);

      const settle = await merchantUser.request({
        method: 'POST',
        path: '/merchants/me/onchain/settle',
        body: { ownerPublicKey: merchantKp.publicKey(), assetCode: 'XLM' },
      });
      check(
        'Settle prepared',
        !!settle?.unsignedXdr,
        `settlementId=${settle?.settlementId?.slice(0, 8)}`,
      );
      const signedSettle = await signXdr(settle.unsignedXdr, merchantKp);
      await merchantUser.request({
        method: 'POST',
        path: `/merchants/me/onchain/settle/${settle.settlementId}/submit`,
        body: { signedXdr: signedSettle },
      });
      const settled = await poll(
        async () => {
          const settlements = await merchantUser.request({
            method: 'GET',
            path: '/merchants/me/settlements',
          });
          const row = settlements.find((s) => s.id === settle.settlementId);
          return row?.status === 'COMPLETED' ? row : null;
        },
        150_000,
        'settlement COMPLETED (indexed `settle`)',
      );
      check(
        'Merchant settlement COMPLETED on-chain',
        settled?.status === 'COMPLETED',
        `amount=${settled?.amount}`,
      );
    } catch (err) {
      check('Merchant/subscriptions flow', false, describeError(err));
    }
  } finally {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(
      `  Contract integrations E2E: ${passed} passed, ${failed} failed, ${results.length} total`,
    );
    console.log(`${'═'.repeat(60)}\n`);
    if (child) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      await delay(1_000);
    }
  }
}

run()
  .catch((err) => {
    console.error('Fatal:', describeError(err));
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
