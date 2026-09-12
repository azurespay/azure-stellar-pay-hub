import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createMerchantSchema,
  merchantRegisterOnChainSchema,
  merchantSettleSchema,
  posPaymentSchema,
  productSchema,
  recordMerchantSaleSchema,
  contractSubmitSchema,
  updateMerchantSchema,
  type CreateMerchant,
  type CreateProduct,
  type MerchantRegisterOnChain,
  type MerchantSettle,
  type PosPayment,
  type RecordMerchantSale,
  type UpdateMerchant,
} from '@stellar-pay/validation';
import { MerchantsService } from './merchants.service';

@Controller('merchants')
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Post()
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createMerchantSchema })) body: CreateMerchant,
  ) {
    return this.merchants.register(user.userId, body);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.merchants.me(user.userId);
  }

  @Patch('me')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: updateMerchantSchema })) body: UpdateMerchant,
  ) {
    return this.merchants.update(user.userId, body);
  }

  @Get('me/products')
  products(@CurrentUser() user: AuthenticatedUser, @Query('page') page = '1') {
    return this.merchants.products(user.userId, Number(page));
  }

  @Post('me/products')
  createProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: productSchema })) body: CreateProduct,
  ) {
    return this.merchants.createProduct(user.userId, body);
  }

  @Delete('me/products/:id')
  deleteProduct(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.merchants.deleteProduct(user.userId, id);
  }

  // NOTE: `GET /merchants/me/invoices` and `GET /merchants/me/payment-links`
  // are owned by InvoicesController and PaymentLinksController (same paths,
  // same active-merchant gate). They used to be declared here *as well*, which
  // registered the same method+path twice — Express then dispatched to
  // whichever handler was registered first (module import order), silently
  // making the other one dead code.

  @Get('me/settlements')
  settlements(@CurrentUser() user: AuthenticatedUser) {
    return this.merchants.settlements(user.userId);
  }

  @Get('me/customers')
  customers(@CurrentUser() user: AuthenticatedUser) {
    return this.merchants.customers(user.userId);
  }

  @Post('me/pos-checkout')
  posCheckout(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: posPaymentSchema })) body: PosPayment,
  ) {
    return this.merchants.posCheckout(user.userId, body);
  }

  // ── On-chain merchant contract ─────────────────────────────────────────

  @Post(':id/onchain/sale')
  recordSale(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: recordMerchantSaleSchema })) body: RecordMerchantSale,
  ) {
    return this.merchants.recordSale(user.userId, id, body);
  }

  @Post(':id/onchain/sale/submit')
  submitSale(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.merchants.submitSale(body.signedXdr);
  }

  @Post('me/onchain/register')
  registerOnChain(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: merchantRegisterOnChainSchema }))
    body: MerchantRegisterOnChain,
  ) {
    return this.merchants.registerOnChain(user.userId, body);
  }

  @Post('me/onchain/register/submit')
  submitRegisterOnChain(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.merchants.submitRegisterOnChain(user.userId, body.signedXdr);
  }

  @Post('me/onchain/settle')
  settleOnChain(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: merchantSettleSchema })) body: MerchantSettle,
  ) {
    return this.merchants.settleOnChain(user.userId, body);
  }

  @Post('me/onchain/settle/:settlementId/submit')
  submitSettle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('settlementId') settlementId: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.merchants.submitSettle(user.userId, settlementId, body.signedXdr);
  }
}
