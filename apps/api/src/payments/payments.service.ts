import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, BASE_FEE, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { Prisma, PrismaService } from '@stellar-pay/database';
import { createStellarNetwork } from '../infra/stellar';
import { createId, toStroops } from '@stellar-pay/shared';
import { SorobanSubmissionError } from '@stellar-pay/sdk';
import type {
  CreatePayment,
  PaymentRequestInput,
  TransactionListQuery,
} from '@stellar-pay/validation';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ExchangeRateService } from './exchange-rate.service';
import { TransactionReconciliationService } from './transaction-reconciliation.service';
import { IpfsService } from '../infra/ipfs.service';
import { MetricsService } from '../metrics/metrics.service';

const TYPE_TO_KIND: Record<string, string> = {
  SEND: 'payment',
  QR: 'qr_payment',
  PAYMENT_LINK: 'payment_link',
  SCHEDULED: 'scheduled',
  RECURRING: 'recurring',
  BATCH: 'batch',
  SPLIT: 'split',
  INVOICE: 'invoice',
  CROSS_BORDER: 'cross_border',
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly realtime: RealtimeGateway,
    private readonly rates: ExchangeRateService,
    private readonly ipfs: IpfsService,
    private readonly reconciliation: TransactionReconciliationService,
    private readonly metrics: MetricsService,
  ) {}

  private network() {
    return createStellarNetwork(this.config);
  }

  /**
   * Platform-wide gates driven by the `Setting` table (admin-editable):
   * maintenance mode blocks new payment intents, and a configured minimum
   * amount rejects dust payments. Absent rows mean "no gate".
   */
  private async assertPaymentAllowed(totalAmount?: string): Promise<void> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: ['maintenance_mode', 'min_payment_amount'] } },
      select: { key: true, value: true },
    });
    const get = (key: string): unknown | undefined => rows.find((r) => r.key === key)?.value;
    if (get('maintenance_mode') === true) {
      throw new BadRequestException('Payments are temporarily paused for maintenance');
    }
    const min = get('min_payment_amount');
    if (typeof min === 'string' && min && totalAmount) {
      try {
        if (BigInt(toStroops(totalAmount)) < BigInt(toStroops(min))) {
          throw new BadRequestException(`Amount must be at least ${min}`);
        }
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw err;
        }
        // Unparseable stored minimum — do not block payments on bad config.
      }
    }
  }

  /**
   * Whether SEND payments for this asset should route through the Soroban
   * payment contract (`send`) instead of a classic Stellar Operation.payment.
   * Off by default; when enabled the on-chain token SAC must be allowlisted
   * on the deployed contract (admin `set_allowed`), otherwise the contract
   * reverts with TokenNotAllowed.
   */
  private isContractRoute(assetCode: string): boolean {
    const route = this.config.get<string>('PAYMENT_ROUTE') ?? 'classic';
    if (route !== 'contract') {
      return false;
    }
    const contractId = this.config.get<string>('CONTRACT_STELLAR_PAY_PAYMENT');
    const assets = this.config.get<string[]>('PAYMENT_CONTRACT_ASSETS') ?? ['XLM'];
    return !!contractId && assets.includes(assetCode.toUpperCase());
  }

  /**
   * Create a payment intent.
   * - scheduled / recurring → persisted for the scheduler
   * - everything else → builds an unsigned XDR for the user's wallet to sign
   *
   * When an `idempotencyKey` is supplied (client `Idempotency-Key` header), a
   * retried request returns the original intent instead of creating a second
   * payment: the key is stored under a `@@unique([userId, idempotencyKey])`
   * constraint and the original unsigned XDR is kept in `meta.unsignedXdr` so
   * the replay returns the exact signable payload. SCHEDULED/RECURRING intents
   * are created on the `ScheduledPayment` table and are not covered by this
   * key (their scheduler executions are independently idempotent).
   */
  async create(userId: string, dto: CreatePayment, idempotencyKey?: string) {
    await this.wallet.assertWalletOwnership(userId, dto.fromPublicKey);
    // Enforce platform-wide gates (maintenance mode, minimum amount).
    const gateAmount =
      dto.type === 'SCHEDULED' || dto.type === 'RECURRING'
        ? undefined
        : dto.destinations.reduce((sum, d) => sum + Number(d.amount), 0).toString();
    await this.assertPaymentAllowed(gateAmount);
    const asset =
      dto.assetCode === 'XLM' ? Asset.native() : new Asset(dto.assetCode, dto.assetIssuer ?? '');

    if (dto.type === 'SCHEDULED' || dto.type === 'RECURRING') {
      const first = dto.destinations[0];
      const scheduled = await this.prisma.scheduledPayment.create({
        data: {
          userId,
          fromPublicKey: dto.fromPublicKey,
          toPublicKey: first.publicKey,
          amount: first.amount,
          assetCode: dto.assetCode,
          assetIssuer: dto.assetIssuer,
          memo: dto.memo,
          interval: dto.type === 'RECURRING' ? dto.recurring?.interval : null,
          nextRunAt: dto.scheduledFor ? new Date(dto.scheduledFor) : new Date(Date.now() + 60_000),
          maxRuns: dto.recurring?.count,
        },
      });
      return { kind: 'scheduled' as const, id: scheduled.id, message: 'Payment scheduled' };
    }

    const kind = TYPE_TO_KIND[dto.type] ?? 'payment';
    const isBatch = dto.type === 'BATCH' || dto.type === 'SPLIT';
    const total = dto.destinations.reduce((sum, d) => sum + Number(d.amount), 0).toString();
    const destination = dto.destinations[0];

    // Idempotent replay: a retried request with the same key returns the
    // original intent without rebuilding the XDR (or touching the network).
    if (idempotencyKey) {
      const existing = await this.prisma.transaction.findFirst({
        where: { userId, idempotencyKey },
      });
      if (existing) {
        return this.replay(existing);
      }
    }

    // Soroban contract route (experimental, `PAYMENT_ROUTE=contract`).
    // The contract memo carries a deterministic `sp:<correlationId>` so the
    // future event indexer can correlate an on-chain `payment` event with this
    // database row without trusting the client.
    const contractRoute = dto.type === 'SEND' && !isBatch && this.isContractRoute(dto.assetCode);
    let unsignedXdr: string;
    let contractMeta:
      | { route: 'contract'; contractId: string; tokenAddress: string; correlationId: string }
      | undefined;

    if (isBatch) {
      unsignedXdr = await this.buildBatchXdr(dto, asset);
    } else if (contractRoute) {
      const network = this.network();
      const contractId = this.config.get<string>('CONTRACT_STELLAR_PAY_PAYMENT')!;
      const tokenAddress = network.sorobanTokenAddress(dto.assetCode, dto.assetIssuer);
      const correlationId = createId();
      // Simulate → assemble at create time so the returned envelope carries
      // the on-chain footprint (`sorobanData`) and the `from.require_auth()`
      // authorization entries. An un-allowlisted SAC reverts here with a clear
      // 400-class error instead of failing at submit. The wallet signs the
      // assembled envelope, and the server submits it via Soroban RPC
      // `sendTransaction`. The invocation targets the DEPLOYED PAYMENT
      // CONTRACT (`contractId`); the token SAC is passed as an argument.
      let prepared;
      try {
        prepared = await network.prepareSorobanSendTransaction({
          from: dto.fromPublicKey,
          to: destination.publicKey,
          contractId,
          tokenAddress,
          amount: destination.amount,
          memo: `sp:${correlationId}`,
        });
      } catch (err) {
        // A failed simulation is a definitive client/configuration error (e.g.
        // the token SAC is not allowlisted on the deployed contract) — surface
        // the on-chain reason as a 400, never a 500.
        if (err instanceof SorobanSubmissionError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      unsignedXdr = prepared.unsignedXdr;
      contractMeta = { route: 'contract', contractId, tokenAddress, correlationId };
    } else {
      // A memo without an explicit type is a text memo. Normalize here so the
      // unsigned XDR the wallet signs always contains the recorded memo — a
      // mismatch between the built XDR (memo dropped) and the stored intent
      // (memo enforced at submit) previously made memo'd sends unsubmitable.
      const memoType = dto.memoType ?? (dto.memo ? 'text' : undefined);
      unsignedXdr = await this.network().buildPaymentTransaction({
        from: dto.fromPublicKey,
        to: destination.publicKey,
        amount: destination.amount,
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer,
        memo: dto.memo,
        memoType,
      });
    }

    let transaction;
    try {
      transaction = await this.prisma.transaction.create({
        data: {
          userId,
          idempotencyKey: idempotencyKey ?? null,
          fromPublicKey: dto.fromPublicKey,
          toPublicKey: dto.destinations.length === 1 ? destination.publicKey : null,
          amount: total,
          assetCode: dto.assetCode,
          assetIssuer: dto.assetIssuer,
          memo: dto.memo,
          memoType: dto.memoType ?? 'text',
          status: 'PENDING',
          direction: 'OUTGOING',
          kind: contractRoute ? 'contract_send' : kind,
          sourceNetwork: this.config.get<string>('STELLAR_NETWORK') ?? 'testnet',
          meta: {
            destinations: dto.destinations,
            type: dto.type,
            ...(contractMeta ?? {}),
            // Keep the signable XDR so an idempotent replay returns the exact
            // payload the client already holds (avoids a second, different XDR
            // for the same intent).
            ...(idempotencyKey ? { unsignedXdr } : {}),
          },
        },
      });
    } catch (err) {
      // Two concurrent requests with the same key: one wins the unique
      // constraint, the loser returns the winner's row like any retry.
      if (idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.transaction.findFirst({
          where: { userId, idempotencyKey },
        });
        if (existing) {
          return this.replay(existing);
        }
      }
      throw err;
    }

    return {
      kind: 'pending' as const,
      id: transaction.id,
      unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  /** Replay the stored intent for a retried request with the same key. */
  private replay(existing: { id: string; status: string; kind: string; meta: unknown }): {
    kind: 'pending' | 'scheduled';
    id: string;
    unsignedXdr?: string | null;
    message: string;
    idempotent: boolean;
  } {
    const meta = (existing.meta ?? {}) as { unsignedXdr?: string };
    return {
      kind: 'pending',
      id: existing.id,
      unsignedXdr: meta.unsignedXdr ?? null,
      message: 'Payment intent already exists for this key — return the original',
      idempotent: true,
    };
  }

  /** Submit a wallet-signed XDR and reconcile the local record. */
  async submit(userId: string, transactionId: string, signedXdr: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
    });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    if (tx.status !== 'PENDING') {
      throw new BadRequestException('Transaction already submitted');
    }

    // Anti-manipulation gate (checkout/payment-link robustness): the wallet
    // must sign exactly the payment the intent fixed. Decode the signed XDR
    // and compare amount/recipient/asset/memo before anything is sent, so a
    // customer cannot underpay a fixed amount or pay a different recipient.
    // Soroban-contract and batch intents are not classic single payments and
    // are skipped (their on-chain outcome is verified by the indexer instead).
    const isClassicSingle =
      tx.direction === 'OUTGOING' &&
      !!tx.toPublicKey &&
      tx.kind !== 'contract_send' &&
      !['batch', 'split'].includes(tx.kind);
    if (isClassicSingle) {
      const check = this.network().verifySignedPaymentMatchesIntent(signedXdr, {
        amount: tx.amount,
        assetCode: tx.assetCode,
        assetIssuer: tx.assetIssuer,
        toPublicKey: tx.toPublicKey,
        memo: tx.memoType === 'text' ? tx.memo : undefined,
      });
      if (!check.matches) {
        throw new BadRequestException(
          `Signed transaction does not match the payment intent: ${check.reason}`,
        );
      }
    }

    // Atomically claim PENDING → SUBMITTED. Exactly one concurrent request can
    // win the claim (the row may have been taken between the read and here);
    // the loser is rejected before touching the network, so the same payment
    // can never be submitted twice.
    const claim = await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: 'PENDING' },
      data: { status: 'SUBMITTED' },
    });
    if (claim.count !== 1) {
      throw new BadRequestException('Transaction already submitted');
    }

    // Transport/infrastructure failures (timeout, Horizon down, RPC error) are
    // NOT payment failures: revert the claim so the client can retry, and let
    // the error propagate. A definitive FAILED result from the network is
    // handled below and persists as FAILED.
    const isContractSend = tx.kind === 'contract_send';
    let result;
    try {
      result = isContractSend
        ? await this.network().submitSorobanSendTransaction(signedXdr)
        : await this.network().submitSignedTransaction(signedXdr);
    } catch (err) {
      if (err instanceof SorobanSubmissionError) {
        // A rejected/unsupported Soroban submission is a definitive client
        // error (bad envelope, un-allowlisted SAC, RPC rejected), not a
        // transient transport blip. Revert the claim so the row is not stuck
        // SUBMITTED and surface the real reason as a 400.
        await this.prisma.transaction.updateMany({
          where: { id: transactionId, status: 'SUBMITTED' },
          data: { status: 'PENDING' },
        });
        throw new BadRequestException(err.message);
      }
      await this.prisma.transaction.updateMany({
        where: { id: transactionId, status: 'SUBMITTED' },
        data: { status: 'PENDING' },
      });
      throw err;
    }

    // Contract-route payments only reach SUBMITTED on a successful RPC
    // submission — settlement CONFIRMED requires the on-chain event indexer.
    // Classic payments keep their existing immediate SUCCEEDED semantics.
    const persistedStatus =
      isContractSend && result.status === 'SUCCEEDED' ? 'SUBMITTED' : result.status;

    const updated = await this.prisma.transaction.update({
      where: { id: transactionId },
      data: {
        hash: result.hash || null,
        status: persistedStatus,
        fee: result.fee,
        errorMessage: result.errorMessage,
      },
    });

    if (result.status === 'SUCCEEDED') {
      if (!isContractSend) {
        await this.afterSuccess(updated);
      }
      // Contract sends: no payer-facing success events yet — wait for the
      // indexer to observe the on-chain `payment` event before notifying.
    } else {
      await this.afterFailure(tx);
    }
    return updated;
  }

  private async afterSuccess(tx: {
    id: string;
    toPublicKey: string | null;
    amount: string;
    assetCode: string;
    userId: string | null;
    kind: string;
    meta: unknown;
    hash: string | null;
    fromPublicKey: string | null;
    assetIssuer: string | null;
    memo: string | null;
    sourceNetwork: string;
    createdAt: Date;
  }) {
    this.metrics.inc('payments_succeeded_total', { kind: tx.kind });
    // Update invoice / payment-link bookkeeping and dispatch the
    // `payment.received` webhook (shared with the public checkout flow).
    await this.reconciliation.onPaymentSucceeded(tx);
    // Confirmation-gated schedules: a scheduled/recurring occurrence is
    // advanced only now that its transaction is confirmed (SUCCEEDED), not
    // when the scheduler merely created it.
    await this.reconciliation.advanceScheduledPayment(tx);

    await this.notifications.paymentSent({
      userId: tx.userId!,
      amount: tx.amount,
      assetCode: tx.assetCode,
      toPublicKey: tx.toPublicKey ?? '',
    });
    this.realtime.emitToUser(tx.userId!, 'transaction.updated', { id: tx.id, status: 'SUCCEEDED' });

    // Pin a verifiable receipt to IPFS.
    this.pinReceipt(tx).catch(() => {
      // Non-critical — silently ignore IPFS pin failures.
    });
  }

  private async afterFailure(tx: {
    id: string;
    amount: string;
    assetCode: string;
    userId: string | null;
  }) {
    this.metrics.inc('payments_failed_total');
    await this.notifications.paymentFailed({
      userId: tx.userId!,
      amount: tx.amount,
      assetCode: tx.assetCode,
      reason: 'Transaction was rejected by the network',
    });
    this.realtime.emitToUser(tx.userId!, 'transaction.updated', { id: tx.id, status: 'FAILED' });
  }

  private async buildBatchXdr(dto: CreatePayment, asset: Asset): Promise<string> {
    const account = await this.network().server.loadAccount(dto.fromPublicKey);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.network().config.networkPassphrase,
    });
    for (const destination of dto.destinations) {
      builder.addOperation(
        Operation.payment({
          destination: destination.publicKey,
          asset,
          amount: destination.amount,
        }),
      );
    }
    if (dto.memo) {
      builder.addMemo(Memo.text(dto.memo));
    }
    return builder.setTimeout(300).build().toXDR();
  }

  async simulate(dto: CreatePayment) {
    const assetCode = dto.assetCode === 'XLM' ? 'XLM' : dto.assetCode;
    try {
      const fee = await this.network().estimateFee({
        from: dto.fromPublicKey,
        to: dto.destinations[0].publicKey,
        amount: dto.destinations[0].amount,
        assetCode: dto.assetCode,
        assetIssuer: dto.assetIssuer,
        memo: dto.memo,
        memoType: dto.memoType,
      });
      return { fee: fee.fee, warnings: fee.warnings, assetCode };
    } catch {
      return { fee: BASE_FEE, warnings: ['Network fee estimation unavailable'], assetCode };
    }
  }

  /** Build a web+stellar:pay URI + QR payload for a payment request. */
  async createRequest(input: PaymentRequestInput) {
    const { buildPaymentUri } = await import('@stellar-pay/shared');
    const uri = buildPaymentUri({
      destination: input.publicKey,
      amount: input.amount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer ?? undefined,
      memo: input.memo,
      message: input.message,
    });
    return { uri, qrPayload: uri };
  }

  async history(userId: string, query: Partial<TransactionListQuery> = {}) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    // Build the filter once and use it for BOTH the page and the count: the
    // count previously ignored status/direction/assetCode, so `total` and
    // `totalPages` were wrong whenever any filter was applied.
    const where: Prisma.TransactionWhereInput = { userId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.direction) {
      where.direction = query.direction;
    }
    if (query.assetCode) {
      where.assetCode = query.assetCode;
    }
    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async get(userId: string, id: string) {
    const tx = await this.prisma.transaction.findFirst({ where: { id, userId } });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    return tx;
  }

  /**
   * Build the unsigned XDR for a scheduler-created occurrence so the owner can
   * approve it: the scheduler stores PENDING rows (meta.scheduledId) but has
   * no wallet, so the signable payload is produced on demand and then flows
   * through the normal `submit` path (which verifies the signed XDR against
   * the recorded intent before anything reaches the network).
   */
  async approveOccurrence(userId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({ where: { id: transactionId, userId } });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    const meta = (tx.meta ?? {}) as { scheduledId?: string };
    const occurrenceKinds = ['scheduled', 'recurring', 'subscription_renewal'];
    if (!occurrenceKinds.includes(tx.kind) || !meta.scheduledId) {
      throw new BadRequestException('Not an approvable scheduled payment');
    }
    if (tx.status !== 'PENDING') {
      throw new BadRequestException('Payment is not awaiting approval');
    }
    if (!tx.fromPublicKey || !tx.toPublicKey || !tx.amount || !tx.assetCode) {
      throw new BadRequestException('Payment record is missing required fields');
    }
    const unsignedXdr = await this.network().buildPaymentTransaction({
      from: tx.fromPublicKey,
      to: tx.toPublicKey,
      amount: tx.amount,
      assetCode: tx.assetCode,
      assetIssuer: tx.assetIssuer,
      memo: tx.memo ?? undefined,
      memoType: tx.memoType === 'text' ? 'text' : undefined,
    });
    return {
      id: tx.id,
      kind: tx.kind,
      amount: tx.amount,
      assetCode: tx.assetCode,
      toPublicKey: tx.toPublicKey,
      unsignedXdr,
      message: 'Sign the transaction with your wallet, then submit it',
    };
  }

  async receipt(userId: string, id: string) {
    const tx = await this.get(userId, id);
    const gateway = this.config.get<string>('IPFS_GATEWAY') ?? 'https://ipfs.io/ipfs/';

    // If a real pin is stored, serve it.
    if (tx.receiptIpfsCid) {
      return {
        ipfsCid: tx.receiptIpfsCid,
        url: `${gateway.replace(/\/$/, '')}/${tx.receiptIpfsCid}`,
        pinned: true,
      };
    }

    const payload = this.ipfs.buildReceiptPayload({
      id: tx.id,
      hash: tx.hash,
      fromPublicKey: tx.fromPublicKey,
      toPublicKey: tx.toPublicKey,
      amount: tx.amount,
      assetCode: tx.assetCode,
      assetIssuer: tx.assetIssuer,
      memo: tx.memo,
      kind: tx.kind,
      sourceNetwork: tx.sourceNetwork,
      createdAt: tx.createdAt,
    });

    // Lazily pin (a pinning service may have come online since settlement).
    const pinned = await this.ipfs.pinReceipt(payload).catch(() => null);
    if (pinned?.pinned) {
      await this.prisma.transaction
        .update({ where: { id: tx.id }, data: { receiptIpfsCid: pinned.cid } })
        .catch(() => undefined);
      return { ipfsCid: pinned.cid, url: pinned.url, pinned: true };
    }

    // No pinning backend is available: return the receipt payload inline with
    // its deterministic content address rather than fabricating a resolvable
    // IPFS URL (an un-pinned CID is not retrievable from any gateway).
    return {
      ipfsCid: pinned?.cid ?? null,
      url: null,
      pinned: false,
      receipt: payload,
    };
  }

  async scheduled(userId: string) {
    return this.prisma.scheduledPayment.findMany({
      where: { userId },
      orderBy: { nextRunAt: 'asc' },
    });
  }

  async cancelScheduled(userId: string, id: string) {
    await this.prisma.scheduledPayment.updateMany({
      where: { id, userId },
      data: { status: 'CANCELED' },
    });
    return { ok: true };
  }

  async crossBorderQuote(dto: CreatePayment) {
    const destination = dto.destinations[0];
    const rate = await this.rates.getRate(dto.assetCode, 'USD');
    return {
      fromAmount: destination.amount,
      fromAsset: dto.assetCode,
      toAmount: (Number(destination.amount) * rate).toFixed(2),
      toAsset: 'USD',
      rate,
      settlement: 'USDC',
      eta: '1-2 minutes (Stellar finality)',
      txId: createId(),
    };
  }

  /**
   * Fire-and-forget: pin a receipt to IPFS after a successful transaction.
   * Only a genuinely pinned CID is persisted — a deterministic content hash
   * is not a resolvable receipt and must not be stored as one.
   */
  private async pinReceipt(tx: {
    id: string;
    hash: string | null;
    fromPublicKey: string | null;
    toPublicKey: string | null;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
    memo: string | null;
    kind: string;
    sourceNetwork: string;
    createdAt: Date;
  }): Promise<void> {
    const payload = this.ipfs.buildReceiptPayload(tx);
    const result = await this.ipfs.pinReceipt(payload);
    if (!result.pinned) {
      return;
    }

    await this.prisma.transaction.update({
      where: { id: tx.id },
      data: { receiptIpfsCid: result.cid },
    });
  }
}
