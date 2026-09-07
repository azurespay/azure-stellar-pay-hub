import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { RedisService } from '../infra/redis.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { createLogger } from '@stellar-pay/logger';
import { NotificationsService } from '../notifications/notifications.service';
import { IndexerService } from '../indexer/indexer.service';
import type { NotificationType } from '@stellar-pay/types';

/**
 * In-process scheduler. Production deployments should move these jobs to a
 * durable queue (e.g. BullMQ + Redis) - the interfaces are identical.
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
  ) {}

  onModuleInit(): void {
    this.timers.push(setInterval(() => void this.processScheduledPayments(), 60_000));
    this.timers.push(setInterval(() => void this.processSubscriptionRenewals(), 120_000));
    this.timers.push(setInterval(() => void this.retryWebhooks(), 30_000));
    this.timers.push(setInterval(() => void this.expireSessions(), 10 * 60_000));
    this.timers.push(setInterval(() => void this.processPendingSettlements(), 5 * 60_000));
    this.timers.push(setInterval(() => void this.pollIndexer(), 20_000));
    this.logger.info('scheduler started');
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
  }

  /**
   * Due scheduled/recurring payments become PENDING transactions awaiting
   * user approval. In production, wire an approved-signer service or a
   * user-facing approval flow here.
   */
  private async processScheduledPayments(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:scheduled', 55))) {
      return;
    }
    const due = await this.prisma.scheduledPayment.findMany({
      where: { status: 'ACTIVE', nextRunAt: { lte: new Date() } },
      take: 20,
    });
    for (const scheduled of due) {
      const runs = scheduled.totalRuns + 1;
      const completed = scheduled.maxRuns ? runs >= scheduled.maxRuns : false;
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
          kind: scheduled.interval ? 'recurring' : 'scheduled',
          sourceNetwork: 'testnet',
          meta: { scheduledId: scheduled.id },
        },
      });
      await this.prisma.scheduledPayment.update({
        where: { id: scheduled.id },
        data: {
          status: completed ? 'COMPLETED' : 'ACTIVE',
          totalRuns: runs,
          lastRunAt: new Date(),
          nextRunAt: completed
            ? new Date()
            : new Date(
                Date.now() +
                  24 *
                    3600 *
                    1000 *
                    (scheduled.interval === 'monthly'
                      ? 30
                      : scheduled.interval === 'weekly'
                        ? 7
                        : 1),
              ),
        },
      });
      await this.notifications.notify(
        scheduled.userId,
        'ACCOUNT_ACTIVITY' as NotificationType,
        scheduled.interval ? 'Recurring payment is due' : 'Scheduled payment is ready',
        { transactionId: tx.id, amount: scheduled.amount, assetCode: scheduled.assetCode },
      );
    }
    if (due.length) {
      this.logger.info({ count: due.length }, 'scheduled payments processed');
    }
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

  private async retryWebhooks(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:webhooks', 25))) {
      return;
    }
    const retried = await this.webhooks.retryDueDeliveries();
    if (retried) {
      this.logger.info({ retried }, 'webhook deliveries retried');
    }
  }

  private async expireSessions(): Promise<void> {
    await this.prisma.session.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }

  /**
   * Process subscription renewals via the Soroban subscriptions contract.
   * In production, this calls the contract's `renew` entry point through
   * the Soroban RPC. The scaffold simulates renewal by creating a PENDING
   * transaction for each due subscription and dispatching notifications.
   */
  private async processSubscriptionRenewals(): Promise<void> {
    if (!(await this.redis.acquireLock('scheduler:subscriptions', 110))) {
      return;
    }
    // Find active subscriptions that are due for renewal.
    // This is a simplified local check — in production, query the
    // subscriptions contract on-chain for due subscriptions.
    const now = new Date();
    const due = await this.prisma.scheduledPayment.findMany({
      where: {
        status: 'ACTIVE',
        interval: { not: null },
        nextRunAt: { lte: now },
      },
      take: 20,
    });
    for (const scheduled of due) {
      const runs = scheduled.totalRuns + 1;
      const completed = scheduled.maxRuns ? runs >= scheduled.maxRuns : false;
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
          kind: 'subscription_renewal',
          sourceNetwork: 'testnet',
          meta: { scheduledId: scheduled.id, run: runs },
        },
      });
      // Advance to the next interval.
      const intervalMs =
        scheduled.interval === 'daily'
          ? 24 * 3600 * 1000
          : scheduled.interval === 'weekly'
            ? 7 * 24 * 3600 * 1000
            : 30 * 24 * 3600 * 1000;
      await this.prisma.scheduledPayment.update({
        where: { id: scheduled.id },
        data: {
          status: completed ? 'COMPLETED' : 'ACTIVE',
          totalRuns: runs,
          lastRunAt: now,
          nextRunAt: completed ? now : new Date(now.getTime() + intervalMs),
        },
      });
      await this.notifications.notify(
        scheduled.userId,
        'ACCOUNT_ACTIVITY' as NotificationType,
        `Subscription renewal processed: ${scheduled.amount} ${scheduled.assetCode}`,
        {
          transactionId: tx.id,
          amount: scheduled.amount,
          assetCode: scheduled.assetCode,
          run: runs,
        },
      );
    }
    if (due.length) {
      this.logger.info({ count: due.length }, 'subscription renewals processed');
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
