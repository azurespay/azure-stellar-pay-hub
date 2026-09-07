#!/usr/bin/env node
/**
 * E2E test: Auth challenge → verify → payment lifecycle (create → sign →
 * submit → confirm → realtime).
 *
 * Verifies the full authentication-and-payment lifecycle against a running
 * StellarPay API **and Stellar testnet**:
 *
 *   1. auth challenge → Ed25519 verify → JWT
 *   2. fund accounts via Friendbot (testnet)
 *   3. create a payment → get an unsigned XDR
 *   4. sign the XDR with the wallet keypair
 *   5. submit the signed transaction through the API
 *   6. poll until the persisted transaction reaches its final state
 *   7. assert the Socket.IO realtime channel delivered the `transaction.updated`
 *      event to the authenticated user
 *   8. logout and verify the JWT is invalidated
 *
 * By default the payment goes through the **classic** Stellar path (final
 * state SUCCEEDED). Set E2E_CONTRACT=1 to route the same payment through the
 * Soroban `payment` contract instead: the flow then expects SUBMITTED after
 * submission and polls until the API's event indexer confirms the invocation
 * on-chain (final state CONFIRMED). Contract mode requires the deployed
 * contract's XLM SAC to be allowlisted on-chain (admin `set_allowed`) and, in
 * boot mode, a CONTRACT_STELLAR_PAY_PAYMENT env var.
 *
 * This is a *testnet E2E test*: it requires a live API (Postgres + Redis) and
 * live Stellar testnet access (Friendbot + Horizon). It is not part of CI,
 * which runs deterministic unit/contract tests only.
 *
 * Usage:
 *   # Against a running API (API_URL must include the /api prefix):
 *   API_URL=http://localhost:4000/api node tests/e2e/auth-payment-flow.mjs
 *
 *   # Boot the API automatically (requires Docker for Postgres + Redis):
 *   pnpm --filter @stellar-pay/api build
 *   node tests/e2e/auth-payment-flow.mjs
 */

import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { io } from 'socket.io-client';
import { ApiClient, StellarNetwork } from '../../packages/sdk/dist/index.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const INPUT_API_URL = process.env.API_URL ?? 'http://localhost:4000/api';
const BOOT_API = !process.env.API_URL;
const CONTRACT_ROUTE = process.env.E2E_CONTRACT === '1';

// Terminal/persisted states differ by route: classic payments reach SUCCEEDED
// on submission; contract-route payments settle to CONFIRMED only after the
// scheduler-driven event indexer observes the on-chain invocation.
const FINAL_STATUS = CONTRACT_ROUTE ? 'CONFIRMED' : 'SUCCEEDED';
const SUBMIT_STATUS = CONTRACT_ROUTE ? 'SUBMITTED' : 'SUCCEEDED';

// The REST API lives under the `/api` global prefix; the Socket.IO gateway is
// mounted at the host root (`/realtime` namespace).
const apiUrl = BOOT_API ? 'http://localhost:4100/api' : INPUT_API_URL.replace(/\/$/, '');
const rootUrl = apiUrl.replace(/\/api$/, '');

// ── Test helpers ────────────────────────────────────────────────────────────

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

function summary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);
  console.log(`${'═'.repeat(50)}\n`);
}

// ── Boot API if needed ──────────────────────────────────────────────────────

async function bootApi() {
  console.log('Booting API for E2E test…');
  const child = spawn('pnpm', ['--filter', '@stellar-pay/api', 'start'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      API_PORT: '4100',
      NODE_ENV: 'development',
      JWT_SECRET: 'e2e-test-secret-at-least-16-chars',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      STELLAR_NETWORK: 'testnet',
      ADMIN_EMAIL: 'e2e@test.dev',
      ADMIN_PASSWORD: 'E2eTest123!',
      ...(CONTRACT_ROUTE
        ? {
            // Soroban contract route (experimental, off by default).
            PAYMENT_ROUTE: 'contract',
            CONTRACT_STELLAR_PAY_PAYMENT: process.env.CONTRACT_STELLAR_PAY_PAYMENT,
            PAYMENT_CONTRACT_ASSETS: process.env.PAYMENT_CONTRACT_ASSETS ?? 'XLM',
            SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL,
          }
        : {}),
    },
    shell: false,
  });

  // Wait for the API to boot (NestJS takes a few seconds with Prisma + Redis).
  for (let i = 0; i < 30; i++) {
    await delay(1_000);
    try {
      const res = await fetch(`http://localhost:4100/api/health`);
      if (res.ok) {
        console.log('  API is ready.');
        return child;
      }
    } catch {
      /* still booting */
    }
  }
  child.kill();
  throw new Error('API failed to start within 30 seconds');
}

/** Fund a testnet account via Friendbot and wait for the ledger to close. */
async function fundAccount(publicKey, label) {
  try {
    const fbResp = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    const fbData = await fbResp.json();
    check(
      `Friendbot funded ${label}`,
      fbData?.successful === true,
      `hash=${fbData?.hash?.slice(0, 8)}…`,
    );
    if (fbData?.successful) {
      await delay(3_000); // wait for the ledger to close
    }
    return fbData?.successful === true;
  } catch (err) {
    check(`Friendbot funded ${label}`, false, err.message);
    return false;
  }
}

/**
 * Wait for a realtime `transaction.updated` event for the given transaction id
 * from the user's private Socket.IO room.
 */
function waitForTransactionEvent(socket, txId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('transaction.updated', onEvent);
      reject(new Error(`realtime transaction.updated event not received within ${timeoutMs}ms`));
    }, timeoutMs);
    function onEvent(payload) {
      if (payload?.id !== txId) return;
      clearTimeout(timer);
      socket.off('transaction.updated', onEvent);
      resolve(payload);
    }
    socket.on('transaction.updated', onEvent);
  });
}

// ── Main test flow ──────────────────────────────────────────────────────────

async function run() {
  let child = null;

  if (CONTRACT_ROUTE && BOOT_API && !process.env.CONTRACT_STELLAR_PAY_PAYMENT) {
    console.error(
      'E2E_CONTRACT=1 in boot mode requires CONTRACT_STELLAR_PAY_PAYMENT (deployed contract id).',
    );
    process.exitCode = 1;
    return;
  }

  if (BOOT_API) {
    child = await bootApi();
  }

  try {
    // -- Step 1: Health check ---------------------------------------------------
    console.log('\n1. Health check');
    const health = await fetch(`${apiUrl}/health`).then((r) => r.json());
    check('API is healthy', health?.status === 'ok', JSON.stringify(health));
    if (health?.status !== 'ok') {
      console.error('  API not healthy — aborting');
      return;
    }

    // -- Step 2: Generate test keypairs -----------------------------------------
    console.log('\n2. Generate testnet keypairs');
    const payerKp = Keypair.random();
    const destKp = Keypair.random();
    check(
      'Payer keypair generated',
      !!payerKp.secret() && !!payerKp.publicKey(),
      `publicKey=${payerKp.publicKey().slice(0, 8)}…`,
    );

    // -- Step 3: Request auth challenge -----------------------------------------
    console.log('\n3. Request auth challenge');
    const client = new ApiClient({ baseUrl: apiUrl });

    let challenge;
    try {
      challenge = await client.auth.challenge(payerKp.publicKey());
      check('Challenge received', !!challenge?.nonce && !!challenge?.message);
      check(
        'Challenge has correct format',
        challenge?.message?.startsWith('stellar-pay:auth:'),
        challenge?.message?.slice(0, 40),
      );
    } catch (err) {
      check('Challenge received', false, err.message);
      return;
    }

    // -- Step 4: Sign challenge -------------------------------------------------
    console.log('\n4. Sign challenge message');
    const messageBytes = Buffer.from(challenge.message, 'utf8');
    const signatureBytes = payerKp.sign(messageBytes);
    const signature = Buffer.from(signatureBytes).toString('hex');
    check('Challenge signed', signature.length >= 128, `sig=${signature.slice(0, 16)}…`);

    // -- Step 5: Verify and get JWT ---------------------------------------------
    console.log('\n5. Verify & get JWT');
    let authResult;
    try {
      authResult = await client.auth.verify({
        publicKey: payerKp.publicKey(),
        signature,
        message: challenge.message,
        nonce: challenge.nonce,
        provider: 'FREIGHTER',
        deviceName: 'e2e-test',
      });
      check(
        'Auth verified',
        !!authResult?.accessToken,
        `user=${authResult?.user?.id?.slice(0, 8)}…`,
      );
      check('Refresh token present', !!authResult?.refreshToken);
      check('User created/returned', !!authResult?.user?.id);
    } catch (err) {
      check('Auth verified', false, err.message);
      return;
    }

    // Authenticated client for the rest of the flow.
    const authClient = new ApiClient({
      baseUrl: apiUrl,
      getToken: () => authResult.accessToken,
    });

    // -- Step 6: Fund the accounts via Friendbot (testnet) ----------------------
    console.log('\n6. Fund accounts via Friendbot');
    const payerFunded = await fundAccount(payerKp.publicKey(), 'payer');
    const destFunded = await fundAccount(destKp.publicKey(), 'destination');
    if (!payerFunded || !destFunded) {
      console.error('  Friendbot funding failed — cannot complete an on-chain payment');
    }

    // -- Step 7: Create payment with JWT ----------------------------------------
    console.log(
      `\n7. Create payment (JWT-authenticated) — route: ${CONTRACT_ROUTE ? 'soroban contract' : 'classic'}`,
    );
    let payment;
    try {
      payment = await authClient.payments.create({
        type: 'SEND',
        fromPublicKey: payerKp.publicKey(),
        destinations: [{ publicKey: destKp.publicKey(), amount: '10', memo: 'e2e-test-payment' }],
        assetCode: 'XLM',
        memo: 'e2e-test-payment',
      });
      check('Payment created', !!payment?.id, `id=${payment?.id?.slice(0, 8)}…`);
      check(
        'Payment has unsignedXdr',
        !!payment?.unsignedXdr,
        `xdr=${payment?.unsignedXdr?.slice(0, 20)}…`,
      );
    } catch (err) {
      check('Payment created', false, err.message);
      return;
    }

    // -- Step 8: Connect realtime channel BEFORE submitting ----------------------
    console.log('\n8. Connect realtime channel');
    const socket = io(`${rootUrl}/realtime`, {
      path: '/socket.io',
      auth: { token: authResult.accessToken },
      transports: ['websocket'],
      timeout: 5_000,
    });
    let socketConnected = false;
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
      });
      socketConnected = true;
      check('Socket.IO connected with JWT', true, `socket=${socket.id?.slice(0, 8)}…`);
    } catch (err) {
      check('Socket.IO connected with JWT', false, err.message);
    }
    const realtimeEvent = socketConnected
      ? waitForTransactionEvent(socket, payment.id).catch((err) => ({ error: err.message }))
      : Promise.resolve({ error: 'socket not connected' });

    // -- Step 9: Sign the unsigned XDR ------------------------------------------
    console.log('\n9. Sign transaction XDR');
    let signedXdr = null;
    try {
      const tx = TransactionBuilder.fromXDR(payment.unsignedXdr, Networks.TESTNET);
      tx.sign(payerKp);
      signedXdr = tx.toXDR();
      check('Transaction signed', !!signedXdr, `xdr=${signedXdr.slice(0, 20)}…`);
    } catch (err) {
      check('Transaction signed', false, err.message);
    }

    // -- Step 10: Submit the signed transaction ----------------------------------
    console.log('\n10. Submit signed transaction');
    let submitted = null;
    if (signedXdr) {
      try {
        submitted = await authClient.request({
          method: 'POST',
          path: `/payments/${payment.id}/submit`,
          body: { signedXdr },
        });
        check(
          'Submission accepted',
          submitted?.status === SUBMIT_STATUS || submitted?.status === 'FAILED',
          JSON.stringify(submitted),
        );
      } catch (err) {
        check('Submission accepted', false, err.message);
      }
    }

    // -- Step 11: Poll until final persisted state -------------------------------
    console.log('\n11. Poll for final transaction state');
    let finalTx = null;
    if (signedXdr) {
      for (let i = 0; i < 45; i++) {
        try {
          const current = await authClient.payments.get(payment.id);
          if (current?.status === FINAL_STATUS || current?.status === 'FAILED') {
            finalTx = current;
            break;
          }
        } catch {
          /* not ready yet */
        }
        await delay(2_000);
      }
      check(
        'Transaction reached final state',
        finalTx?.status === FINAL_STATUS,
        finalTx ? `status=${finalTx.status} hash=${finalTx.hash?.slice(0, 8)}…` : 'still pending',
      );
      check('Hash persisted on the record', !!finalTx?.hash);
      check(
        'Recorded amount and asset match',
        finalTx?.amount === '10' && finalTx?.assetCode === 'XLM',
        `amount=${finalTx?.amount} ${finalTx?.assetCode}`,
      );
    } else {
      check('Transaction reached final state', false, 'no signed XDR to submit');
    }

    // -- Step 12: Assert realtime delivery ---------------------------------------
    console.log('\n12. Assert realtime delivery');
    if (socketConnected && signedXdr) {
      const event = await realtimeEvent;
      if (event?.error) {
        check('Realtime transaction.updated received', false, event.error);
      } else {
        check(
          'Realtime transaction.updated received',
          event?.status === FINAL_STATUS && event?.id === payment.id,
          JSON.stringify(event),
        );
      }
    } else {
      check('Realtime transaction.updated received', false, 'socket not connected');
    }
    if (socketConnected) {
      socket.close();
    }

    // -- Step 13: Logout ---------------------------------------------------------
    console.log('\n13. Logout');
    try {
      const logoutResp = await fetch(`${apiUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authResult.accessToken}` },
      });
      check(
        'Logout succeeded',
        logoutResp.status === 204 || logoutResp.ok,
        `HTTP ${logoutResp.status}`,
      );
    } catch (err) {
      check('Logout succeeded', false, err.message);
    }

    // -- Step 14: Verify JWT is invalidated --------------------------------------
    console.log('\n14. Verify JWT is invalidated');
    try {
      await authClient.payments.list({ page: 1, pageSize: 1 });
      check('JWT invalidated (401 expected)', false, 'still accepted');
    } catch (err) {
      if (err.statusCode === 401) {
        check('JWT invalidated (401)', true);
      } else {
        check('JWT invalidated (401)', false, `got ${err.statusCode}: ${err.message}`);
      }
    }

    // -- Step 15: Stellar network connectivity test ------------------------------
    console.log('\n15. Stellar testnet connectivity');
    try {
      const network = StellarNetwork.forTestnet();
      const account = await network.getAccount(destKp.publicKey());
      check('Testnet Horizon reachable', !!account, `sequence=${account?.sequenceNumber()}`);
    } catch (err) {
      check('Testnet Horizon reachable', false, err.message);
    }
  } finally {
    summary();
    if (child) {
      console.log('Stopping API…');
      child.kill('SIGTERM');
      await delay(1_000);
    }
  }
}

run().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exitCode = 1;
  summary();
});
