/**
 * Obtains real access tokens for the UI capture, through the real auth flows:
 *
 *  - web:   wallet challenge -> Ed25519 sign -> POST /auth/verify
 *  - admin: POST /auth/admin/login (email + password)
 *
 * A throwaway Stellar keypair is generated once and persisted to
 * video/.work/demo-key.json; the seeded demo user's primary wallet is re-pointed
 * at it so the signed-in web app resolves to the seeded merchant account.
 *
 * Usage: node video/get-tokens.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaClient } from '../packages/database/src/generated/prisma/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.join(ROOT, 'video', '.work');
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const DEMO_EMAIL = 'user1@stellar-pay.dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@stellar-pay.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'StellarPay-Demo-2026!';

fs.mkdirSync(WORK, { recursive: true });
const keyFile = path.join(WORK, 'demo-key.json');

const keypair = fs.existsSync(keyFile)
  ? Keypair.fromSecret(JSON.parse(fs.readFileSync(keyFile, 'utf8')).secret)
  : Keypair.random();
fs.writeFileSync(
  keyFile,
  JSON.stringify({ publicKey: keypair.publicKey(), secret: keypair.secret() }),
);
const publicKey = keypair.publicKey();

async function post(pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

// 1. Point the seeded demo user's primary wallet at our keypair.
const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } });
  const wallet = await prisma.wallet.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  if (wallet) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { publicKey, status: 'ACTIVE' } });
  } else {
    await prisma.wallet.create({
      data: { userId: user.id, publicKey, provider: 'FREIGHTER', isPrimary: true },
    });
  }
  console.log(`wallet for ${DEMO_EMAIL} -> ${publicKey}`);
} finally {
  await prisma.$disconnect();
}

// 2. Web session through the real wallet challenge/verify flow.
const challenge = await post('/auth/challenge', { publicKey });
const signature = keypair.sign(Buffer.from(challenge.message, 'utf8')).toString('hex');
const verified = await post('/auth/verify', {
  publicKey,
  signature,
  message: challenge.message,
  nonce: challenge.nonce,
  provider: 'FREIGHTER',
  deviceName: 'pitch-video-capture',
});
fs.writeFileSync(
  path.join(WORK, 'web-auth.json'),
  JSON.stringify(
    { accessToken: verified.accessToken, refreshToken: verified.refreshToken },
    null,
    2,
  ),
);
console.log(`web session: ${verified.user.email} (${verified.user.role})`);

// 3. Admin session.
const admin = await post('/auth/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
fs.writeFileSync(
  path.join(WORK, 'admin-auth.json'),
  JSON.stringify({ accessToken: admin.accessToken, refreshToken: admin.refreshToken }, null, 2),
);
console.log(`admin session: ${admin.user.email} (${admin.user.role})`);
