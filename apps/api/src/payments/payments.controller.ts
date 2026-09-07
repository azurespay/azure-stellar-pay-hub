import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createPaymentSchema,
  paymentRequestSchema,
  transactionListQuerySchema,
  type CreatePayment,
  type PaymentRequestInput,
  type TransactionListQuery,
} from '@stellar-pay/validation';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createPaymentSchema })) body: CreatePayment,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.payments.create(user.userId, body, this.normalizeKey(idempotencyKey));
  }

  @Post('simulate')
  simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createPaymentSchema })) body: CreatePayment,
  ) {
    return this.payments.simulate(body);
  }

  @Post('request')
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: paymentRequestSchema })) body: PaymentRequestInput,
  ) {
    return this.payments.createRequest(body);
  }

  @Post('cross-border/quote')
  quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createPaymentSchema })) body: CreatePayment,
  ) {
    return this.payments.crossBorderQuote(body);
  }

  @Post(':id/submit')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body('signedXdr') signedXdr: string,
  ) {
    if (!signedXdr) {
      throw new Error('signedXdr is required');
    }
    return this.payments.submit(user.userId, id, signedXdr);
  }

  @Get('history')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe({ query: transactionListQuerySchema }))
    query: TransactionListQuery,
  ) {
    return this.payments.history(user.userId, query);
  }

  @Get('scheduled')
  scheduled(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.scheduled(user.userId);
  }

  @Delete('scheduled/:id')
  cancelScheduled(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.payments.cancelScheduled(user.userId, id);
  }

  @Get(':id/receipt')
  receipt(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.payments.receipt(user.userId, id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.payments.get(user.userId, id);
  }

  /** Validate + normalize the optional client dedupe key. */
  private normalizeKey(key?: string): string | undefined {
    const trimmed = key?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > 128) {
      throw new BadRequestException('Idempotency-Key must be at most 128 characters');
    }
    return trimmed;
  }
}
