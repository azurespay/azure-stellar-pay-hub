import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Networks } from '@stellar/stellar-sdk';
import { PrismaService } from '@stellar-pay/database';
import type { WebhookEventType } from '@stellar-pay/types';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { parseContractEvent } from './contract-events';
import { stroopsToUnits } from './soroban-event';
import type { ParsedEvent } from './contract-events';

/**
 * Reconciliation: advance platform records to their terminal states ONLY on
 * on-chain evidence (a parsed contract event with the invoking tx hash).
 *
 * Every transition is guarded (`updateMany` with a status predicate), so a
 * re-delivered event (cursor loss, RPC re-scan, duplicate poll) can never
 * double-apply: the first observation wins, later ones match no rows. Side
 * effects (realtime, notifications, webhooks) fire only on the winning
 * transition — the same idempotency pattern as the payment indexer.
 */
@Injectable()
export class ContractReconciliationService {
  private readonly logger = new Logger('ContractReconciliation');

  private escrow: string | undefined;
  private invoices: string | undefined;
  private subscriptions: string | undefined;
  private treasury: string | undefined;
  private merchant: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
  ) {
    this.escrow = this.config.get<string>('CONTRACT_STELLAR_PAY_ESCROW');
    this.invoices = this.config.get<string>('CONTRACT_STELLAR_PAY_INVOICES');
    this.subscriptions = this.config.get<string>('CONTRACT_STELLAR_PAY_SUBSCRIPTIONS');
    this.treasury = this.config.get<string>('CONTRACT_STELLAR_PAY_TREASURY');
    this.merchant = this.config.get<string>('CONTRACT_STELLAR_PAY_MERCHANT');
  }

  /** Route an event to the owning contract's reconciliation handler. */
  async reconcile(input: {
    contractId: string;
    eventId: string;
    txHash?: string | null;
    ledger?: number | null;
    topic: unknown;
    value?: string | { xdr: string } | null;
  }): Promise<void> {
    const rawValue = typeof input.value === 'string' ? input.value : input.value?.xdr;
    const event = parseContractEvent(input.topic, rawValue);
    if (!event) {
      return; // not one of our typed events (or unparseable) — ignore
    }

    try {
      await this.dispatch(input.contractId, event, input.txHash ?? null, input.eventId);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, topic: event.topic, contractId: input.contractId },
        'contract event reconciliation failed',
      );
    }
  }

  private async dispatch(
    contractId: string,
    event: ParsedEvent,
    txHash: string | null,
    eventId: string,
  ): Promise<void> {
    // Contract routing is by contractId because several contracts share event
    // names (`cancel`, `refund`, `deposit`, …). The platform's deployed
    // addresses are unique per contract, so matching here is exact.
    // The parser (`parseContractEvent`) guarantees each topic's field shape
    // (it returns null when required fields are missing), so casting the
    // ParsedEvent to the handler's typed shape here is safe.
    if (contractId === this.escrow) {
      switch (event.topic) {
        case 'created':
          return this.onEscrowCreated(event as never, txHash);
        case 'released':
          return this.onEscrowAction(event as never, txHash, 'released');
        case 'refund':
          return this.onEscrowAction(event as never, txHash, 'refund');
        default:
          return;
      }
    }
    if (contractId === this.invoices) {
      switch (event.topic) {
        case 'issued':
          return this.onInvoiceIssued(event as never, txHash);
        case 'paid':
          return this.onInvoicePaid(event as never, txHash);
        case 'cancel':
          return this.onInvoiceCanceled(event as never, txHash);
        default:
          return;
      }
    }
    if (contractId === this.subscriptions) {
      switch (event.topic) {
        case 'plan':
          return this.onSubscriptionPlanCreated(event as never, txHash);
        case 'sub':
          return this.onSubscriptionCreated(event as never, txHash);
        case 'renew':
          return this.onSubscriptionRenewed(event as never, txHash);
        case 'cancel':
          return this.onSubscriptionCanceled(event as never, txHash);
        default:
          return;
      }
    }
    if (contractId === this.treasury) {
      switch (event.topic) {
        case 'deposit':
          return this.onTreasuryDeposit(event as never, txHash);
        case 'wprop':
          return this.onWithdrawalProposed(event as never, txHash);
        case 'wappr':
          return this.onWithdrawalApproved(event as never, txHash);
        case 'wexec':
          return this.onWithdrawalExecuted(event as never, txHash);
        default:
          return;
      }
    }
    if (contractId === this.merchant) {
      switch (event.topic) {
        case 'reg':
          return this.onMerchantRegistered(event as never, txHash);
        case 'sale':
          return this.onMerchantSale(event as never, txHash, eventId);
        case 'settle':
          return this.onMerchantSettled(event as never, txHash);
        default:
          return;
      }
    }
  }

  // ── escrow ──────────────────────────────────────────────────────────────

  private async onEscrowCreated(
    event: { id: bigint; initiator: string; counterparty: string; amountStroops: bigint },
    txHash: string | null,
  ): Promise<void> {
    // Correlate by the create-invocation tx hash (recorded at submit) — exact,
    // unlike amount-based matching. Re-delivery: status is no longer SUBMITTED.
    const updated = await this.prisma.escrow.updateMany({
      where: { hash: txHash ?? undefined, status: 'SUBMITTED' },
      data: { contractId: Number(event.id), status: 'FUNDED' },
    });
    if (updated.count !== 1) {
      return;
    }
    const row = await this.prisma.escrow.findFirst({ where: { hash: txHash } });
    if (row) {
      this.realtime.emitToUser(row.userId, 'escrow.updated', {
        id: row.id,
        status: 'FUNDED',
        contractId: Number(event.id),
      });
    }
    this.logger.log(`escrow funded on-chain: contractId=${event.id}`);
  }

  private async onEscrowAction(
    event: { id: bigint; to: string; amountStroops: bigint },
    txHash: string | null,
    action: 'released' | 'refund',
  ): Promise<void> {
    const status = action === 'released' ? 'RELEASED' : 'REFUNDED';
    const hashField = action === 'released' ? 'releaseHash' : 'refundHash';
    const updated = await this.prisma.escrow.updateMany({
      where: { contractId: Number(event.id), status: 'FUNDED' },
      data: { status, [hashField]: txHash ?? undefined },
    });
    if (updated.count !== 1) {
      return;
    }
    const row = await this.prisma.escrow.findFirst({
      where: { contractId: Number(event.id) },
    });
    if (row) {
      this.realtime.emitToUser(row.userId, 'escrow.updated', {
        id: row.id,
        status,
      });
    }
    this.logger.log(`escrow ${action} on-chain: contractId=${event.id}`);
  }

  private async onInvoiceCanceled(
    event: { id: bigint; merchant: string },
    txHash: string | null,
  ): Promise<void> {
    await this.prisma.invoice.updateMany({
      where: { onChainId: Number(event.id), status: 'ISSUED' },
      data: { status: 'CANCELED' },
    });
  }

  // ── invoices ────────────────────────────────────────────────────────────

  private async onInvoiceIssued(
    event: { id: bigint; merchant: string; customer: string; amountStroops: bigint },
    txHash: string | null,
  ): Promise<void> {
    // Confirm the on-chain issue: record the contract invoice id. Status stays
    // ISSUED (the DB invoice is created ISSUED; PAID is the gated transition).
    await this.prisma.invoice.updateMany({
      where: { issueTxHash: txHash ?? undefined, onChainId: null },
      data: { onChainId: Number(event.id) },
    });
  }

  private async onInvoicePaid(
    event: { id: bigint; payer: string; merchant: string; amountStroops: bigint },
    txHash: string | null,
  ): Promise<void> {
    // The ONLY path to PAID for an on-chain invoice is this on-chain event.
    const updated = await this.prisma.invoice.updateMany({
      where: { onChainId: Number(event.id), status: 'ISSUED' },
      data: { status: 'PAID', paidAt: new Date() },
    });
    if (updated.count !== 1) {
      return;
    }
    const invoice = await this.prisma.invoice.findUnique({
      where: { onChainId: Number(event.id) },
      include: { merchant: { select: { userId: true, id: true } } },
    });
    if (!invoice) {
      return;
    }
    if (invoice.merchant.userId) {
      this.realtime.emitToUser(invoice.merchant.userId, 'invoice.updated', {
        id: invoice.id,
        status: 'PAID',
        hash: txHash,
      });
      await this.notifications.invoicePaid({
        merchantId: invoice.merchantId,
        invoiceNumber: invoice.number,
      });
    }
    // Signed `invoice.paid` webhook (owner-scoped; HMAC-signed delivery).
    await this.webhooks.dispatch(
      'invoice.paid' as WebhookEventType,
      {
        invoiceId: invoice.id,
        number: invoice.number,
        merchantId: invoice.merchantId,
        amount: invoice.amount,
        assetCode: invoice.assetCode,
        hash: txHash,
      },
      { merchantId: invoice.merchantId },
    );
    this.logger.log(`invoice paid on-chain: ${invoice.number} (contractId=${event.id})`);
  }

  // ── subscriptions ───────────────────────────────────────────────────────

  private async onSubscriptionPlanCreated(
    event: { id: bigint; merchant: string; amountStroops: bigint },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.subscriptionPlan.updateMany({
      where: { hash: txHash ?? undefined, status: 'PENDING' },
      data: { contractPlanId: Number(event.id), status: 'ACTIVE' },
    });
    if (updated.count !== 1) {
      return;
    }
    const plan = await this.prisma.subscriptionPlan.findFirst({ where: { hash: txHash } });
    if (plan) {
      this.realtime.emitToUser(plan.userId, 'subscription-plan.updated', {
        id: plan.id,
        status: 'ACTIVE',
        contractPlanId: Number(event.id),
      });
    }
    this.logger.log(`subscription plan created on-chain: planId=${event.id}`);
  }

  private async onSubscriptionCreated(
    event: { id: bigint; subscriber: string; planId: bigint },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.subscription.updateMany({
      where: { hash: txHash ?? undefined, status: 'PENDING' },
      data: { contractSubscriptionId: Number(event.id), status: 'ACTIVE' },
    });
    if (updated.count !== 1) {
      return;
    }
    const sub = await this.prisma.subscription.findFirst({
      where: { hash: txHash },
      include: { plan: true },
    });
    if (!sub) {
      return;
    }
    // The contract computed next_payment_at internally; mirror it locally.
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { nextPaymentAt: new Date(Date.now() + sub.plan.intervalSeconds * 1000) },
    });
    this.realtime.emitToUser(sub.userId, 'subscription.updated', {
      id: sub.id,
      status: 'ACTIVE',
      contractSubscriptionId: Number(event.id),
    });
    this.logger.log(`subscription active on-chain: subId=${event.id}`);
  }

  private async onSubscriptionRenewed(
    event: { id: bigint; planId: bigint; amountStroops: bigint; merchant: string },
    txHash: string | null,
  ): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where: { contractSubscriptionId: Number(event.id) },
      include: { plan: true },
    });
    if (!sub || sub.status !== 'ACTIVE') {
      return;
    }
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { nextPaymentAt: new Date(Date.now() + sub.plan.intervalSeconds * 1000) },
    });
    this.realtime.emitToUser(sub.userId, 'subscription.updated', {
      id: sub.id,
      status: 'ACTIVE',
      renewed: true,
      hash: txHash,
    });
    this.logger.log(`subscription renewed on-chain: subId=${event.id}`);
  }

  private async onSubscriptionCanceled(
    event: { id: bigint; by: string },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.subscription.updateMany({
      where: { contractSubscriptionId: Number(event.id), status: { in: ['PENDING', 'ACTIVE'] } },
      data: { status: 'CANCELED' },
    });
    if (updated.count !== 1) {
      return;
    }
    const sub = await this.prisma.subscription.findUnique({
      where: { contractSubscriptionId: Number(event.id) },
    });
    if (sub) {
      this.realtime.emitToUser(sub.userId, 'subscription.updated', {
        id: sub.id,
        status: 'CANCELED',
      });
    }
  }

  // ── treasury ────────────────────────────────────────────────────────────

  private async onTreasuryDeposit(
    event: { token: string; from: string; amountStroops: bigint },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.treasuryOperation.updateMany({
      where: { hash: txHash ?? undefined, status: 'SUBMITTED', type: 'DEPOSIT' },
      data: { status: 'CONFIRMED' },
    });
    if (updated.count !== 1) {
      return;
    }
    const op = await this.prisma.treasuryOperation.findFirst({ where: { hash: txHash } });
    if (op) {
      this.realtime.emitToUser(op.userId, 'treasury-operation.updated', {
        id: op.id,
        status: 'CONFIRMED',
        type: 'DEPOSIT',
      });
    }
    this.logger.log(`treasury deposit confirmed on-chain: hash=${txHash}`);
  }

  private async onWithdrawalProposed(
    event: { id: bigint; token: string; to: string; amountStroops: bigint; by: string },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.treasuryWithdrawal.updateMany({
      where: { hash: txHash ?? undefined },
      data: { contractWithdrawalId: Number(event.id), status: 'PROPOSED' },
    });
    if (updated.count !== 1) {
      return;
    }
    const row = await this.prisma.treasuryWithdrawal.findFirst({ where: { hash: txHash } });
    if (row) {
      this.realtime.emitToUser(row.userId, 'treasury-withdrawal.updated', {
        id: row.id,
        status: 'PROPOSED',
        contractWithdrawalId: Number(event.id),
      });
    }
  }

  private async onWithdrawalApproved(
    event: { id: bigint; member: string },
    txHash: string | null,
  ): Promise<void> {
    const row = await this.prisma.treasuryWithdrawal.findUnique({
      where: { contractWithdrawalId: Number(event.id) },
    });
    if (!row || !['PROPOSED', 'APPROVED'].includes(row.status)) {
      return;
    }
    const approvals = (row.approvals as string[]) ?? [];
    if (approvals.includes(event.member)) {
      return; // duplicate approval event — idempotent
    }
    const next = [...approvals, event.member];
    const threshold = row.threshold;
    const status: 'PROPOSED' | 'APPROVED' = next.length >= threshold ? 'APPROVED' : 'PROPOSED';
    await this.prisma.treasuryWithdrawal.update({
      where: { id: row.id },
      data: { approvals: next as never, status },
    });
    this.realtime.emitToUser(row.userId, 'treasury-withdrawal.updated', {
      id: row.id,
      status,
      approvals: next.length,
    });
  }

  private async onWithdrawalExecuted(
    event: { id: bigint; token: string; to: string; amountStroops: bigint },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.treasuryWithdrawal.updateMany({
      where: { contractWithdrawalId: Number(event.id), status: { in: ['PROPOSED', 'APPROVED'] } },
      data: { status: 'EXECUTED', executedHash: txHash ?? undefined },
    });
    if (updated.count !== 1) {
      return;
    }
    const row = await this.prisma.treasuryWithdrawal.findUnique({
      where: { contractWithdrawalId: Number(event.id) },
    });
    if (row) {
      this.realtime.emitToUser(row.userId, 'treasury-withdrawal.updated', {
        id: row.id,
        status: 'EXECUTED',
        hash: txHash,
      });
    }
    this.logger.log(`treasury withdrawal executed on-chain: contractId=${event.id}`);
  }

  // ── merchant ────────────────────────────────────────────────────────────

  private async onMerchantRegistered(
    event: { id: bigint; owner: string; name: string },
    txHash: string | null,
  ): Promise<void> {
    const updated = await this.prisma.merchant.updateMany({
      where: { registerTxHash: txHash ?? undefined, onChainMerchantId: null },
      data: { onChainMerchantId: Number(event.id) },
    });
    if (updated.count !== 1) {
      return;
    }
    const merchant = await this.prisma.merchant.findFirst({ where: { registerTxHash: txHash } });
    if (merchant) {
      this.realtime.emitToUser(merchant.userId, 'merchant.updated', {
        merchantId: merchant.id,
        onChainMerchantId: Number(event.id),
      });
    }
    this.logger.log(`merchant registered on-chain: id=${event.id}`);
  }

  private nativeSacAddress(): string {
    const network = this.config.get<string>('STELLAR_NETWORK') ?? 'testnet';
    const passphrase =
      this.config.get<string>('NETWORK_PASSPHRASE') ??
      (network === 'public' ? Networks.PUBLIC : Networks.TESTNET);
    return Asset.native().contractId(passphrase);
  }

  private async onMerchantSale(
    event: { id: bigint; token: string; amountStroops: bigint },
    txHash: string | null,
    eventId: string,
  ): Promise<void> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { onChainMerchantId: Number(event.id) },
    });
    if (!merchant) {
      return; // not a platform-registered merchant — nothing to credit
    }
    // XLM native only for now (matches the payment inbound path); other SAC
    // assets need code/decimals resolution before credit is safe. Never
    // mis-credit a USDC sale as XLM.
    if (event.token !== this.nativeSacAddress()) {
      this.logger.log({ merchantId: merchant.id }, 'merchant sale for unsupported token — not credited');
      return;
    }
    // Dedupe: a re-delivered `sale` event must not double-credit the merchant.
    const existing = await this.prisma.chainEvent.findUnique({ where: { eventId } });
    if (existing) {
      return;
    }
    await this.prisma.chainEvent.create({ data: { eventId, source: 'soroban', txHash, ledger: null } });
    const amount = stroopsToUnits(event.amountStroops, 7);
    await this.prisma.transaction.create({
      data: {
        userId: merchant.userId,
        toPublicKey: merchant.settlementPublicKey,
        amount,
        assetCode: 'XLM',
        assetIssuer: null,
        status: 'CONFIRMED',
        direction: 'INCOMING',
        kind: 'merchant_sale',
        hash: txHash ?? undefined,
        sourceNetwork: 'testnet',
        meta: { onChainMerchantId: Number(event.id) },
      },
    });
    this.realtime.emitToUser(merchant.userId, 'payment.received', {
      amount,
      assetCode: 'XLM',
      hash: txHash,
    });
    await this.notifications.paymentReceived({
      userId: merchant.userId,
      amount,
      assetCode: 'XLM',
      toPublicKey: '',
    });
    await this.webhooks.dispatch(
      'payment.received' as WebhookEventType,
      {
        merchantId: merchant.id,
        amount,
        assetCode: 'XLM',
        hash: txHash,
      },
      { merchantId: merchant.id },
    );
    this.logger.log(`merchant sale credited on-chain: merchant=${event.id}`);
  }

  private async onMerchantSettled(
    event: { id: bigint; token: string; amountStroops: bigint; commissionStroops: bigint; to: string },
    txHash: string | null,
  ): Promise<void> {
    // The settle event carries the real (net) amount the merchant received —
    // fill it in from on-chain evidence rather than the placeholder row.
    const updated = await this.prisma.settlement.updateMany({
      where: { onChainMerchantId: Number(event.id), status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        settleTxHash: txHash ?? undefined,
        amount: event.token === this.nativeSacAddress() ? stroopsToUnits(event.amountStroops, 7) : undefined,
      },
    });
    if (updated.count !== 1) {
      return;
    }
    const settlement = await this.prisma.settlement.findFirst({
      where: { onChainMerchantId: Number(event.id) },
      include: { merchant: { select: { userId: true } } },
    });
    if (settlement) {
      this.realtime.emitToUser(settlement.merchant.userId, 'settlement.updated', {
        id: settlement.id,
        status: 'COMPLETED',
        hash: txHash,
      });
    }
    this.logger.log(`merchant settlement completed on-chain: merchant=${event.id}`);
  }
}