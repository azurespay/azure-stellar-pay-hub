import { Injectable } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { addAmounts } from '@stellar-pay/shared';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Terminal success states: SUCCEEDED (classic) and CONFIRMED (contract route). */
  private readonly succeededFilter: { in: ('SUCCEEDED' | 'CONFIRMED')[] } = {
    in: ['SUCCEEDED', 'CONFIRMED'],
  };

  /** Sum decimal amounts per assetCode (an XLM value is not a USDC value). */
  private sumByAsset(amounts: Array<{ amount: string; assetCode: string }>): {
    total: string;
    byAsset: Record<string, string>;
  } {
    const byAsset: Record<string, string> = {};
    for (const row of amounts) {
      byAsset[row.assetCode] = addAmounts(byAsset[row.assetCode] ?? '0', row.amount);
    }
    // A scalar "total" is only meaningful when a single asset is present.
    const codes = Object.keys(byAsset);
    const total = codes.length === 1 ? (byAsset[codes[0]] ?? '0') : codes.join('+');
    return { total, byAsset };
  }

  /** Full dashboard metrics (admin). */
  async dashboard() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      dailyTxs,
      monthlyTxs,
      allSucceeded,
      failedCount,
      activeUsers,
      activeMerchants,
      assetGroups,
    ] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { status: this.succeededFilter, createdAt: { gte: startOfDay } },
        select: { amount: true, assetCode: true },
      }),
      this.prisma.transaction.findMany({
        where: { status: this.succeededFilter, createdAt: { gte: startOfMonth } },
        select: { amount: true, assetCode: true },
      }),
      this.prisma.transaction.findMany({
        where: { status: this.succeededFilter },
        select: { amount: true, assetCode: true, kind: true, meta: true },
      }),
      this.prisma.transaction.count({ where: { status: 'FAILED' } }),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.merchant.count({ where: { status: 'ACTIVE' } }),
      this.prisma.transaction.groupBy({ by: ['assetCode'], _count: true }),
    ]);

    const totalCount = await this.prisma.transaction.count();
    const succeededCount = await this.prisma.transaction.count({
      where: { status: this.succeededFilter },
    });
    // No transactions yet — there is no rate to report. Never default to a
    // fabricated 100% success rate.
    const successRate: number | null = totalCount
      ? Math.round((succeededCount / totalCount) * 1000) / 10
      : null;

    const today = this.sumByAsset(dailyTxs);
    const month = this.sumByAsset(monthlyTxs);
    const all = this.sumByAsset(allSucceeded);

    // Top merchants by collected volume (invoice / payment-link / inbound rows
    // carry their owning merchant in meta.merchantId).
    const merchantVolume = new Map<string, string>();
    for (const tx of allSucceeded) {
      const meta = (tx.meta ?? {}) as { merchantId?: string };
      const merchantId = meta.merchantId;
      if (!merchantId) {
        continue;
      }
      merchantVolume.set(merchantId, addAmounts(merchantVolume.get(merchantId) ?? '0', tx.amount));
    }
    const topMerchants = await this.prisma.merchant.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, name: true },
    });
    const ranked = topMerchants
      .map((m) => ({ merchantId: m.id, name: m.name, volume: merchantVolume.get(m.id) ?? '0' }))
      .filter((m) => m.volume !== '0')
      .sort((a, b) => Number(b.volume) - Number(a.volume))
      .slice(0, 5);

    // Real country count from registered beneficiaries, not a hard-coded demo.
    const beneficiaryCountries = await this.prisma.beneficiary.findMany({
      where: { country: { not: null } },
      select: { country: true },
      distinct: ['country'],
    });
    const countries = beneficiaryCountries.filter((b) => b.country !== '').length;

    return {
      dailyVolume: today.total,
      monthlyVolume: month.total,
      revenue: all.total,
      volumeByAsset: { today: today.byAsset, month: month.byAsset, all: all.byAsset },
      activeUsers,
      activeMerchants,
      paymentSuccessRate: successRate,
      failedTransactions: failedCount,
      assetUsage: Object.fromEntries(assetGroups.map((g) => [g.assetCode, String(g._count)])),
      topMerchants: ranked,
      crossBorder: {
        volume: this.sumByAsset(
          await this.prisma.transaction.findMany({
            where: { kind: 'cross_border', status: 'SUCCEEDED' },
            select: { amount: true, assetCode: true },
          }),
        ).total,
        transactions: await this.prisma.transaction.count({ where: { kind: 'cross_border' } }),
        countries,
      },
    };
  }

  /** Daily volume series for a time range. */
  async volume(range: '7d' | '30d' | '90d' = '7d') {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const txs = await this.prisma.transaction.findMany({
      where: { status: this.succeededFilter, createdAt: { gte: since } },
      select: { amount: true, assetCode: true, createdAt: true },
    });

    const buckets = new Map<string, { byAsset: Record<string, string>; count: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      buckets.set(d, { byAsset: {}, count: 0 });
    }
    for (const tx of txs) {
      const key = tx.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.byAsset[tx.assetCode] = addAmounts(bucket.byAsset[tx.assetCode] ?? '0', tx.amount);
        bucket.count += 1;
      }
    }
    return Array.from(buckets.entries()).map(([date, value]) => ({
      date,
      // A scalar is only meaningful for a single asset; mixed-asset days keep
      // the chart numeric and expose the breakdown via `byAsset`.
      volume: this.singleAssetTotal(value.byAsset),
      byAsset: value.byAsset,
      transactions: value.count,
    }));
  }

  private singleAssetTotal(byAsset: Record<string, string>): string {
    const codes = Object.keys(byAsset);
    if (codes.length === 0) {
      return '0';
    }
    return codes.length === 1 ? byAsset[codes[0]] : '0';
  }
}
