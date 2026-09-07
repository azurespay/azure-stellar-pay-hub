#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the NestJS API against a live Postgres + Redis (or an existing API),
 * then verifies the health endpoint and a couple of public routes.
 *
 * Usage:
 *   pnpm test:e2e
 *   API_URL=http://localhost:4000 pnpm test:e2e   # against an already-running API
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const shouldBoot = !process.env.API_URL;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let child = null;
async function main() {
  if (shouldBoot) {
    console.log(`Booting API for smoke test…`);
    child = spawn('pnpm', ['--filter', '@stellar-pay/api', 'start'], {
      stdio: 'inherit',
      env: { ...process.env, API_PORT: '4100' },
      shell: false,
    });
    await delay(2500);
  }

  const base = shouldBoot ? 'http://localhost:4100' : API_URL;
  // The REST API is served under the /api global prefix.
  const apiBase = base.replace(/\/$/, '').endsWith('/api')
    ? base.replace(/\/$/, '')
    : `${base.replace(/\/$/, '')}/api`;

  try {
    const health = await fetch(`${apiBase}/health`).then((r) => r.json());
    check('GET /health', health.status === 'ok', JSON.stringify(health));
  } catch (err) {
    check('GET /health', false, String(err?.message ?? err));
  }

  try {
    const res = await fetch(`${apiBase}/payments/rates`);
    check('GET /payments/rates (public)', res.status < 500, `status=${res.status}`);
  } catch (err) {
    check('GET /payments/rates (public)', false, String(err?.message ?? err));
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} smoke check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} smoke checks passed.`);
  }
}

main().finally(() => {
  if (child) child.kill();
});
