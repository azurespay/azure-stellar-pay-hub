import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@stellar-pay/database';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TransactionReconciliationService } from '../payments/transaction-reconciliation.service';
import type { WebhookEventType } from '@stellar-pay/types';

export type InboundSource = 'horizon' | 'soroban';

export interface InboundPaymentInput {
  /** Deterministic on-chain id unique within `source` (paging token / RPC event id). */
  eventId: string;
  source: InboundSource;
  fromPublicKey: string;
  toPublicKey: string;
  /** Decimal units, e.g. "10" (convert stroops before calling). */
  amount: string;
  assetCode: string;
  assetIssuer?: string | null;
  hash?: string | null;
  /** When present and it matches an open invoice number for the merchant, the invoice is marked PAID. */
  memo?: string | null;
  contractId?: string | null;
  ledger?: number | null;
}

const DUPLICATE_CODE = 'P2002';

/**
 * Reconciliation for payments that arrived on-chain without an API submission
 * (a wallet paying a merchant address directly). Both inbound listeners
 * (Horizon classic payments and Soroban contract `payment` events) funnel into
 * this single path so credit semantics stay identical:
 *
 *  1. **Idempotency** — a `ChainEvent` row with a unique deterministic event
 *     id is inserted first; a duplicate delivery violates the unique
 *     constraint and is ignored before any state is touched.
 *  2. **Merchant match** — the recipient must be an ACTIVE merchant's
 *     settlement address, or the payment is ignored.
 *  3. **No double credit** — if the transaction hash already exists on a
 *     platform record, the inbound is skipped (it was already captured).
 *  4. **Invoice reconciliation** — a memo equal to an ISSUED/DRAFT invoice
 *     number for that merchant (with matching asset + amount) reuses
 *     `TransactionReconciliationService` to mark it PAID + notify + webhook.
 *  5. Side effects (in-app notification, `payment.received` webhook,
 *     Socket.IO event to the merchant user) fire exactly once per event.
 */
@Injectable()
export class InboundReconciliationService {
  private readonly logger = new Logger('InboundReconciliationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly realtime: RealtimeGateway,
    private readonly reconciliation: TransactionReconciliationService,
  ) {}

  private networkLabel(): string {
    return this.config.get<string>('STELLAR_NETWORK') ?? 'testnet';
  }

  async handle(input: InboundPaymentInput): Promise<{ created: boolean; transactionId?: string }> {
    const eventKey = `${input.source}:${input.eventId}`;

    // 1. Idempotency: claim the event id first. Duplicate deliveries lose the
    //    unique race here and never reach state changes below.
    try {
      await this.prisma.chainEvent.create({
        data: {
          eventId: eventKey,
          source: input.source,
          txHash: input.hash ?? null,
          contractId: input.contractId ?? null,
          ledger: input.ledger ?? null,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === DUPLICATE_CODE) {
        return { created: false }; // already processed — idempotent
      }
      this.logger.warn(
        { err: (err as Error).message, eventId: eventKey },
        'chainEvent insert failed',
      );
      return { created: false };
    }

    const numericAmount = Number(input.amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      this.logger.warn({ eventId: eventKey, amount: input.amount }, 'invalid inbound amount');
      return { created: false };
    }

    // 2. The recipient must be an ACTIVE merchant settlement address.
    const merchant = await this.prisma.merchant.findFirst({
      where: { settlementPublicKey: input.toPublicKey, status: 'ACTIVE' },
    });
    if (!merchant) {
      this.logger.log(
        { eventId: eventKey, to: input.toPublicKey },
        'inbound payment not for a registered merchant — ignored',
      );
      return { created: false };
    }

    // 3. Skip when the on-chain transaction is already recorded by the platform.
    if (input.hash) {
      const existing = await this.prisma.transaction.findFirst({ where: { hash: input.hash } });
      if (existing) {
        return { created: false };
      }
    }

    // 4. Invoice match (memo = invoice number), verified by asset + amount.
    const invoice =
      input.memo && input.assetCode
        ? await this.prisma.invoice.findFirst({
            where: {
              number: input.memo,
              merchantId: merchant.id,
              status: { in: ['ISSUED', 'DRAFT'] },
              assetCode: input.assetCode,
            },
          })
        : null;
    const invoiceMatches = invoice
      ? normalizeAmount(invoice.amount) === normalizeAmount(input.amount)
      : false;

    let transaction;
    try {
      transaction = await this.prisma.transaction.create({
        data: {
          userId: null,
          fromPublicKey: input.fromPublicKey,
          toPublicKey: input.toPublicKey,
          amount: input.amount,
          assetCode: input.assetCode,
          assetIssuer: input.assetIssuer ?? null,
          memo: input.memo ?? null,
          memoType: 'text',
          status: 'CONFIRMED',
          direction: 'INCOMING',
          kind: invoiceMatches ? 'invoice' : 'inbound',
          hash: input.hash ?? null,
          sourceNetwork: this.networkLabel(),
          meta: {
            source: input.source,
            eventId: `${input.source}:${input.eventId}`,
            ...(invoiceMatches
              ? { type: 'INVOICE', invoiceNumber: invoice!.number, merchantId: merchant.id }
              : { merchantId: merchant.id }),
          },
        },
      });
    } catch (err) {
      // The `hash` unique constraint is the last line of defence: a different
      // event id arriving for a hash that a concurrent worker already credited
      // (e.g. the same on-chain payment seen by both listeners) must not create
      // a second platform record or fire duplicate side effects.
      if ((err as { code?: string }).code === DUPLICATE_CODE) {
        return { created: false };
      }
      this.logger.warn(
        { err: (err as Error).message, eventId: eventKey },
        'inbound transaction insert failed',
      );
      return { created: false };
    }

    if (invoiceMatches) {
      // Reuse the shared post-success reconciliation: marks the invoice PAID,
      // notifies the merchant, dispatches invoice.paid + payment.received.
      await this.reconciliation.onPaymentSucceeded(transaction as never);
    } else {
      await this.notifications.paymentReceived({
        userId: merchant.userId,
        amount: input.amount,
        assetCode: input.assetCode,
        toPublicKey: input.fromPublicKey,
      });
      await this.webhooks.dispatch(
        'payment.received' as WebhookEventType,
        {
          transactionId: transaction.id,
          merchantId: merchant.id,
          fromPublicKey: input.fromPublicKey,
          amount: input.amount,
          assetCode: input.assetCode,
          source: input.source,
        },
        { merchantId: merchant.id },
      );
    }

    // 5. Push the live update to the merchant dashboard.
    this.realtime.emitToUser(merchant.userId, 'payment.received', {
      transactionId: transaction.id,
      status: 'CONFIRMED',
      fromPublicKey: input.fromPublicKey,
      toPublicKey: input.toPublicKey,
      amount: input.amount,
      assetCode: input.assetCode,
      source: input.source,
    });

    this.logger.log(
      { eventId: eventKey, transactionId: transaction.id, kind: transaction.kind },
      'inbound payment credited',
    );
    return { created: true, transactionId: transaction.id };
  }
}

/** Normalize a decimal string ("10.0000000" → "10") for exact comparison. */
export function normalizeAmount(amount: string): string {
  const trimmed = amount.trim();
  const [whole, fraction = ''] = trimmed.split('.');
  const significant = fraction.replace(/0+$/, '');
  return significant
    ? `${whole.replace(/^0+(?=\d)/, '')}.${significant}`
    : whole.replace(/^0+(?=\d)/, '');
}
