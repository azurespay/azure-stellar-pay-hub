import { Injectable } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import type { WebhookEventType } from '@stellar-pay/types';

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
 * sends via `/payments/:id/submit` and public checkout via
 * `/checkout/transactions/:id/submit`):
 *
 *  - mark a paid invoice as PAID (and notify the merchant);
 *  - bump payment-link collected stats;
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
  ) {}

  async onPaymentSucceeded(tx: ReconcilableTransaction): Promise<void> {
    const meta = (tx.meta ?? {}) as TxMeta;

    if (meta.type === 'INVOICE' || tx.kind === 'invoice') {
      await this.reconcileInvoicePayment(tx, meta.invoiceNumber);
    } else if (meta.type === 'PAYMENT_LINK') {
      await this.reconcilePaymentLinkPayment(tx, meta.paymentLinkCode);
    }

    await this.webhooks.dispatch('payment.received' as WebhookEventType, {
      transactionId: tx.id,
      amount: tx.amount,
      assetCode: tx.assetCode,
      toPublicKey: tx.toPublicKey,
    });
  }

  private async reconcileInvoicePayment(
    tx: ReconcilableTransaction,
    invoiceNumber?: string,
  ): Promise<void> {
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
      return;
    }

    // Guarded transition: only the first reconciler wins the ISSUED/DRAFT →
    // PAID update, so two payments racing for the same invoice cannot fire
    // double notifications/webhooks or overwrite the PAID state.
    const paid = await this.prisma.invoice.updateMany({
      where: { id: invoice.id, status: { in: ['ISSUED', 'DRAFT'] } },
      data: { status: 'PAID', paidAt: new Date(), paymentTransactionId: tx.id },
    });
    if (paid.count !== 1) {
      return; // another reconciler already marked it PAID
    }
    await this.notifications.invoicePaid({
      merchantId: invoice.merchantId,
      invoiceNumber: invoice.number,
    });
    await this.webhooks.dispatch('invoice.paid' as WebhookEventType, {
      invoiceNumber: invoice.number,
      transactionId: tx.id,
    });
  }

  private async reconcilePaymentLinkPayment(
    tx: ReconcilableTransaction,
    code?: string,
  ): Promise<void> {
    const link = code
      ? await this.prisma.paymentLink.findUnique({ where: { code } })
      : await this.prisma.paymentLink.findFirst({
          where: { merchant: { settlementPublicKey: tx.toPublicKey ?? '' }, status: 'ACTIVE' },
        });

    if (!link || link.status !== 'ACTIVE') {
      return;
    }

    await this.prisma.paymentLink.update({
      where: { id: link.id },
      data: {
        totalPayments: { increment: 1 },
        totalCollected: String(Number(link.totalCollected) + Number(tx.amount)),
      },
    });
  }
}
