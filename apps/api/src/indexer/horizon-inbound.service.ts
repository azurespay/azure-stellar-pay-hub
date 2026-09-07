import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@stellar-pay/database';
import { RedisService } from '../infra/redis.service';
import { InboundReconciliationService } from './inbound.service';

const CURSOR_PREFIX = 'indexer:horizon:';
const PAGE_LIMIT = 100;

interface HorizonPaymentRecord {
  type?: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  paging_token?: string;
}

/**
 * Horizon inbound listener. Polls each ACTIVE merchant's account payment feed
 * and reconciles *classic* Stellar payments that arrive directly at a merchant
 * settlement address (no API submission involved — e.g. a customer wallet
 * paying the merchant's address). Payments the merchant sent out are ignored;
 * only records where the merchant is the destination are credited.
 *
 * Recovery: a per-merchant cursor is persisted in Redis after every page, and
 * the `ChainEvent` unique-event ledger makes re-polls after a cursor loss
 * safe (duplicates are skipped instead of double-credited).
 */
@Injectable()
export class HorizonInboundService {
  private readonly logger = new Logger('HorizonInboundService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly inbound: InboundReconciliationService,
  ) {}

  private horizonUrl(): string {
    return this.config.get<string>('HORIZON_URL') ?? 'https://horizon-testnet.stellar.org';
  }

  async syncOnce(): Promise<void> {
    const merchants = await this.prisma.merchant.findMany({
      where: { status: 'ACTIVE' },
      select: { settlementPublicKey: true },
    });
    for (const merchant of merchants) {
      try {
        await this.pollMerchant(merchant.settlementPublicKey);
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, address: merchant.settlementPublicKey },
          'horizon poll failed for merchant',
        );
      }
    }
  }

  private async pollMerchant(publicKey: string): Promise<void> {
    const cursorKey = `${CURSOR_PREFIX}${publicKey}`;
    const cursor = await this.redis.get(cursorKey);
    const query = `order=asc&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const url = `${this.horizonUrl()}/accounts/${encodeURIComponent(publicKey)}/payments?${query}`;

    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`horizon payments HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      _embedded?: { records?: HorizonPaymentRecord[] };
    };
    const records = body._embedded?.records ?? [];
    if (records.length === 0) {
      return;
    }

    for (const record of records) {
      await this.handlePaymentRecord(publicKey, record).catch((err) =>
        this.logger.warn(
          { err: (err as Error).message, pagingToken: record.paging_token },
          'inbound payment record failed',
        ),
      );
    }

    // Always advance past the last record fetched, regardless of whether any
    // record was credited, so the next poll resumes where this one stopped.
    await this.redis.set(cursorKey, records[records.length - 1].paging_token ?? cursor ?? '');
  }

  private async handlePaymentRecord(
    publicKey: string,
    record: HorizonPaymentRecord,
  ): Promise<void> {
    if (record.type !== 'payment') {
      return;
    }
    if (!record.transaction_successful) {
      return;
    }
    if (!record.paging_token) {
      return;
    }
    // The account feed contains both directions — only inbound is credited.
    if (record.to !== publicKey) {
      return;
    }

    await this.inbound.handle({
      eventId: record.paging_token,
      source: 'horizon',
      fromPublicKey: record.from ?? '',
      toPublicKey: publicKey,
      amount: record.amount ?? '0',
      assetCode: record.asset_type === 'native' ? 'XLM' : (record.asset_code ?? 'XLM'),
      assetIssuer: record.asset_type === 'native' ? null : (record.asset_issuer ?? null),
      hash: record.transaction_hash ?? null,
      memo: null, // Horizon op feeds do not include the transaction memo
    });
  }
}
