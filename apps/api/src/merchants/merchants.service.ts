import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@stellar-pay/database';
import { createId } from '@stellar-pay/shared';
import { buildPaymentUri } from '@stellar-pay/shared';
import type { CreateMerchant, UpdateMerchant, CreateProduct } from '@stellar-pay/validation';

@Injectable()
export class MerchantsService {
  constructor(private readonly prisma: PrismaService) {}

  async register(userId: string, input: CreateMerchant) {
    const existing = await this.prisma.merchant.findUnique({ where: { userId } });
    if (existing) {
      throw new ConflictException('Merchant profile already exists');
    }
    const slugTaken = await this.prisma.merchant.findUnique({ where: { slug: input.slug } });
    if (slugTaken) {
      throw new ConflictException('Merchant slug is already taken');
    }
    const merchant = await this.prisma.merchant.create({
      data: {
        userId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        logoUrl: input.logoUrl,
        websiteUrl: input.websiteUrl,
        currency: input.currency ?? 'USD',
        settlementAssetCode: input.settlementAssetCode ?? 'USDC',
        settlementAssetIssuer: input.settlementAssetIssuer,
        settlementPublicKey: input.settlementPublicKey,
        webhookUrl: input.webhookUrl,
        webhookSecret: createId(),
        status: 'PENDING',
      },
    });
    // Elevate the user to the merchant role.
    await this.prisma.user.update({ where: { id: userId }, data: { role: 'MERCHANT' } });
    return merchant;
  }

  /**
   * View the caller's own profile. SUSPENDED/REJECTED merchants are locked
   * out entirely (an admin suspension therefore takes effect on the next
   * request rather than only blocking new inbound credits); a PENDING
   * merchant may still see and refine its profile while awaiting approval.
   */
  async me(userId: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId } });
    if (!merchant) {
      throw new NotFoundException('No merchant profile for this account');
    }
    if (merchant.status === 'SUSPENDED' || merchant.status === 'REJECTED') {
      throw new ForbiddenException('Merchant account is not active');
    }
    return merchant;
  }

  /** Fetch the caller's merchant and require it to be fully ACTIVE. */
  private async activeMerchant(userId: string) {
    const merchant = await this.me(userId);
    if (merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is not yet active');
    }
    return merchant;
  }

  async update(userId: string, input: UpdateMerchant) {
    const merchant = await this.me(userId);
    return this.prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        name: input.name,
        description: input.description,
        logoUrl: input.logoUrl,
        websiteUrl: input.websiteUrl,
        settlementPublicKey: input.settlementPublicKey,
        webhookUrl: input.webhookUrl,
      },
    });
  }

  async products(userId: string, page = 1, pageSize = 50) {
    const merchant = await this.activeMerchant(userId);
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where: { merchantId: merchant.id } }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async createProduct(userId: string, input: CreateProduct) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: input.name,
        description: input.description,
        priceAmount: input.priceAmount,
        assetCode: input.assetCode ?? 'USDC',
        assetIssuer: input.assetIssuer,
        imageUrl: input.imageUrl,
      },
    });
  }

  async deleteProduct(userId: string, productId: string) {
    const merchant = await this.activeMerchant(userId);
    await this.prisma.product.deleteMany({ where: { id: productId, merchantId: merchant.id } });
    return { ok: true };
  }

  async invoices(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.invoice.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async paymentLinks(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.paymentLink.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async settlements(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async customers(userId: string) {
    const merchant = await this.activeMerchant(userId);
    return this.prisma.customer.findMany({
      where: { merchantId: merchant.id },
      orderBy: { totalSpent: 'desc' },
    });
  }

  /** POS checkout: sum products (or a custom amount) into a payment URI + QR payload. */
  async posCheckout(
    userId: string,
    input: {
      productIds?: string[];
      amount?: string;
      assetCode?: string;
      customerPublicKey?: string;
    },
  ) {
    const merchant = await this.activeMerchant(userId);
    let amount = input.amount;
    let assetCode = input.assetCode ?? merchant.settlementAssetCode;
    if (!amount && input.productIds?.length) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: input.productIds }, merchantId: merchant.id, status: 'ACTIVE' },
      });
      if (products.length !== input.productIds.length) {
        throw new NotFoundException('One or more products not found');
      }
      amount = products.reduce((sum, p) => sum + Number(p.priceAmount), 0).toString();
      assetCode = products[0]?.assetCode ?? assetCode;
    }
    if (!amount) {
      throw new ConflictException('Provide either products or an amount');
    }
    const uri = buildPaymentUri({
      destination: merchant.settlementPublicKey,
      amount,
      assetCode,
      assetIssuer: merchant.settlementAssetIssuer ?? undefined,
    });
    return { uri, qrPayload: uri, amount, assetCode, merchantName: merchant.name };
  }
}
