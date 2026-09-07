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

  private sumAmounts(amounts: Array<{ amount: string } | null | undefined>): string {
    return amounts.reduce((sum, row) => addAmounts(sum, row?.amount ?? '0'), '0');
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
        select: { amount: true },
      }),
      this.prisma.transaction.findMany({
        where: { status: this.succeededFilter, createdAt: { gte: startOfMonth } },
        select: { amount: true },
      }),
      this.prisma.transaction.findMany({
        where: { status: this.succeededFilter },
        select: { amount: true },
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

    const topMerchants = await this.prisma.merchant.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, name: true },
    });

    return {
      dailyVolume: this.sumAmounts(dailyTxs),
      monthlyVolume: this.sumAmounts(monthlyTxs),
      activeUsers,
      activeMerchants,
      revenue: this.sumAmounts(allSucceeded),
      paymentSuccessRate: successRate,
      failedTransactions: failedCount,
      assetUsage: Object.fromEntries(assetGroups.map((g) => [g.assetCode, String(g._count)])),
      topMerchants: topMerchants.map((m) => ({ merchantId: m.id, name: m.name, volume: '0' })),
      crossBorder: {
        volume: this.sumAmounts(
          await this.prisma.transaction.findMany({
            where: { kind: 'cross_border', status: 'SUCCEEDED' },
            select: { amount: true },
          }),
        ),
        transactions: await this.prisma.transaction.count({ where: { kind: 'cross_border' } }),
        countries: 3, // demo; enrich from beneficiary country codes in production
      },
    };
  }

  /** Daily volume series for a time range. */
  async volume(range: '7d' | '30d' | '90d' = '7d') {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const txs = await this.prisma.transaction.findMany({
      where: { status: this.succeededFilter, createdAt: { gte: since } },
      select: { amount: true, createdAt: true },
    });

    const buckets = new Map<string, { volume: string; count: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      buckets.set(d, { volume: '0', count: 0 });
    }
    for (const tx of txs) {
      const key = tx.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.volume = addAmounts(bucket.volume, tx.amount);
        bucket.count += 1;
      }
    }
    return Array.from(buckets.entries()).map(([date, value]) => ({ date, ...value }));
  }
}
