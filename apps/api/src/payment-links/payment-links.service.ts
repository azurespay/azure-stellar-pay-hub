import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import type { CreatePaymentLink } from '@stellar-pay/validation';

@Injectable()
export class PaymentLinksService {
  constructor(private readonly prisma: PrismaService) {}

  private nextCode(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  async create(merchantId: string, input: CreatePaymentLink) {
    const code = this.nextCode();
    return this.prisma.paymentLink.create({
      data: {
        merchantId,
        code,
        title: input.title,
        description: input.description,
        amount: input.amount,
        assetCode: input.assetCode ?? 'USDC',
        assetIssuer: input.assetIssuer,
        fixedAmount: input.fixedAmount ?? true,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        redirectUrl: input.redirectUrl,
      },
    });
  }

  async list(merchantId: string) {
    return this.prisma.paymentLink.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Public lookup used by the hosted checkout. */
  async getByCode(code: string) {
    const link = await this.prisma.paymentLink.findUnique({
      where: { code },
      include: { merchant: { select: { name: true } } },
    });
    if (!link || link.status !== 'ACTIVE') {
      throw new NotFoundException('Payment link not found or inactive');
    }
    if (link.expiresAt && link.expiresAt < new Date()) {
      throw new NotFoundException('Payment link has expired');
    }
    return link;
  }

  /**
   * Scheduler sweep: flip ACTIVE links whose expiry passed to EXPIRED so the
   * merchant dashboard never shows a stale link as ACTIVE. The checkout GET/POST
   * endpoints independently refuse expired links (server-enforced on every
   * request), so this only corrects the stored state.
   */
  async expireDue(): Promise<number> {
    const { count } = await this.prisma.paymentLink.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }
}
