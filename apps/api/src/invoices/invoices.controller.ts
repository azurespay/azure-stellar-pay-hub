import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createInvoiceSchema,
  payOnChainInvoiceSchema,
  contractSubmitSchema,
  type CreateInvoice,
  type PayOnChainInvoice,
} from '@stellar-pay/validation';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '@stellar-pay/database';

@Controller('merchants/me/invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
  ) {}

  private async merchantIdOf(user: AuthenticatedUser): Promise<string> {
    const merchant = await this.prisma.merchant.findUnique({ where: { userId: user.userId } });
    if (!merchant) {
      throw new ForbiddenException('No merchant profile');
    }
    // Invoices may only be managed by fully ACTIVE merchants (suspension and
    // pre-approval states are enforced at the API boundary).
    if (merchant.status !== 'ACTIVE') {
      throw new ForbiddenException('Merchant account is not active');
    }
    return merchant.id;
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.list(merchantId);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createInvoiceSchema })) body: CreateInvoice,
  ) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.create(merchantId, body);
  }

  @Post(':id/cancel')
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.cancel(merchantId, id);
  }

  // ── On-chain invoice lifecycle (Soroban invoices contract) ─────────────

  @Post(':id/issue-onchain')
  async issueOnChain(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.issueOnChain(merchantId, id);
  }

  @Post(':id/issue-onchain/submit')
  async submitIssueOnChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.submitIssueOnChain(merchantId, id, body.signedXdr);
  }

  @Post(':id/cancel-onchain')
  async cancelOnChain(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.cancelOnChain(merchantId, id);
  }

  @Post(':id/cancel-onchain/submit')
  async submitCancelOnChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    const merchantId = await this.merchantIdOf(user);
    return this.invoices.submitCancelOnChain(merchantId, id, body.signedXdr);
  }
}

@Controller('invoices')
export class InvoicePayController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post(':id/pay-onchain')
  payOnChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: payOnChainInvoiceSchema })) body: PayOnChainInvoice,
  ) {
    return this.invoices.payOnChain(id, {
      payerPublicKey: body.payerPublicKey,
      payerUserId: user.userId,
    });
  }

  @Post(':id/pay-onchain/confirm')
  submitPayOnChain(
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.invoices.submitPayOnChain(id, body.signedXdr);
  }
}
