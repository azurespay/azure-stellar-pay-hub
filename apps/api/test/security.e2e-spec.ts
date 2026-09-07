import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from '../src/app.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { PrismaService } from '@stellar-pay/database';

jest.setTimeout(30_000);

/**
 * Deterministic security suite (tier 3 — Postgres + Redis, no network). It
 * verifies the authorization boundary the way an attacker would probe it:
 *
 *   - unauthenticated and invalid tokens            → 401
 *   - revoked session                               → 401 (server-side revocation)
 *   - non-admin on admin endpoints                  → 403 (RBAC, not UI hiding)
 *   - user A reading/submitting user B's payment    → 404 (ownership scoped, no oracle)
 *   - auth endpoints exceed the rate limit          → 429
 *
 * Fake-payment, tampered-XDR, duplicate/replay and webhook-signature coverage
 * lives in the unit suites (No. 5/No. 4); this suite covers the API boundary.
 */
describe('Security (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  async function registerUser(): Promise<{ userId: string; token: string; keypair: Keypair }> {
    const keypair = Keypair.random();
    const challenge = await request(app.getHttpServer())
      .post('/api/auth/challenge')
      .send({ publicKey: keypair.publicKey() })
      .expect(201);
    const signature = Buffer.from(
      keypair.sign(Buffer.from(challenge.body.message, 'utf8')),
    ).toString('hex');
    const verify = await request(app.getHttpServer())
      .post('/api/auth/verify')
      .send({
        publicKey: keypair.publicKey(),
        signature,
        message: challenge.body.message,
        nonce: challenge.body.nonce,
        provider: 'FREIGHTER',
        deviceName: 'e2e-security',
      })
      .expect(201);
    return {
      userId: verify.body.user.id,
      token: verify.body.accessToken,
      keypair,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Keep the scheduler's background network polls out of this suite.
      .overrideProvider(SchedulerService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a protected route without a bearer token', async () => {
    await request(app.getHttpServer()).get('/api/payments/history').expect(401);
  });

  it('rejects a forged / malformed JWT', async () => {
    await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', 'Bearer aaaa.bbbb.cccc')
      .expect(401);
  });

  it('rejects a request after the session is revoked server-side', async () => {
    const user = await registerUser();
    await prisma.session.updateMany({
      where: { userId: user.userId },
      data: { status: 'REVOKED' },
    });
    await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(401);
    await prisma.user.deleteMany({ where: { id: user.userId } }).catch(() => undefined);
  });

  it('blocks a non-admin (USER) from an admin endpoint (403, not a hidden button)', async () => {
    const user = await registerUser();
    await request(app.getHttpServer())
      .get('/api/admin/analytics/dashboard')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
    await request(app.getHttpServer()).get('/api/admin/analytics/dashboard').expect(401);
    await prisma.user.deleteMany({ where: { id: user.userId } }).catch(() => undefined);
  });

  it('denies user B access to user A payment (IDOR/BOLA → 404, no existence oracle)', async () => {
    const owner = await registerUser();
    const attacker = await registerUser();

    const payment = await prisma.transaction.create({
      data: {
        userId: owner.userId,
        fromPublicKey: owner.keypair.publicKey(),
        toPublicKey: Keypair.random().publicKey(),
        amount: '50',
        assetCode: 'XLM',
        status: 'PENDING',
        direction: 'OUTGOING',
        kind: 'payment',
        sourceNetwork: 'testnet',
      },
    });

    // The owner can read their own payment…
    const mine = await request(app.getHttpServer())
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(mine.body.id).toBe(payment.id);

    // …but a different user cannot read it, submit it, or learn it exists.
    await request(app.getHttpServer())
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${attacker.token}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}/submit`)
      .set('Authorization', `Bearer ${attacker.token}`)
      .send({ signedXdr: 'AAAA…' })
      .expect(404);

    await prisma.transaction.delete({ where: { id: payment.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: owner.userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: attacker.userId } }).catch(() => undefined);
  });

  it('rate-limits the auth challenge endpoint (429 after the per-window budget)', async () => {
    // Two challenges above already count toward the 10/min IP budget; fire the
    // remainder of the window, then the next request must be throttled.
    const keypair = Keypair.random();
    let blocked = false;
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/challenge')
        .send({ publicKey: keypair.publicKey() });
      if (res.status === 429) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });
});
