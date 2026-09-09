import { Injectable } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { NotificationType, WebhookEventType } from '@stellar-pay/types';

/** Minimal structural view of a persisted Transaction row after submission. */
export interface ReconcilableTransaction {
  id: string;
  amount: string;
  assetCode: string;
  toPublicKey: string | null;
  kind: string;
  meta: unknown;
}

interface TxMeta {
  type?: string;
  invoiceNumber?: string;
  paymentLinkCode?: string;
}

/**
 * Post-submission bookkeeping shared by every success path (authenticated
 * sends via `/payments/:id/submit`, public checkout via
 * `/checkout/transactions/:id/submit`, and the indexer's on-chain
 * CONFIRMED transition):
 *
 *  - mark a paid invoice as PAID (and notify the merchant);
 *  - bump payment-link collected stats;
 *  - advance a scheduled/recurring payment only after the occurrence's
 *    transaction is confirmed (never when the occurrence is merely created);
 *  - dispatch the `payment.received` webhook.
 *
 * Payer-scoped notifications / realtime events remain the caller's
 * responsibility (public checkout has no platform user session).
 */
@Injectable()
export class TransactionReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async onPaymentSucceeded(tx: ReconcilableTransaction): Promise<void> {
    const meta = (tx.meta ?? {}) as TxMeta;

    // Resolve the merchant that owns this payment so webhook fan-out stays
    // owner-scoped. Payer-initiated sends without an invoice/link have no
    // merchant owner and must not trigger a broadcast.
    let ownerMerchantId: string | undefined;
    if (meta.type === 'INVOICE' || tx.kind === 'invoice') {
      ownerMerchantId = await this.reconcileInvoicePayment(tx, meta.invoiceNumber);
    } else if (meta.type === 'PAYMENT_LINK') {
      ownerMerchantId = await this.reconcilePaymentLinkPayment(tx, meta.paymentLinkCode);
    }

    if (ownerMerchantId) {
      await this.webhooks.dispatch(
        'payment.received' as WebhookEventType,
        {
          transactionId: tx.id,
          amount: tx.amount,
          assetCode: tx.assetCode,
          toPublicKey: tx.toPublicKey,
        },
        { merchantId: ownerMerchantId },
      );
      // Live merchant-dashboard update — same `payment.received` event the
      // inbound-detection path emits, so checkout invoice/link payments appear
      // in real time on the merchant's Socket.IO room.
      await this.pushRealtimeToMerchant(ownerMerchantId, tx);
    }
  }

  /** Emit `payment.received` to the merchant user's realtime room. */
  private async pushRealtimeToMerchant(
    merchantId: string,
    tx: ReconcilableTransaction,
  ): Promise<void> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { userId: true },
    });
    if (!merchant?.userId) {
      return;
    }
    this.realtime.emitToUser(merchant.userId, 'payment.received', {
      transactionId: tx.id,
      status: 'CONFIRMED',
      amount: tx.amount,
      assetCode: tx.assetCode,
      toPublicKey: tx.toPublicKey,
      source: 'checkout',
    });
  }

  /** @returns the owning merchant id when the invoice was newly marked PAID. */
  private async reconcileInvoicePayment(
    tx: ReconcilableTransaction,
    invoiceNumber?: string,
  ): Promise<string | undefined> {
    const invoice = invoiceNumber
      ? await this.prisma.invoice.findUnique({ where: { number: invoiceNumber } })
      : await this.prisma.invoice.findFirst({
          where: {
            customerPublicKey: tx.toPublicKey ?? undefined,
            status: { in: ['ISSUED', 'DRAFT'] },
          },
          orderBy: { createdAt: 'desc' },
        });

    if (!invoice || !['ISSUED', 'DRAFT'].includes(invoice.status)) {
      return undefined;
    }

    // Guarded transition: only the first reconciler wins the ISSUED/DRAFT →
    // PAID update, so two payments racing for the same invoice cannot fire
    // double notifications/webhooks or overwrite the PAID state.
    const paid = await this.prisma.invoice.updateMany({
      where: { id: invoice.id, status: { in: ['ISSUED', 'DRAFT'] } },
      data: { status: 'PAID', paidAt: new Date(), paymentTransactionId: tx.id },
    });
    if (paid.count !== 1) {
      return undefined; // another reconciler already marked it PAID
    }
    await this.notifications.invoicePaid({
      merchantId: invoice.merchantId,
      invoiceNumber: invoice.number,
    });
    await this.webhooks.dispatch(
      'invoice.paid' as WebhookEventType,
      {
        invoiceNumber: invoice.number,
        transactionId: tx.id,
      },
      { merchantId: invoice.merchantId },
    );
    return invoice.merchantId;
  }

  /**
   * Advance a scheduled/recurring payment after one of its occurrences is
   * confirmed on-chain. The scheduler only creates the PENDING occurrence;
   * it deliberately does NOT advance `nextRunAt`/`totalRuns` at creation
   * time, so a schedule that is never submitted (or fails) simply stays due
   * and is retried, and a confirmed occurrence is what moves the schedule
   * forward. The `status: 'ACTIVE'` guard makes the advance at-most-once even
   * if two confirm paths race, and a schedule can never go backwards from a
   * terminal state.
   */
  async advanceScheduledPayment(tx: { id: string; meta: unknown }): Promise<void> {
    const meta = (tx.meta ?? {}) as { scheduledId?: string; run?: number };
    if (!meta.scheduledId) {
      return;
    }
    const scheduled = await this.prisma.scheduledPayment.findUnique({
      where: { id: meta.scheduledId },
    });
    if (!scheduled || scheduled.status !== 'ACTIVE') {
      return; // unknown, paused, canceled or already completed — no-op
    }

    const runs = scheduled.totalRuns + 1;
    const completed = scheduled.maxRuns ? runs >= scheduled.maxRuns : false;
    const intervalMs =
      scheduled.interval === 'monthly'
        ? 30 * 24 * 3600 * 1000
        : scheduled.interval === 'weekly'
          ? 7 * 24 * 3600 * 1000
          : 24 * 3600 * 1000;
    const now = new Date();
    const advanced = await this.prisma.scheduledPayment.updateMany({
      where: { id: scheduled.id, status: 'ACTIVE' },
      data: {
        status: completed ? 'COMPLETED' : 'ACTIVE',
        totalRuns: runs,
        lastRunAt: now,
        nextRunAt: completed ? now : new Date(now.getTime() + intervalMs),
      },
    });
    if (advanced.count === 0) {
      return; // a concurrent reconciler already advanced it — idempotent
    }
    await this.notifications.notify(
      scheduled.userId,
      'ACCOUNT_ACTIVITY' as NotificationType,
      completed ? 'Scheduled payment plan completed' : 'Scheduled payment confirmed',
      { scheduledId: scheduled.id, transactionId: tx.id, run: runs },
    );
  }

  /** @returns the owning merchant id when the link was ACTIVE and credited. */
  private async reconcilePaymentLinkPayment(
    tx: ReconcilableTransaction,
    code?: string,
  ): Promise<string | undefined> {
    const link = code
      ? await this.prisma.paymentLink.findUnique({ where: { code } })
      : await this.prisma.paymentLink.findFirst({
          where: { merchant: { settlementPublicKey: tx.toPublicKey ?? '' }, status: 'ACTIVE' },
        });

    if (!link || link.status !== 'ACTIVE') {
      return undefined;
    }

    await this.prisma.paymentLink.update({
      where: { id: link.id },
      data: {
        totalPayments: { increment: 1 },
        totalCollected: String(Number(link.totalCollected) + Number(tx.amount)),
      },
    });
    return link.merchantId;
  }
}
