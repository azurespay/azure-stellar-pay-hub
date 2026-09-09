import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  contractSubmitSchema,
  treasuryDepositSchema,
  treasuryMemberActionSchema,
  treasuryProposeWithdrawalSchema,
  type TreasuryDeposit,
  type TreasuryMemberAction,
  type TreasuryProposeWithdrawal,
} from '@stellar-pay/validation';
import { TreasuryService } from './treasury.service';

@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasury: TreasuryService) {}

  @Get('operations')
  listOperations(@CurrentUser() user: AuthenticatedUser) {
    return this.treasury.listOperations(user.userId);
  }

  @Get('withdrawals')
  listWithdrawals(@CurrentUser() user: AuthenticatedUser) {
    return this.treasury.listWithdrawals(user.userId);
  }

  // ── Deposits ────────────────────────────────────────────────────────────

  @Post('deposits')
  createDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: treasuryDepositSchema })) body: TreasuryDeposit,
  ) {
    return this.treasury.createDeposit(user.userId, body);
  }

  @Post('deposits/:id/submit')
  submitDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.treasury.submitDeposit(user.userId, id, body.signedXdr);
  }

  // ── Governed withdrawals ────────────────────────────────────────────────

  @Post('withdrawals')
  propose(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: treasuryProposeWithdrawalSchema }))
    body: TreasuryProposeWithdrawal,
  ) {
    return this.treasury.proposeWithdrawal(user.userId, body);
  }

  @Post('withdrawals/:id/submit')
  submitProposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.treasury.submitProposal(user.userId, id, body.signedXdr);
  }

  @Post('withdrawals/:id/approve')
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: treasuryMemberActionSchema })) body: TreasuryMemberAction,
  ) {
    return this.treasury.approve(user.userId, id, body);
  }

  @Post('withdrawals/:id/approve/confirm')
  confirmApprove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.treasury.confirmAction(user.userId, id, 'approve', body.signedXdr);
  }

  @Post('withdrawals/:id/execute')
  execute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: treasuryMemberActionSchema })) body: TreasuryMemberAction,
  ) {
    return this.treasury.execute(user.userId, id, body);
  }

  @Post('withdrawals/:id/execute/confirm')
  confirmExecute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.treasury.confirmAction(user.userId, id, 'execute', body.signedXdr);
  }
}