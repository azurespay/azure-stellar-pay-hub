import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { io as createSocket, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { SchedulerService } from '../src/scheduler/scheduler.service';
import { HorizonInboundService } from '../src/indexer/horizon-inbound.service';
import { PrismaService } from '@stellar-pay/database';

jest.setTimeout(30_000);

/**
 * Payment-lifecycle E2E (deterministic tier — requires Postgres + Redis, no
 * public testnet). It proves the ingestion/reconciliation/realtime half of the
 * platform end to end through real HTTP routes and a real database:
 *
 *   1. register a merchant owner via the real auth flow (JWT),
 *   2. connect Socket.IO as that merchant,
 *   3. feed the Horizon listener a direct on-chain payment into the merchant
 *      settlement address (chain mocked at the Horizon HTTP boundary),
 *   4. assert the merchant receives the live `payment.received` Socket.IO
 *      event AND the database now holds exactly one INCOMING CONFIRMED
 *      transaction with the chain hash,
 *   5. re-deliver the same event (simulated cursor loss) and assert the
 *      `ChainEvent` unique ledger prevents any double credit.
 *
 * The classic create → sign → submit journey against live testnet is covered
 * by tests/e2e/auth-payment-flow.mjs (tier 5); the contract-route
 * SUBMITTED→CONFIRMED indexer flow is unit-tested and env-gated there.
 */
describe('Payment lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let originalFetch: typeof fetch;

  let merchantOwner: { userId: string; token: string };
  let merchantSettlement: string;
  let socket: Socket;

  const CHAIN_HASH = 'e2e'.repeat(32); // 64-hex, unique per run

  const slug = `e2e-inbound-${Date.now()}`;

  function horizonPage(): { _embedded: { records: Array<Record<string, unknown>> } } {
    return {
      _embedded: {
        records: [
          {
            type: 'payment',
            from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
            to: merchantSettlement,
            amount: '3.2500000',
            asset_type: 'native',
            transaction_hash: CHAIN_HASH,
            transaction_successful: true,
            paging_token: 'pt-e2e-1',
          },
        ],
      },
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

    originalFetch = global.fetch;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The in-process scheduler would poll Horizon every ~15s and race the
      // fetch mock; we drive the listener explicitly from the test instead.
      .overrideProvider(SchedulerService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    prisma = app.get(PrismaService);

    // -- Merchant owner via the real auth flow --------------------------------
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
        deviceName: 'e2e-lifecycle',
      })
      .expect(201);
    merchantOwner = { userId: verify.body.user.id, token: verify.body.accessToken };

    // -- ACTIVE merchant whose settlement address receives direct payments ----
    merchantSettlement = Keypair.random().publicKey();
    await prisma.merchant.create({
      data: {
        userId: merchantOwner.userId,
        name: 'E2E Inbound Merchant',
        slug,
        settlementPublicKey: merchantSettlement,
        status: 'ACTIVE',
        kycStatus: 'APPROVED',
      },
    });

    // -- Socket.IO as the merchant owner (before the payment happens) ---------
    const { port } = app.getHttpServer().address() as AddressInfo;
    socket = createSocket(`http://127.0.0.1:${port}/realtime`, {
      path: '/socket.io',
      auth: { token: merchantOwner.token },
      transports: ['websocket'],
      timeout: 5_000,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err) => reject(err));
    });
  });

  afterAll(async () => {
    if (socket) {
      socket.close();
    }
    // Best-effort cleanup of rows created by this spec.
    const rows = await prisma.transaction.findMany({ where: { hash: CHAIN_HASH } }).catch(() => []);
    for (const row of rows) {
      await prisma.transaction.delete({ where: { id: row.id } }).catch(() => undefined);
    }
    await prisma.chainEvent
      .deleteMany({ where: { eventId: 'horizon:pt-e2e-1' } })
      .catch(() => undefined);
    await prisma.notification
      .deleteMany({ where: { userId: merchantOwner.userId } })
      .catch(() => undefined);
    await prisma.merchant.delete({ where: { slug } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: merchantOwner?.userId ?? '' } })
      .catch(() => undefined);
    global.fetch = originalFetch;
    await app.close();
  });

  function waitForPaymentReceived(timeoutMs = 8_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('payment.received not received')), timeoutMs);
      const onEvent = (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        socket.off('payment.received', onEvent);
        resolve(payload);
      };
      socket.on('payment.received', onEvent);
    });
  }

  it('credits a direct on-chain payment and pushes it live to the merchant', async () => {
    // The Horizon listener polls the merchant feed; the chain is stubbed at the
    // HTTP boundary (one successful inbound payment op).
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/payments?') && href.includes(`accounts/${merchantSettlement}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => horizonPage(),
        } as Response;
      }
      throw new Error(`unexpected outbound fetch in lifecycle e2e: ${href}`);
    }) as unknown as typeof fetch;

    const realtimePromise = waitForPaymentReceived();
    await app.get(HorizonInboundService).syncOnce();
    const event = await realtimePromise;

    // Realtime: the merchant dashboard received the update without polling.
    expect(event).toMatchObject({
      status: 'CONFIRMED',
      toPublicKey: merchantSettlement,
      amount: '3.2500000',
      assetCode: 'XLM',
      source: 'horizon',
    });

    // Database: exactly one INCOMING CONFIRMED row carrying the chain hash.
    const rows = await prisma.transaction.findMany({ where: { hash: CHAIN_HASH } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'CONFIRMED',
      direction: 'INCOMING',
      kind: 'inbound',
      amount: '3.2500000',
      assetCode: 'XLM',
      toPublicKey: merchantSettlement,
    });
    expect(rows[0].id).toBe(event.transactionId);

    // The dedupe ledger recorded the event id exactly once.
    const chainEvent = await prisma.chainEvent.findUnique({
      where: { eventId: 'horizon:pt-e2e-1' },
    });
    expect(chainEvent).not.toBeNull();

    // The merchant received an in-app notification as well.
    const notifications = await prisma.notification.findMany({
      where: { userId: merchantOwner.userId, type: 'PAYMENT_RECEIVED' },
    });
    expect(notifications).toHaveLength(1);
  });

  it('ignores a re-delivered event (duplicate delivery cannot double-credit)', async () => {
    // Simulate a cursor loss: the same page is delivered again on the next poll.
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/payments?') && href.includes(`accounts/${merchantSettlement}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => horizonPage(),
        } as Response;
      }
      throw new Error(`unexpected outbound fetch in lifecycle e2e: ${href}`);
    }) as unknown as typeof fetch;

    await app.get(HorizonInboundService).syncOnce();

    // Still exactly one credited payment, one chain-event row, one notification.
    const rows = await prisma.transaction.findMany({ where: { hash: CHAIN_HASH } });
    expect(rows).toHaveLength(1);
    const chainEvents = await prisma.chainEvent.count({
      where: { eventId: 'horizon:pt-e2e-1' },
    });
    expect(chainEvents).toBe(1);
    const notifications = await prisma.notification.count({
      where: { userId: merchantOwner.userId, type: 'PAYMENT_RECEIVED' },
    });
    expect(notifications).toBe(1);
  });
});
