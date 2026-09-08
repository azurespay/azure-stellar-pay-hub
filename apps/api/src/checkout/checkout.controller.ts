import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CsrfBypass, Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  checkoutPayLinkSchema,
  checkoutPayInvoiceSchema,
  signedXdrSchema,
  type CheckoutPayInvoice,
  type CheckoutPayLink,
  type SignedXdr,
} from '@stellar-pay/validation';
import { CheckoutService } from './checkout.service';

/**
 * Public hosted-checkout routes.
 *
 * These are deliberately @CsrfBypass(): the platform authenticates with Bearer
 * JWTs (never cookies), so the double-submit-cookie CSRF guard has nothing to
 * protect here — an unauthenticated payer request can only ever create a
 * PENDING intent whose XDR the payer must still sign with their wallet, and
 * submission is bound to the exact amount/recipient/asset/memo the server
 * recorded. Requiring a double-submit cookie on these routes instead made the
 * hosted checkout unusable from any real browser (no client sends the token
 * header, and cross-origin deployments cannot set the cookie). Tightened
 * per-IP throttling limits intent spam.
 */
@CsrfBypass()
@Public()
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get('payment-link/:code')
  paymentLink(@Param('code') code: string) {
    return this.checkout.getPaymentLink(code);
  }

  @Get('invoice/:number')
  invoice(@Param('number') number: string) {
    return this.checkout.getInvoice(number);
  }

  @Post('payment-link/:code/pay')
  payLink(
    @Param('code') code: string,
    @Body(new ZodValidationPipe({ body: checkoutPayLinkSchema })) body: CheckoutPayLink,
  ) {
    return this.checkout.payPaymentLink(code, body.publicKey, body.amount);
  }

  @Post('invoice/:number/pay')
  payInvoice(
    @Param('number') number: string,
    @Body(new ZodValidationPipe({ body: checkoutPayInvoiceSchema })) body: CheckoutPayInvoice,
  ) {
    return this.checkout.payInvoice(number, body.publicKey);
  }

  @Post('transactions/:id/submit')
  submit(
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: signedXdrSchema })) body: SignedXdr,
  ) {
    return this.checkout.submitSigned(id, body.signedXdr);
  }
}
