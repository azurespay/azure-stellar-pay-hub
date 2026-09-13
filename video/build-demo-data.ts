/**
 * Demo dataset for the product pitch video.
 *
 * `packages/database/scripts/seed.ts` seeds a *structurally* complete database
 * (roles, admin, demo merchant, payment link) but almost no activity, so every
 * dashboard renders empty states. This script layers ~30 days of realistic
 * activity on top of that seed so the recorded UI shows a product in use.
 *
 * Idempotent: every write is an upsert keyed on a deterministic id, so it can
 * be re-run without duplicating rows.
 *
 * Run from the repo root:
 *   pnpm --filter @stellar-pay/database exec tsx ../../video/build-demo-data.ts
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaClient } from '../packages/database/src/generated/prisma';

const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** Stable pseudo-random source so re-runs produce identical demo data. */
function rng(seed: string): () => number {
  const h = createHash('sha256').update(seed).digest();
  let i = 0;
  return () => {
    const b = h[i % h.length];
    i++;
    return b / 255;
  };
}

/** A real, checksum-valid Stellar public key derived deterministically. */
const keyCache = new Map<string, string>();
function addr(seed: string): string {
  const cached = keyCache.get(seed);
  if (cached) {
    return cached;
  }
  const next = rng(seed);
  const bytes = Buffer.from(Array.from({ length: 32 }, () => Math.floor(next() * 256)));
  const key = Keypair.fromRawEd25519Seed(bytes).publicKey();
  keyCache.set(seed, key);
  return key;
}

const txHash = (seed: string): string => createHash('sha256').update(`tx:${seed}`).digest('hex');
const linkHash = (seed: string): string =>
  createHash('sha256').update(`hl:${seed}`).digest('hex').slice(0, 64);

interface MerchantContext {
  userId: string;
  merchantId: string;
  merchantName: string;
  paymentLinkId: string;
  paymentLinkCode: string;
  productIds: string[];
}

async function merchantContext(): Promise<MerchantContext> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'user1@stellar-pay.dev' } });
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { userId: user.id } });
  const link = await prisma.paymentLink.findFirstOrThrow({ where: { merchantId: merchant.id } });
  const products = await prisma.product.findMany({ where: { merchantId: merchant.id } });

  // Make the demo merchant look fully onboarded and on-chain registered.
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      status: 'ACTIVE',
      kycStatus: 'VERIFIED',
      onChainMerchantId: 42,
      registerTxHash: txHash('merchant-register'),
      websiteUrl: 'https://demo-coffee.example.com',
    },
  });

  return {
    userId: user.id,
    merchantId: merchant.id,
    merchantName: merchant.name,
    paymentLinkId: link.id,
    paymentLinkCode: link.code,
    productIds: products.map((p) => p.id),
  };
}

/** Customers with spend history, so the merchant page has a customer table. */
async function seedCustomers(ctx: MerchantContext): Promise<string[]> {
  const people = [
    { name: 'Amara Okafor', email: 'amara@example.com', spent: '486.50', count: 17 },
    { name: 'Lucas Meyer', email: 'lucas@example.com', spent: '312.00', count: 11 },
    { name: 'Priya Raman', email: 'priya@example.com', spent: '198.75', count: 8 },
    { name: 'Diego Santos', email: 'diego@example.com', spent: '142.25', count: 6 },
    { name: 'Yuki Tanaka', email: 'yuki@example.com', spent: '87.50', count: 4 },
  ];

  const ids: string[] = [];
  for (const [i, p] of people.entries()) {
    const id = `demo-customer-${i + 1}`;
    const lastPurchaseAt = new Date(now - (i + 1) * 2 * DAY);
    await prisma.customer.upsert({
      where: { id },
      update: {},
      create: {
        id,
        merchantId: ctx.merchantId,
        publicKey: addr(`customer-${i + 1}`),
        email: p.email,
        name: p.name,
        totalSpent: p.spent,
        transactionCount: p.count,
        lastPurchaseAt,
        createdAt: new Date(now - 60 * DAY),
      },
    });
    ids.push(id);
  }
  return ids;
}

/** ~30 days of payments: mostly confirmed, a few in-flight and failed. */
async function seedTransactions(ctx: MerchantContext): Promise<void> {
  const assets = [
    { code: 'USDC', issuer: addr('usdc-issuer') },
    { code: 'XLM', issuer: null },
    { code: 'EURT', issuer: addr('usdc-issuer') },
  ];
  const kinds = ['payment', 'payment', 'payment', 'checkout', 'settlement', 'invoice'];
  const statuses = [
    'SUCCEEDED',
    'SUCCEEDED',
    'SUCCEEDED',
    'SUCCEEDED',
    'CONFIRMED',
    'PENDING',
    'FAILED',
  ];

  for (let i = 0; i < 46; i++) {
    const r = rng(`tx-${i}`);
    const asset = assets[Math.floor(r() * assets.length)];
    const status = statuses[Math.floor(r() * statuses.length)];
    const incoming = r() > 0.35;
    // Non-uniform spacing so the activity chart has visible peaks and troughs.
    const ageDays = Math.floor(Math.pow(r(), 0.75) * 30);
    const createdAt = new Date(now - ageDays * DAY - Math.floor(r() * DAY));
    const amount = (12 + r() * 480).toFixed(2);
    const counterparty = addr(`counterparty-${i % 12}`);

    await prisma.transaction.upsert({
      where: { id: `demo-tx-${i}` },
      update: {},
      create: {
        id: `demo-tx-${i}`,
        userId: ctx.userId,
        hash: txHash(`payment-${i}`),
        stellarTxId: String(120000000000000000n + BigInt(i * 7919)),
        fromPublicKey: incoming ? counterparty : addr('merchant-settlement'),
        toPublicKey: incoming ? addr('merchant-settlement') : counterparty,
        amount,
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        memo: `Order #${1000 + i}`,
        status: status as never,
        direction: incoming ? 'INCOMING' : 'OUTGOING',
        kind: kinds[Math.floor(r() * kinds.length)],
        fee: '0.0000100',
        sequence: String(483920000000000000n + BigInt(i * 31)),
        sourceNetwork: 'testnet',
        errorMessage:
          status === 'FAILED' ? 'op_underfunded: source account below minimum reserve' : null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
}

/** Invoices across the lifecycle, including a paid one and an overdue one. */
async function seedInvoices(ctx: MerchantContext, customerIds: string[]): Promise<void> {
  const specs = [
    {
      status: 'PAID',
      title: 'Wholesale order — Ethiopia blend',
      amount: '1840.00',
      onChainId: 101,
    },
    { status: 'ISSUED', title: 'Café refill subscription', amount: '420.00', onChainId: 102 },
    { status: 'ISSUED', title: 'Corporate gift boxes', amount: '960.00', onChainId: 103 },
    {
      status: 'PARTIALLY_PAID',
      title: 'Retail restock — travel mugs',
      amount: '312.50',
      onChainId: null,
    },
    { status: 'DRAFT', title: 'Q4 catering estimate', amount: '2400.00', onChainId: null },
    { status: 'EXPIRED', title: 'Spring promo pre-order', amount: '150.00', onChainId: 104 },
  ];

  for (const [i, s] of specs.entries()) {
    const createdAt = new Date(now - (32 - i * 5) * DAY);
    const num = `INV-2026-${String(1001 + i)}`;
    await prisma.invoice.upsert({
      where: { number: num },
      update: {},
      create: {
        id: `demo-invoice-${i + 1}`,
        number: num,
        merchantId: ctx.merchantId,
        customerId: customerIds[i % customerIds.length],
        customerPublicKey: addr(`customer-${(i % customerIds.length) + 1}`),
        title: s.title,
        description: 'Generated by the invoicing module for the demo dataset.',
        items: [{ description: s.title, quantity: 1, unitPrice: s.amount }],
        amount: s.amount,
        assetCode: 'USDC',
        assetIssuer: addr('usdc-issuer'),
        status: s.status as never,
        dueDate: new Date(createdAt.getTime() + 14 * DAY),
        paidAt: s.status === 'PAID' ? new Date(createdAt.getTime() + 3 * DAY) : null,
        onChainId: s.onChainId,
        issueTxHash: s.onChainId ? txHash(`invoice-issue-${i}`) : null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
}

/** Settlements: one settled on-chain, one processing, one pending payout. */
async function seedSettlements(ctx: MerchantContext): Promise<void> {
  const specs = [
    { status: 'COMPLETED', amount: '8420.75', weeksAgo: 4, onChainMerchantId: 42, settle: true },
    { status: 'COMPLETED', amount: '6115.20', weeksAgo: 2, onChainMerchantId: 42, settle: true },
    { status: 'PROCESSING', amount: '3480.00', weeksAgo: 1, onChainMerchantId: 42, settle: false },
    { status: 'PENDING', amount: '1290.40', weeksAgo: 0, onChainMerchantId: null, settle: false },
  ];

  for (const [i, s] of specs.entries()) {
    const periodEnd = new Date(now - s.weeksAgo * 7 * DAY);
    await prisma.settlement.upsert({
      where: { id: `demo-settlement-${i + 1}` },
      update: {},
      create: {
        id: `demo-settlement-${i + 1}`,
        merchantId: ctx.merchantId,
        periodStart: new Date(periodEnd.getTime() - 7 * DAY),
        periodEnd,
        amount: s.amount,
        assetCode: 'USDC',
        assetIssuer: addr('usdc-issuer'),
        status: s.status,
        onChainMerchantId: s.onChainMerchantId,
        settleTxHash: s.settle ? txHash(`settle-${i}`) : null,
        payoutTransactionId: s.status === 'COMPLETED' ? txHash(`payout-${i}`) : null,
      },
    });
  }
}

/** Escrow lifecycle, subscriptions and treasury so those pages are populated. */
async function seedContractFeatures(ctx: MerchantContext): Promise<void> {
  const escrows = [
    { status: 'RELEASED', amount: '2500.00', days: 21 },
    { status: 'FUNDED', amount: '1800.00', days: 6 },
    { status: 'FUNDED', amount: '450.00', days: 3 },
    { status: 'SUBMITTED', amount: '920.00', days: 1 },
    { status: 'REFUNDED', amount: '300.00', days: 14 },
  ];
  for (const [i, e] of escrows.entries()) {
    const createdAt = new Date(now - e.days * DAY);
    await prisma.escrow.upsert({
      where: { id: `demo-escrow-${i + 1}` },
      update: {},
      create: {
        id: `demo-escrow-${i + 1}`,
        userId: ctx.userId,
        contractId: 500 + i,
        initiatorPublicKey: addr('merchant-settlement'),
        counterpartyPublicKey: addr(`counterparty-${i}`),
        arbiterPublicKey: i === 1 ? addr('arbiter') : null,
        assetCode: 'USDC',
        assetIssuer: addr('usdc-issuer'),
        amount: e.amount,
        releaseTime: new Date(createdAt.getTime() + 7 * DAY),
        expiry: new Date(createdAt.getTime() + 30 * DAY),
        status: e.status as never,
        hash: txHash(`escrow-create-${i}`),
        releaseHash: e.status === 'RELEASED' ? txHash(`escrow-release-${i}`) : null,
        refundHash: e.status === 'REFUNDED' ? txHash(`escrow-refund-${i}`) : null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }

  const plans = [
    { name: 'Coffee Club — Monthly', amount: '24.00', interval: 30 * 24 * 3600, planId: 7 },
    { name: "Roaster's Table — Weekly", amount: '9.50', interval: 7 * 24 * 3600, planId: 8 },
  ];
  for (const [i, p] of plans.entries()) {
    await prisma.subscriptionPlan.upsert({
      where: { id: `demo-plan-${i + 1}` },
      update: {},
      create: {
        id: `demo-plan-${i + 1}`,
        userId: ctx.userId,
        name: p.name,
        description: 'Recurring on-chain billing via the subscriptions contract.',
        assetCode: 'USDC',
        assetIssuer: addr('usdc-issuer'),
        amount: p.amount,
        intervalSeconds: p.interval,
        contractPlanId: p.planId,
        status: 'ACTIVE',
        hash: txHash(`plan-${i}`),
      },
    });
  }

  const subs = [
    { plan: 'demo-plan-1', status: 'ACTIVE', days: 12 },
    { plan: 'demo-plan-2', status: 'ACTIVE', days: 4 },
    { plan: 'demo-plan-1', status: 'CANCELED', days: 30 },
  ];
  for (const [i, s] of subs.entries()) {
    const createdAt = new Date(now - s.days * DAY);
    await prisma.subscription.upsert({
      where: { id: `demo-sub-${i + 1}` },
      update: {},
      create: {
        id: `demo-sub-${i + 1}`,
        userId: ctx.userId,
        planId: s.plan,
        contractSubscriptionId: 900 + i,
        status: s.status as never,
        nextPaymentAt: s.status === 'ACTIVE' ? new Date(now + 5 * DAY) : null,
        hash: txHash(`sub-${i}`),
        cancelHash: s.status === 'CANCELED' ? txHash(`sub-cancel-${i}`) : null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }

  const ops = [
    { type: 'DEPOSIT', amount: '20000.00', status: 'CONFIRMED', days: 26 },
    { type: 'DEPOSIT', amount: '7500.00', status: 'CONFIRMED', days: 11 },
    { type: 'WITHDRAWAL', amount: '4200.00', status: 'CONFIRMED', days: 5 },
    { type: 'DEPOSIT', amount: '1000.00', status: 'SUBMITTED', days: 1 },
  ];
  for (const [i, o] of ops.entries()) {
    const createdAt = new Date(now - o.days * DAY);
    await prisma.treasuryOperation.upsert({
      where: { id: `demo-treasury-op-${i + 1}` },
      update: {},
      create: {
        id: `demo-treasury-op-${i + 1}`,
        userId: ctx.userId,
        type: o.type as never,
        assetCode: 'USDC',
        assetIssuer: addr('usdc-issuer'),
        amount: o.amount,
        status: o.status as never,
        hash: txHash(`treasury-op-${i}`),
        createdAt,
        updatedAt: createdAt,
      },
    });
  }

  const withdrawals = [
    {
      amount: '4200.00',
      status: 'EXECUTED',
      approvals: [addr('gov-1'), addr('gov-2')],
      threshold: 2,
      days: 5,
    },
    { amount: '2500.00', status: 'APPROVED', approvals: [addr('gov-1')], threshold: 3, days: 2 },
    { amount: '900.00', status: 'PROPOSED', approvals: [], threshold: 3, days: 1 },
  ];
  for (const [i, w] of withdrawals.entries()) {
    const createdAt = new Date(now - w.days * DAY);
    await prisma.treasuryWithdrawal.upsert({
      where: { id: `demo-withdrawal-${i + 1}` },
      update: {},
      create: {
        id: `demo-withdrawal-${i + 1}`,
        userId: ctx.userId,
        operationId: i === 0 ? 'demo-treasury-op-3' : null,
        toPublicKey: addr('merchant-settlement'),
        assetCode: 'USDC',
        assetIssuer: addr('usdc-issuer'),
        amount: w.amount,
        contractWithdrawalId: 300 + i,
        approvals: w.approvals,
        threshold: w.threshold,
        status: w.status as never,
        hash: txHash(`withdrawal-${i}`),
        executedHash: w.status === 'EXECUTED' ? txHash(`withdrawal-exec-${i}`) : null,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
}

/** Notifications + audit history so the admin and notification pages look live. */
async function seedNotificationsAndAudit(ctx: MerchantContext): Promise<void> {
  const notes = [
    { type: 'PAYMENT_RECEIVED', title: 'Payment received — 480.00 USDC', status: 'READ', hours: 3 },
    { type: 'INVOICE_PAID', title: 'Invoice INV-2026-1001 paid', status: 'SENT', hours: 9 },
    {
      type: 'PAYMENT_RECEIVED',
      title: 'Payment received — 120.50 USDC',
      status: 'READ',
      hours: 26,
    },
    {
      type: 'FAILED_TRANSACTION',
      title: 'Payout failed — insufficient reserve',
      status: 'SENT',
      hours: 40,
    },
    { type: 'ACCOUNT_ACTIVITY', title: 'New device signed in', status: 'READ', hours: 60 },
    { type: 'PAYMENT_SENT', title: 'Settlement sent — 6,115.20 USDC', status: 'SENT', hours: 96 },
  ];
  for (const [i, n] of notes.entries()) {
    const createdAt = new Date(now - n.hours * 3600 * 1000);
    await prisma.notification.upsert({
      where: { id: `demo-notification-${i + 1}` },
      update: {},
      create: {
        id: `demo-notification-${i + 1}`,
        userId: ctx.userId,
        type: n.type as never,
        channel: 'IN_APP',
        title: n.title,
        body: 'Demo dataset entry used for the product walkthrough.',
        status: n.status as never,
        readAt: n.status === 'READ' ? createdAt : null,
        createdAt,
      },
    });
  }

  const actions = [
    'auth.login',
    'payment.create',
    'payment.confirm',
    'invoice.issue',
    'merchant.settle',
    'escrow.create',
    'escrow.release',
    'subscription.plan.create',
    'treasury.deposit',
    'treasury.withdrawal.propose',
    'webhook.deliver',
    'settings.update',
  ];
  for (const [i, action] of actions.entries()) {
    const createdAt = new Date(now - (i * 5 + 1) * 3600 * 1000);
    await prisma.auditLog.upsert({
      where: { id: `demo-audit-${i + 1}` },
      update: {},
      create: {
        id: `demo-audit-${i + 1}`,
        userId: ctx.userId,
        actorPublicKey: addr('merchant-settlement'),
        action,
        resource: action.split('.')[0],
        resourceId: `demo-${i + 1}`,
        ipAddress: `203.0.113.${10 + i}`,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0',
        metadata: { result: 'ok', source: 'demo-dataset' },
        createdAt,
      },
    });
  }

  const events = [
    { source: 'horizon', ledger: 1284411 },
    { source: 'soroban', ledger: 1284390 },
    { source: 'soroban', ledger: 1284377 },
    { source: 'horizon', ledger: 1284361 },
    { source: 'soroban', ledger: 1284344 },
    { source: 'soroban', ledger: 1284320 },
    { source: 'horizon', ledger: 1284302 },
    { source: 'soroban', ledger: 1284288 },
  ];
  for (const [i, e] of events.entries()) {
    await prisma.chainEvent.upsert({
      where: { eventId: `demo-event-${i + 1}` },
      update: {},
      create: {
        id: `demo-event-${i + 1}`,
        eventId: `demo-event-${i + 1}`,
        source: e.source,
        txHash: txHash(`event-${i}`),
        contractId: i % 2 === 0 ? null : addr('payment-contract'),
        ledger: e.ledger,
        createdAt: new Date(now - (i * 4 + 1) * 3600 * 1000),
      },
    });
  }

  // Payment link counters so the merchant page shows conversion.
  await prisma.paymentLink.update({
    where: { id: ctx.paymentLinkId },
    data: { totalPayments: 38, totalCollected: '1842.50', status: 'ACTIVE' },
  });

  // A webhook + delivery history for the admin integration view.
  const hook = await prisma.webhook.upsert({
    where: { id: 'demo-webhook-1' },
    update: {},
    create: {
      id: 'demo-webhook-1',
      merchantId: ctx.merchantId,
      url: 'https://demo-coffee.example.com/webhooks/stellar-pay',
      secret: linkHash('webhook-secret'),
      events: ['payment.received', 'invoice.paid', 'settlement.completed'],
      status: 'ACTIVE',
    },
  });
  for (let i = 0; i < 6; i++) {
    await prisma.webhookDelivery.upsert({
      where: { id: `demo-delivery-${i + 1}` },
      update: {},
      create: {
        id: `demo-delivery-${i + 1}`,
        webhookId: hook.id,
        event: ['payment.received', 'invoice.paid', 'settlement.completed'][i % 3],
        payload: { demo: true, index: i },
        status: i === 4 ? 'FAILED' : 'DELIVERED',
        responseStatus: i === 4 ? 500 : 200,
        lastError:
          i === 4 ? 'HTTP 500 from https://demo-coffee.example.com/webhooks/stellar-pay' : null,
        attempts: i === 4 ? 3 : 1,
        deliveredAt: i === 4 ? null : new Date(now - i * 3600 * 1000),
        createdAt: new Date(now - i * 3600 * 1000),
      },
    });
  }
}

async function main(): Promise<void> {
  const ctx = await merchantContext();
  const customerIds = await seedCustomers(ctx);
  await seedTransactions(ctx);
  await seedInvoices(ctx, customerIds);
  await seedSettlements(ctx);
  await seedContractFeatures(ctx);
  await seedNotificationsAndAudit(ctx);

  const counts = {
    transactions: await prisma.transaction.count(),
    customers: await prisma.customer.count(),
    invoices: await prisma.invoice.count(),
    settlements: await prisma.settlement.count(),
    escrows: await prisma.escrow.count(),
    subscriptions: await prisma.subscription.count(),
    treasuryOperations: await prisma.treasuryOperation.count(),
    notifications: await prisma.notification.count(),
    auditLogs: await prisma.auditLog.count(),
    chainEvents: await prisma.chainEvent.count(),
  };
  console.log('Demo dataset ready:', counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
