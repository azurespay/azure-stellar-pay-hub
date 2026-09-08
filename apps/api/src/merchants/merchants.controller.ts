import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createMerchantSchema,
  posPaymentSchema,
  productSchema,
  updateMerchantSchema,
  type CreateMerchant,
  type CreateProduct,
  type PosPayment,
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

  @Get('me/invoices')
  invoices(@CurrentUser() user: AuthenticatedUser) {
    return this.merchants.invoices(user.userId);
  }

  @Get('me/payment-links')
  paymentLinks(@CurrentUser() user: AuthenticatedUser) {
    return this.merchants.paymentLinks(user.userId);
  }

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
}
