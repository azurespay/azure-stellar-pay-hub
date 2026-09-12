import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@stellar-pay/database';
import type { AssetQuery } from '@stellar-pay/validation';

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AssetQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where: Prisma.AssetWhereInput = { isEnabled: true };
    if (query.type) {
      where.type = query.type;
    }
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.asset.findMany({
        where,
        orderBy: { isNative: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.asset.count({ where }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async getByCode(code: string) {
    const asset = await this.prisma.asset.findFirst({ where: { code } });
    if (!asset) {
      throw new NotFoundException(`Asset ${code} not found`);
    }
    return asset;
  }
}
