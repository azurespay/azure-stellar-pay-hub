import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { AppModule } from '../src/app.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { PrismaService } from '@stellar-pay/database';

/**
 * Scheduled + split/batch payment intents (e2e).
 *
 * The deterministic tier — real HTTP routes against a real Postgres + Redis,
 * no public network. It covers the two create paths the live testnet suite
 * (`tests/e2e/auth-payment-flow.mjs`) does not: a scheduled/recurring intent
 * (which is persisted for the scheduler instead of building an XDR) and a
 * multi-recipient split/batch intent (one payment op per recipient).
 *
 * The batch builder loads the source account from Horizon; the network helper
 * is stubbed at its module boundary so the tier stays deterministic. The
 * on-chain equivalents (sign → submit → confirm) run in tier 5 against live
 * testnet.
 */
jest.mock('../src/infra/stellar', () => {
  const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  return {
    createStellarNetwork: () => ({
      config: { networkPassphrase: NETWORK_PASSPHRASE },
      server: {
        loadAccount: async (publicKey: string) => ({
          accountId: () => publicKey,
          sequenceNumber: () => '123456789',
          incrementSequenceNumber: () => undefined,
        }),
      },
      buildPaymentTransaction: jest.fn(),
      prepareSorobanSendTransaction: jest.fn(),
    }),
  };
});

jest.setTimeout(30_000);

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/** The subset of a Stellar payment operation this spec asserts on. */
type PaymentOp = { destination: string; amount: string };

describe('Scheduled & split payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: { userId: string; token: string; keypair: Keypair };
  const createdUserIds: string[] = [];

  async function registerUser(label: string) {
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
        deviceName: `e2e-${label}`,
      })
      .expect(201);
    createdUserIds.push(verify.body.user.id);
    return {
      userId: verify.body.user.id as string,
      token: verify.body.accessToken as string,
      keypair,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      'postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.JWT_SECRET ??= 'e2e-test-secret-at-least-16-chars';
    process.env.WEBHOOK_SIGNING_SECRET ??= 'e2e-webhook-secret-16-chars';
    process.env.ADMIN_PASSWORD ??= 'E2eTest123!';
    process.env.STELLAR_NETWORK ??= 'testnet';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Keep the scheduler's background polling out of this suite; the
      // schedule *rows* are what this spec asserts on.
      .overrideProvider(SchedulerService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    prisma = app.get(PrismaService);

    // Signup links the wallet the challenge was signed with, so this keypair is
    // the only one `assertWalletOwnership` accepts as the payer.
    owner = await registerUser('scheduled-owner');
  });

  afterAll(async () => {
    for (const userId of createdUserIds) {
      await prisma.transaction.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.scheduledPayment.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.userPreference.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.wallet.deleteMany({ where: { userId } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await app.close();
  });

  describe('scheduled / recurring intents', () => {
    it('persists a recurring schedule with its next run, then cancels it', async () => {
      const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
      const created = await request(app.getHttpServer())
        .post('/api/payments')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'RECURRING',
          fromPublicKey: owner.keypair.publicKey(),
          destinations: [{ publicKey: Keypair.random().publicKey(), amount: '5' }],
          assetCode: 'XLM',
          scheduledFor,
          recurring: { interval: 'monthly', count: 12 },
        })
        .expect(201);

      // A schedule is not a payment: it is stored ACTIVE with its next run set,
      // no XDR is built, and no Transaction row exists until the scheduler
      // creates an occurrence the owner approves.
      expect(created.body.kind).toBe('scheduled');
      expect(await prisma.transaction.count({ where: { userId: owner.userId } })).toBe(0);

      const listed = await request(app.getHttpServer())
        .get('/api/payments/scheduled')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      const row = listed.body.find((r: { id: string }) => r.id === created.body.id);
      expect(row).toMatchObject({ status: 'ACTIVE', interval: 'monthly', maxRuns: 12 });
      expect(new Date(row.nextRunAt).toISOString()).toBe(scheduledFor);

      await request(app.getHttpServer())
        .delete(`/api/payments/scheduled/${created.body.id}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);

      const canceled = await prisma.scheduledPayment.findUnique({
        where: { id: created.body.id },
      });
      expect(canceled?.status).toBe('CANCELED');
    });

    it('scopes the schedule list and cancellation to its owner', async () => {
      const other = await registerUser('scheduled-other');
      const created = await request(app.getHttpServer())
        .post('/api/payments')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'SCHEDULED',
          fromPublicKey: owner.keypair.publicKey(),
          destinations: [{ publicKey: Keypair.random().publicKey(), amount: '2' }],
          assetCode: 'XLM',
          scheduledFor: new Date(Date.now() + 7_200_000).toISOString(),
        })
        .expect(201);

      const otherList = await request(app.getHttpServer())
        .get('/api/payments/scheduled')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);
      expect(otherList.body).toHaveLength(0);

      // Cancelling someone else's schedule is a scoped no-op, not a cross-tenant write.
      await request(app.getHttpServer())
        .delete(`/api/payments/scheduled/${created.body.id}`)
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);
      const untouched = await prisma.scheduledPayment.findUnique({
        where: { id: created.body.id },
      });
      expect(untouched?.status).toBe('ACTIVE');
    });

    it('rejects a schedule aimed at a malformed recipient', async () => {
      await request(app.getHttpServer())
        .post('/api/payments')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'SCHEDULED',
          fromPublicKey: owner.keypair.publicKey(),
          destinations: [{ publicKey: 'not-a-key', amount: '2' }],
          assetCode: 'XLM',
          scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(400);
    });
  });

  describe('split / batch intents', () => {
    it('builds one payment op per recipient with the exact amounts', async () => {
      const recipients = ['1', '2', '3'].map((amount) => ({
        publicKey: Keypair.random().publicKey(),
        amount,
      }));

      const created = await request(app.getHttpServer())
        .post('/api/payments')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'SPLIT',
          fromPublicKey: owner.keypair.publicKey(),
          destinations: recipients,
          assetCode: 'XLM',
          memo: 'payroll',
        })
        .expect(201);

      expect(created.body.kind).toBe('pending');

      const tx = TransactionBuilder.fromXDR(created.body.unsignedXdr, NETWORK_PASSPHRASE) as {
        operations: unknown[];
        memo: { type: string };
      };
      const ops = tx.operations as PaymentOp[];
      expect(ops).toHaveLength(recipients.length);
      expect(ops.map((op) => [op.destination, op.amount])).toEqual([
        [recipients[0].publicKey, '1.0000000'],
        [recipients[1].publicKey, '2.0000000'],
        [recipients[2].publicKey, '3.0000000'],
      ]);
      expect(tx.memo.type).toBe('text');

      // The recorded intent carries the exact total and no single recipient.
      const row = await prisma.transaction.findUnique({ where: { id: created.body.id } });
      expect(row).toMatchObject({
        status: 'PENDING',
        amount: '6',
        toPublicKey: null,
        memo: 'payroll',
      });
    });

    it('rejects a batch with no recipients', async () => {
      await request(app.getHttpServer())
        .post('/api/payments')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          type: 'BATCH',
          fromPublicKey: owner.keypair.publicKey(),
          destinations: [],
          assetCode: 'XLM',
        })
        .expect(400);
    });
  });
});
