import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { xdr } from '@stellar/stellar-sdk';
import { PrismaService } from '@stellar-pay/database';
import { RedisService } from '../infra/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { WebhookEventType } from '@stellar-pay/types';

const CURSOR_KEY = 'indexer:soroban:cursor';
const DEFAULT_LOOKBACK_LEDGERS = 2000;
const PAYMENT_MEMO_PREFIX = 'sp:';

interface SorobanEvent {
  id?: string;
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
    private readonly webhooks: WebhooksService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private contractId(): string | undefined {
    return this.config.get<string>('CONTRACT_STELLAR_PAY_PAYMENT') ?? undefined;
  }

  private rpcUrl(): string | undefined {
    return this.config.get<string>('SOROBAN_RPC_URL') ?? undefined;
  }

  private isEnabled(): boolean {
    return !!(this.contractId() && this.rpcUrl());
  }

  async syncOnce(): Promise<void> {
    if (!this.isEnabled()) {
      if (!this.warnedNoConfig) {
        this.logger.warn('SOROBAN_RPC_URL / CONTRACT_STELLAR_PAY_PAYMENT not set — indexer idle');
        this.warnedNoConfig = true;
      }
      return;
    }
    await this.confirmSubmittedTransactions();
    await this.ingestContractEvents().catch((err) =>
      this.logger.warn({ err: (err as Error).message }, 'event ingestion failed'),
    );
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
   * Ingest contract events (payment contract) from Soroban RPC. Event payloads
   * from transactions this platform never built (external wallets paying the
   * contract directly) cannot be correlated to a local row yet — they are
   * logged and skipped rather than fabricated into confirmations.
   */
  private async ingestContractEvents(): Promise<void> {
    const contractId = this.contractId()!;
    const cursor = await this.redis.get(CURSOR_KEY);

    const params: Record<string, unknown> = {
      filters: [{ type: 'contract', contractIds: [contractId] }],
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
      await this.redis.set(CURSOR_KEY, nextCursor);
    }
  }

  private async handleContractEvent(event: SorobanEvent): Promise<void> {
    const correlation = extractCorrelationMemo(event);
    if (!correlation) {
      return; // not a platform payment (no sp:<id> memo)
    }
    const tx = await this.prisma.transaction.findFirst({
      where: { meta: { path: ['correlationId'], equals: correlation } } as never,
    });
    if (tx && tx.kind === 'contract_send' && tx.status === 'SUBMITTED') {
      await this.confirm(tx);
    }
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
  }): Promise<void> {
    const updated = await this.prisma.transaction.updateMany({
      where: { id: tx.id, status: 'SUBMITTED' },
      data: { status: 'CONFIRMED' },
    });
    if (updated.count !== 1) {
      return; // already confirmed (or moved) — idempotent
    }

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
    await this.webhooks.dispatch('payment.received' as WebhookEventType, {
      transactionId: tx.id,
      amount: tx.amount,
      assetCode: tx.assetCode,
      toPublicKey: tx.toPublicKey,
    });
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
