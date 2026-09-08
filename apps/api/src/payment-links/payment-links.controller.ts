import { Body, Controller, Get, Post } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { createPaymentLinkSchema, type CreatePaymentLink } from '@stellar-pay/validation';
import { PaymentLinksService } from './payment-links.service';
import { PrismaService } from '@stellar-pay/database';

@Controller('merchants/me/payment-links')
export class PaymentLinksController {
  constructor(
    private readonly links: PaymentLinksService,
    private readonly prisma: PrismaService,
  ) {}

  private async merchantIdOf(user: AuthenticatedUser): Promise<string> {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.userId } });
    if (!merchant) {
      throw new ForbiddenException('No merchant profile');
    }
    // Payment links may only be managed by fully ACTIVE merchants.
    if (merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is not active');
    }
    return merchant.id;
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const merchantId = await this.merchantIdOf(user);
    return this.links.list(merchantId);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createPaymentLinkSchema })) body: CreatePaymentLink,
  ) {
    const merchantId = await this.merchantIdOf(user);
    return this.links.create(merchantId, body);
  }
}
