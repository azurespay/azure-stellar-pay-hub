import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createEscrowSchema,
  escrowCallerActionSchema,
  escrowSubmitSchema,
  type CreateEscrow,
  type EscrowCallerAction,
  type EscrowSubmit,
} from '@stellar-pay/validation';
import { EscrowsService } from './escrows.service';

@Controller('escrows')
export class EscrowsController {
  constructor(private readonly escrows: EscrowsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.escrows.list(user.userId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.escrows.get(user.userId, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createEscrowSchema })) body: CreateEscrow,
  ) {
    return this.escrows.create(user.userId, body);
  }

  @Post(':id/submit')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: escrowSubmitSchema })) body: EscrowSubmit,
  ) {
    return this.escrows.submit(user.userId, id, body.signedXdr);
  }

  @Post(':id/release')
  release(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: escrowCallerActionSchema })) body: EscrowCallerAction,
  ) {
    return this.escrows.release(user.userId, id, body.callerPublicKey);
  }

  @Post(':id/refund')
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: escrowCallerActionSchema })) body: EscrowCallerAction,
  ) {
    return this.escrows.refund(user.userId, id, body.callerPublicKey);
  }

  @Post(':id/release/confirm')
  confirmRelease(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: escrowSubmitSchema })) body: EscrowSubmit,
  ) {
    return this.escrows.confirmAction(user.userId, id, 'release', body.signedXdr);
  }

  @Post(':id/refund/confirm')
  confirmRefund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: escrowSubmitSchema })) body: EscrowSubmit,
  ) {
    return this.escrows.confirmAction(user.userId, id, 'refund', body.signedXdr);
  }
}
