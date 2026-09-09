import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Networks, xdr } from '@stellar/stellar-sdk';
import { PrismaService } from '@stellar-pay/database';
import { RedisService } from '../infra/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InboundReconciliationService } from './inbound.service';
import { ContractReconciliationService } from './contract-reconciliation.service';
import { parsePaymentEventData, stroopsToUnits, topicIsPayment } from './soroban-event';
import { MetricsService } from '../metrics/metrics.service';
import { TransactionReconciliationService } from '../payments/transaction-reconciliation.service';

const CURSOR_KEY = 'indexer:soroban:cursor';
const DEFAULT_LOOKBACK_LEDGERS = 2000;
const PAYMENT_MEMO_PREFIX = 'sp:';

interface SorobanEvent {
  id?: string;
  txHash?: string;
  contractId?: string;
  ledger?: number;
  topic?: string[] | Array<{ xdr: string }>;
  value?: string | { xdr: string };
  [key: string]: unknown;
}

interface RpcEventPage {
  events?: SorobanEvent[];
  cursor?: string | null;
  latestLedger?: number;
}

/**
 * Watches the deployed Soroban payment contract and moves contract-route
 * payments from SUBMITTED → CONFIRMED using on-chain evidence:
 *
 * 1. `getTransaction(hash)` — every SUBMITTED contract-route payment has a
 *    known hash; a SUCCESS status proves the `send` invocation executed on
 *    the ledger (the contract reverts otherwise). This is the primary
 *    confirmation signal and does not trust the client.
 * 2. `getEvents` (contract filter) — best-effort ingestion of `payment`
 *    events with a cursor persisted in Redis. Memo extraction is tolerant of
 *    the event-value encoding (recursive `sp:` scan) so correlation works
 *    regardless of how the contract struct is serialized.
 *
 * Idempotency: the state transition uses an atomic `updateMany` guarded by
 * `status: 'SUBMITTED'`, so the same event/transaction observed twice can only
 * succeed once. Side effects (realtime, notifications, webhooks) fire only on
 * the winning transition.
 */
@Injectable()
export class IndexerService {
  private readonly logger = new Logger('IndexerService');
  private warnedNoConfig = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly inbound: InboundReconciliationService,
    private readonly metrics: MetricsService,
    private readonly reconciliation: TransactionReconciliationService,
    private readonly contractReconciliation: ContractReconciliationService,
  ) {}

  /** Payment contract id (drives the contract-route payment confirmation). */
  private paymentContractId(): string | undefined {
    return this.config.get<string>('CONTRACT_STELLAR_PAY_PAYMENT') ?? undefined;
  }

  /**
   * Every deployed contract the indexer watches (payment + the on-chain
   * integrations: escrow, invoices, subscriptions, treasury, merchant).
   */
  private contractIds(): string[] {
    return [
      'CONTRACT_STELLAR_PAY_PAYMENT',
      'CONTRACT_STELLAR_PAY_ESCROW',
      'CONTRACT_STELLAR_PAY_INVOICES',
      'CONTRACT_STELLAR_PAY_SUBSCRIPTIONS',
      'CONTRACT_STELLAR_PAY_TREASURY',
      'CONTRACT_STELLAR_PAY_MERCHANT',
    ]
      .map((key) => this.config.get<string>(key))
      .filter((id): id is string => !!id);
  }

  private rpcUrl(): string | undefined {
    return this.config.get<string>('SOROBAN_RPC_URL') ?? undefined;
  }

  private isEnabled(): boolean {
    return this.contractIds().length > 0 && !!this.rpcUrl();
  }

  /** Native SAC contract id for the configured network (XLM inbound only). */
  private nativeSacAddress(): string {
    const network = this.config.get<string>('STELLAR_NETWORK') ?? 'testnet';
    const passphrase =
      this.config.get<string>('NETWORK_PASSPHRASE') ??
      (network === 'public' ? Networks.PUBLIC : Networks.TESTNET);
    return Asset.native().contractId(passphrase);
  }

  async syncOnce(): Promise<void> {
    if (!this.isEnabled()) {
      if (!this.warnedNoConfig) {
        this.logger.warn('SOROBAN_RPC_URL / deployed contract addresses not set — indexer idle');
        this.warnedNoConfig = true;
      }
      return;
    }
    await this.confirmSubmittedTransactions();
    await this.ingestContractEvents().catch((err) =>
      this.logger.warn({ err: (err as Error).message }, 'event ingestion failed'),
    );
    // Expose indexer freshness for monitoring ("how far behind is the event
    // processor") — a gauge of seconds since the last successful poll.
    this.metrics.set('indexer_last_poll_seconds', Math.floor(Date.now() / 1000));
  }

  /** Primary confirmation: check every SUBMITTED contract send on-chain. */
  private async confirmSubmittedTransactions(): Promise<void> {
    const txs = await this.prisma.transaction.findMany({
      where: { kind: 'contract_send', status: 'SUBMITTED', hash: { not: null } },
      take: 20,
    });
    for (const tx of txs) {
      try {
        const result = await this.rpc<{ status?: string }>({
          method: 'getTransaction',
          params: { hash: tx.hash as string },
        });
        if (result?.status === 'SUCCESS') {
          await this.confirm(tx);
        } else if (result?.status === 'FAILED') {
          // The `send` invocation reverted on-chain (e.g. TokenNotAllowed, or
          // a fee/signature failure at execution time). Persist a terminal
          // FAILED so the row is never stuck SUBMITTED, and notify the payer.
          await this.fail(tx, 'contract invocation reverted on-chain');
        }
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, hash: tx.hash },
          'getTransaction failed for submitted payment',
        );
      }
    }
  }

  /**
   * Atomically move a SUBMITTED contract payment to FAILED (on-chain revert)
   * and, only on the winning transition, notify the payer. Mirrors `confirm`
   * so duplicate observations can only win once.
   */
  private async fail(
    tx: { id: string; userId: string | null; amount: string; assetCode: string },
    reason: string,
  ) {
    const updated = await this.prisma.transaction.updateMany({
      where: { id: tx.id, status: 'SUBMITTED' },
      data: { status: 'FAILED', errorMessage: reason },
    });
    if (updated.count !== 1) {
      return; // already terminal — idempotent
    }
    if (tx.userId) {
      this.realtime.emitToUser(tx.userId, 'transaction.updated', {
        id: tx.id,
        status: 'FAILED',
      });
      await this.notifications.paymentFailed({
        userId: tx.userId,
        amount: tx.amount,
        assetCode: tx.assetCode,
        reason,
      });
    }
    this.logger.log(`contract payment failed on-chain: ${tx.id}`);
  }

  /**
   * Ingest contract events for every deployed platform contract (payment +
   * escrow + invoices + subscriptions + treasury + merchant) from Soroban RPC.
   * Soroban RPC caps the number of contract IDs per filter at 5, so the
   * watched contracts are chunked into filter groups, each with its own
   * persisted cursor (a cursor only remains valid for the same filter). Event
   * payloads from transactions this platform never built (external wallets
   * paying a contract directly) are still reconciled where the event carries
   * enough information (e.g. merchant `sale`/`settle`, escrow `released` by
   * the counterparty) and safely ignored otherwise.
   */
  private async ingestContractEvents(): Promise<void> {
    const contractIds = this.contractIds();
    const groups: string[][] = [];
    for (let i = 0; i < contractIds.length; i += 5) {
      groups.push(contractIds.slice(i, i + 5));
    }
    for (let group = 0; group < groups.length; group++) {
      try {
        await this.ingestContractEventsGroup(groups[group], group, groups.length);
      } catch (err) {
        this.metrics.inc('indexer_ingest_failures_total');
        this.logger.warn(
          { err: (err as Error).message, group },
          'contract event ingestion failed for filter group',
        );
      }
    }
  }

  private async ingestContractEventsGroup(
    contractIds: string[],
    groupIndex: number,
    groupCount: number,
  ): Promise<void> {
    // Single-group deployments keep the legacy cursor key; multi-group use a
    // per-group suffix so each filter's cursor stays valid.
    const cursorKey = groupCount > 1 ? `${CURSOR_KEY}:g${groupIndex}` : CURSOR_KEY;
    const cursor = await this.redis.get(cursorKey);

    const params: Record<string, unknown> = {
      filters: [{ type: 'contract', contractIds }],
      limit: 50,
    };
    if (cursor) {
      params.pagination = { cursor };
    } else {
      params.startLedger = (await this.latestLedger()) - DEFAULT_LOOKBACK_LEDGERS;
    }

    const page = await this.rpc<RpcEventPage>({ method: 'getEvents', params });

    for (const event of page?.events ?? []) {
      await this.handleContractEvent(event);
    }

    // Persist the server cursor so the next poll resumes exactly where this one
    // stopped (no replay, no gap under normal operation).
    const nextCursor = page?.cursor ?? (cursor ? cursor : null);
    if (nextCursor) {
      await this.redis.set(cursorKey, nextCursor);
    }
  }

  private async handleContractEvent(event: SorobanEvent): Promise<void> {
    // On-chain integrations (escrow / invoices / subscriptions / treasury /
    // merchant): dispatch non-payment events to the reconciliation service,
    // which advances the owning record on on-chain evidence.
    if (event.contractId && event.contractId !== this.paymentContractId()) {
      if (!event.id) {
        this.logger.warn('soroban event without id — cannot dedupe, skipping');
        return;
      }
      await this.contractReconciliation.reconcile({
        contractId: event.contractId,
        eventId: event.id,
        txHash: event.txHash ?? null,
        ledger: event.ledger ?? null,
        topic: event.topic,
        value: event.value,
      });
      return;
    }

    // Platform correlation: `sp:<correlationId>` memos map back to a row we
    // created. When the row exists it governs the payment — confirm it if
    // still SUBMITTED and never treat it as a separate inbound credit.
    const correlation = extractCorrelationMemo(event);
    if (correlation) {
      const tx = await this.prisma.transaction.findFirst({
        where: { meta: { path: ['correlationId'], equals: correlation } } as never,
      });
      if (tx?.kind === 'contract_send') {
        if (tx.status === 'SUBMITTED') {
          await this.confirm(tx);
        }
        return;
      }
      if (tx) {
        return; // some other platform record owns this memo — not inbound
      }
    }

    // Inbound: a `payment` event whose recipient is a registered merchant was
    // NOT initiated through the API. Dedupe + reconciliation is delegated to
    // the shared inbound service (ChainEvent unique ledger, invoice matching,
    // merchant notification + Socket.IO + webhooks).
    if (!event.id) {
      this.logger.warn('soroban event without id — cannot dedupe, skipping');
      return;
    }
    const value = typeof event.value === 'string' ? event.value : event.value?.xdr;
    if (!topicIsPayment(event.topic) || !value) {
      return; // not a `payment` event (paused, batch, …)
    }
    const parsed = parsePaymentEventData(value);
    if (!parsed) {
      this.logger.warn({ eventId: event.id }, 'unparseable payment event payload');
      return;
    }
    // XLM native only for now — other SAC assets need code/decimals resolution.
    if (parsed.token !== this.nativeSacAddress()) {
      this.logger.log(
        { eventId: event.id, token: parsed.token },
        'payment event for unsupported token — not inbound-credited',
      );
      return;
    }

    await this.inbound.handle({
      eventId: event.id,
      source: 'soroban',
      fromPublicKey: parsed.from,
      toPublicKey: parsed.to,
      amount: stroopsToUnits(parsed.amountStroops, 7),
      assetCode: 'XLM',
      assetIssuer: null,
      hash: event.txHash ?? null,
      memo: parsed.memo || null,
      contractId: this.paymentContractId(),
      ledger: event.ledger ?? null,
    });
  }

  /**
   * Atomically move a SUBMITTED contract payment to CONFIRMED and, only on the
   * winning transition, fan out success events. Concurrent/duplicate
   * observations lose the race (updateMany matches status = SUBMITTED), which
   * makes event processing idempotent without a dedicated events table.
   */
  private async confirm(tx: {
    id: string;
    userId: string | null;
    amount: string;
    assetCode: string;
    toPublicKey: string | null;
    kind: string;
    meta: unknown;
  }): Promise<void> {
    const updated = await this.prisma.transaction.updateMany({
      where: { id: tx.id, status: 'SUBMITTED' },
      data: { status: 'CONFIRMED' },
    });
    if (updated.count !== 1) {
      return; // already confirmed (or moved) — idempotent
    }

    // Confirmation-gated schedules: advance the owning scheduled/recurring
    // plan only on the winning on-chain CONFIRMED transition.
    await this.reconciliation.advanceScheduledPayment(tx);

    // Contract sends are created by authenticated users, so userId is always
    // present; the guard keeps the fan-out safe if a row is ever orphaned.
    if (tx.userId) {
      this.realtime.emitToUser(tx.userId, 'transaction.updated', {
        id: tx.id,
        status: 'CONFIRMED',
      });
      await this.notifications.paymentSent({
        userId: tx.userId,
        amount: tx.amount,
        assetCode: tx.assetCode,
        toPublicKey: tx.toPublicKey ?? '',
      });
    }
    // No webhook dispatch here: a contract send has no merchant owner (it is a
    // payer-initiated transfer, not a merchant-received event), so fanning out
    // to webhooks would leak another merchant's transaction data. Merchant
    // inbound payments are webhooked by the owner-scoped inbound path.
    this.logger.log(`contract payment confirmed: ${tx.id}`);
  }

  private async latestLedger(): Promise<number> {
    const result = await this.rpc<{ sequence: number }>({ method: 'getLatestLedger', params: {} });
    return result?.sequence ?? 0;
  }

  private async rpc<T>(body: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<T | null> {
    const response = await fetch(this.rpcUrl()!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json()) as { result?: T | null; error?: { message?: string } };
    if (json.error) {
      throw new Error(json.error.message ?? 'soroban rpc error');
    }
    return json.result ?? null;
  }
}

/**
 * Extract the platform correlation memo (`sp:<correlationId>`) from a Soroban
 * `payment` event. The event data encoding for a #[contracttype] struct is
 * layout-version dependent, so we scan recursively for the first string that
 * carries the `sp:` prefix instead of assuming a fixed field order. Returns the
 * correlation id (without the prefix) or null.
 */
export function extractCorrelationMemo(event: SorobanEvent): string | null {
  const value = event?.value;
  const rawValue = typeof value === 'string' ? value : value?.xdr;
  if (!rawValue) {
    return null;
  }
  let scVal: xdr.ScVal;
  try {
    scVal = xdr.ScVal.fromXDR(Buffer.from(rawValue, 'base64'));
  } catch {
    return null;
  }
  const memo = findMemoString(scVal);
  if (!memo?.startsWith(PAYMENT_MEMO_PREFIX)) {
    return null;
  }
  return memo.slice(PAYMENT_MEMO_PREFIX.length);
}

/** Depth-first scan of an ScVal for the first string starting with `sp:`. */
function findMemoString(scVal: xdr.ScVal): string | null {
  try {
    switch (scVal.switch().name) {
      case 'scvString': {
        const value = scVal.str()?.toString() ?? '';
        return value.startsWith(PAYMENT_MEMO_PREFIX) ? value : null;
      }
      case 'scvVec': {
        for (const item of scVal.vec() ?? []) {
          const found = findMemoString(item);
          if (found) return found;
        }
        return null;
      }
      case 'scvMap': {
        for (const entry of scVal.map() ?? []) {
          const found = findMemoString(entry.val());
          if (found) return found;
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
