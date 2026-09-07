import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public explorer queries (transaction data is public on Stellar). */
  async list(query: {
    page?: number;
    pageSize?: number;
    status?: string;
    assetCode?: string;
    search?: string;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where: Record<string, unknown> = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.assetCode) {
      where.assetCode = query.assetCode;
    }
    if (query.search) {
      where.OR = [
        { hash: { contains: query.search, mode: 'insensitive' } },
        { fromPublicKey: { contains: query.search, mode: 'insensitive' } },
        { toPublicKey: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where: where as never }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async getById(id: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    return tx;
  }

  async getByHash(hash: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { hash } });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    return tx;
  }

  async accountHistory(publicKey: string, page = 1, pageSize = 20) {
    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { OR: [{ fromPublicKey: publicKey }, { toPublicKey: publicKey }] },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({
        where: { OR: [{ fromPublicKey: publicKey }, { toPublicKey: publicKey }] },
      }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async stats() {
    const [txCount, succeeded, failed] = await Promise.all([
      this.prisma.transaction.count(),
      // SUCCEEDED (classic path) and CONFIRMED (contract route, indexed
      // on-chain) are both successful terminal states.
      this.prisma.transaction.count({ where: { status: { in: ['SUCCEEDED', 'CONFIRMED'] } } }),
      this.prisma.transaction.count({ where: { status: 'FAILED' } }),
    ]);
    return {
      transactions: txCount,
      succeeded,
      failed,
      totalVolumeXlm: '0',
      // No transactions yet — there is no rate to report. Never default to a
      // fabricated 100% success rate.
      successRate: txCount ? Math.round((succeeded / txCount) * 1000) / 10 : null,
    };
  }
}
