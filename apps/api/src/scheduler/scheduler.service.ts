import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaService } from '@stellar-pay/database';
import { RedisService } from '../infra/redis.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { createLogger } from '@stellar-pay/logger';
import { NotificationsService } from '../notifications/notifications.service';
import { IndexerService } from '../indexer/indexer.service';
import { HorizonInboundService } from '../indexer/horizon-inbound.service';
import { PaymentLinksService } from '../payment-links/payment-links.service';
import type { NotificationType } from '@stellar-pay/types';

/**
 * In-process scheduler. Production deployments should move these jobs to a
 * durable queue (e.g. BullMQ + Redis) - the interfaces are identical.
 *
 * Scheduled/recurring processing follows a confirmation-gated lifecycle:
 * a due schedule gets a PENDING transaction created (never a status flip),
 * the schedule is advanced (`totalRuns`/`nextRunAt`/`COMPLETED`) only when
 * that occurrence's transaction is confirmed on-chain — see
 * `TransactionReconciliationService.advanceScheduledPayment`, which the
 * submit/confirm paths invoke. An occurrence that is never approved, or that
 * fails, leaves the schedule due so the next tick retries it.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('scheduler');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly webhooks: WebhooksService,
    private readonly notifications: NotificationsService,
    private readonly indexer: IndexerService,
    private readonly horizonInbound: HorizonInboundService,
    private readonly paymentLinks: PaymentLinksService,
  ) {}

  onModuleInit(): void {
    this.timers.push(setInterval(() => void this.processScheduledPayments(), 60_000));
    this.timers.push(setInterval(() => void this.processSubscriptionRenewals(), 120_000));
    this.timers.push(setInterval(() => void this.retryWebhooks(), 30_000));
    this.timers.push(setInterval(() => void this.expireSessions(), 10 * 60_000));
    this.timers.push(setInterval(() => void this.processPendingSettlements(), 5 * 60_000));
    this.timers.push(setInterval(() => void this.pollIndexer(), 20_000));
    this.timers.push(setInterval(() => void this.pollHorizonInbound(), 15_000));
    this.timers.push(setInterval(() => void this.expirePaymentLinks(), 5 * 60_000));
    this.logger.info('scheduler started');
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
  }

  /**
   * Due scheduled/recurring payments become PENDING transactions awaiting
   * user approval and on-chain confirmation (the schedule itself is advanced
   * only on confirmation). In production, wire an approved-signer service or
   * a user-facing approval flow here.
   */
  private async processScheduledPayments(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:scheduled', 55))) {
      return;
    }
    const due = await this.prisma.scheduledPayment.findMany({
      where: { status: 'ACTIVE', nextRunAt: { lte: new Date() } },
      take: 20,
    });
    let created = 0;
    for (const scheduled of due) {
      const kind = scheduled.interval ? 'recurring' : 'scheduled';
      if (await this.createOccurrence(scheduled, kind)) {
        created++;
      }
    }
    if (created) {
      this.logger.info({ created }, 'scheduled payment occurrences created');
    }
  }

  /**
   * Create one PENDING occurrence transaction for a due schedule — without
   * touching the schedule row. Skips when an occurrence is already in flight
   * (a PENDING/SUBMITTED transaction referencing this schedule), so the
   * overlapping scheduled/subscription ticks can never double-create.
   * @returns true when a new occurrence was created.
   */
  private async createOccurrence(
    scheduled: {
      id: string;
      userId: string;
      fromPublicKey: string;
      toPublicKey: string;
      amount: string;
      assetCode: string;
      assetIssuer: string | null;
      memo: string | null;
      totalRuns: number;
    },
    kind: string,
  ): Promise<boolean> {
    const inFlight = await this.prisma.transaction.findFirst({
      where: {
        status: { in: ['PENDING', 'SUBMITTED'] },
        meta: { path: ['scheduledId'], equals: scheduled.id },
      } satisfies Prisma.TransactionWhereInput,
    });
    if (inFlight) {
      return false; // occurrence already created and awaiting approval/confirmation
    }
    const tx = await this.prisma.transaction.create({
      data: {
        userId: scheduled.userId,
        fromPublicKey: scheduled.fromPublicKey,
        toPublicKey: scheduled.toPublicKey,
        amount: scheduled.amount,
        assetCode: scheduled.assetCode,
        assetIssuer: scheduled.assetIssuer,
        memo: scheduled.memo,
        memoType: 'text',
        status: 'PENDING',
        direction: 'OUTGOING',
        kind,
        sourceNetwork: 'testnet',
        meta: { scheduledId: scheduled.id, run: scheduled.totalRuns + 1 },
      },
    });
    await this.notifications.notify(
      scheduled.userId,
      'ACCOUNT_ACTIVITY' as NotificationType,
      kind === 'subscription_renewal'
        ? 'Subscription renewal is due'
        : 'Scheduled payment is ready',
      { transactionId: tx.id, amount: scheduled.amount, assetCode: scheduled.assetCode },
    );
    return true;
  }

  /**
   * Contract-route settlement confirmation: moves SUBMITTED contract sends to
   * CONFIRMED once Soroban RPC reports the invocation succeeded on-chain, and
   * best-effort ingests payment-contract events (cursor persisted in Redis).
   * Idle (no RPC/contract configured) when the contract route is off.
   */
  private async pollIndexer(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:indexer', 15))) {
      return;
    }
    await this.indexer.syncOnce();
  }

  /**
   * Inbound direct-to-merchant detection: polls Horizon account payment feeds
   * and credits merchant inbound payments that never went through the API.
   */
  private async pollHorizonInbound(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:horizon-inbound', 12))) {
      return;
    }
    await this.horizonInbound.syncOnce();
  }

  private async retryWebhooks(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:webhooks', 25))) {
      return;
    }
    const retried = await this.webhooks.retryDueDeliveries();
    if (retried) {
      this.logger.info({ retried }, 'webhook deliveries retried');
    }
  }

  private async expirePaymentLinks(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:payment-links', 240))) {
      return;
    }
    const expired = await this.paymentLinks.expireDue();
    if (expired) {
      this.logger.info({ expired }, 'expired payment links marked EXPIRED');
    }
  }

  private async expireSessions(): Promise<void> {
    await this.prisma.session.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }

  /**
   * Due subscription renewals (interval schedules) become PENDING occurrence
   * transactions. In production this calls the subscriptions contract's
   * `renew` entry point through Soroban RPC; the local path keeps the same
   * confirmation-gated lifecycle as scheduled payments — the schedule
   * advances only when the occurrence transaction is confirmed on-chain.
   */
  private async processSubscriptionRenewals(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:subscriptions', 110))) {
      return;
    }
    const due = await this.prisma.scheduledPayment.findMany({
      where: {
        status: 'ACTIVE',
        interval: { not: null },
        nextRunAt: { lte: new Date() },
      },
      take: 20,
    });
    let created = 0;
    for (const scheduled of due) {
      if (await this.createOccurrence(scheduled, 'subscription_renewal')) {
        created++;
      }
    }
    if (created) {
      this.logger.info({ created }, 'subscription renewal occurrences created');
    }
  }

  /**
   * Process merchant settlements in PENDING status.
   * In production, this invokes the merchant contract's `settle` entry point.
   */
  private async processPendingSettlements(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:settlements', 290))) {
      return;
    }
    const pending = await this.prisma.settlement.findMany({
      where: { status: 'PENDING' },
      take: 10,
    });
    for (const settlement of pending) {
      await this.prisma.settlement.update({
        where: { id: settlement.id },
        data: { status: 'PROCESSING' },
      });
      this.logger.info(
        { settlementId: settlement.id, amount: settlement.amount },
        'settlement processing started',
      );
      // In production: invoke merchant contract settle(), then update to COMPLETED.
    }
  }
}
