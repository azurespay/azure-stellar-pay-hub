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
      // Own process group so teardown reaches the pnpm → node child tree.
      detached: true,
    });
    // Poll for readiness — Nest takes a few seconds to boot with Prisma +
    // Redis, so a fixed sleep is unreliable.
    const probeBase = 'http://localhost:4100/api';
    for (let i = 0; i < 30; i += 1) {
      await delay(1_000);
      try {
        const res = await fetch(`${probeBase}/health`);
        if (res.ok) break;
      } catch {
        /* still booting */
      }
    }
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
    const res = await fetch(`${apiBase}/assets`);
    check('GET /assets (public)', res.ok, `status=${res.status}`);
  } catch (err) {
    check('GET /assets (public)', false, String(err?.message ?? err));
  }

  try {
    const res = await fetch(`${apiBase}/health/ready`);
    check('GET /health/ready (deps)', res.ok, `status=${res.status}`);
  } catch (err) {
    check('GET /health/ready (deps)', false, String(err?.message ?? err));
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} smoke check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} smoke checks passed.`);
  }
}

main()
  .finally(() => {
    if (child) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  })
  .finally(() => {
    // Force-exit: never leave a booted API child keeping the harness alive.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
