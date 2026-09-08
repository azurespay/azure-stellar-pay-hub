import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { registerWebhookSchema, type RegisterWebhook } from '@stellar-pay/validation';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '@stellar-pay/database';
import { ForbiddenException } from '@nestjs/common';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  private async merchantOf(user: AuthenticatedUser): Promise<string> {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.userId } });
    if (!merchant) {
      throw new ForbiddenException('No merchant profile linked to this account');
    }
    // Webhooks may only be managed by fully ACTIVE merchants.
    if (merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is not active');
    }
    return merchant.id;
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const merchantId = await this.merchantOf(user);
    return this.webhooks.list(merchantId);
  }

  @Post()
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: registerWebhookSchema })) body: RegisterWebhook,
  ) {
    const merchantId = await this.merchantOf(user);
    return this.webhooks.register(merchantId, body);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const merchantId = await this.merchantOf(user);
    return this.webhooks.remove(merchantId, id);
  }
}
