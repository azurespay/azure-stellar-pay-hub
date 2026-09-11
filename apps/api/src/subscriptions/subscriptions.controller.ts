import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  createSubscriptionPlanSchema,
  contractSubmitSchema,
  subscribePlanSchema,
  subscriptionCallSchema,
  type CreateSubscriptionPlan,
  type SubscribePlan,
  type SubscriptionCall,
} from '@stellar-pay/validation';
import { SubscriptionsService } from './subscriptions.service';

@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  // ── Plans (merchant-owned) ─────────────────────────────────────────────

  @Get('subscription-plans')
  listPlans(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.listPlans(user.userId);
  }

  @Post('subscription-plans')
  createPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe({ body: createSubscriptionPlanSchema }))
    body: CreateSubscriptionPlan,
  ) {
    return this.subscriptions.createPlan(user.userId, body);
  }

  @Post('subscription-plans/:id/submit')
  submitPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.subscriptions.submitPlan(user.userId, id, body.signedXdr);
  }

  // ── Subscriptions (subscriber-owned) ───────────────────────────────────

  @Get('subscriptions')
  listSubscriptions(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.listSubscriptions(user.userId);
  }

  @Post('subscription-plans/:planId/subscribe')
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Param('planId') planId: string,
    @Body(new ZodValidationPipe({ body: subscribePlanSchema })) body: SubscribePlan,
  ) {
    return this.subscriptions.subscribe(user.userId, planId, body);
  }

  @Post('subscriptions/:id/submit')
  submitSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.subscriptions.submitSubscription(user.userId, id, body.signedXdr);
  }

  @Post('subscriptions/:id/renew')
  renew(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: subscriptionCallSchema })) body: SubscriptionCall,
  ) {
    return this.subscriptions.renew(user.userId, id, body);
  }

  @Post('subscriptions/:id/renew/confirm')
  confirmRenew(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.subscriptions.confirmAction(user.userId, id, 'renew', body.signedXdr);
  }

  @Post('subscriptions/:id/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: subscriptionCallSchema })) body: SubscriptionCall,
  ) {
    return this.subscriptions.cancel(user.userId, id, body);
  }

  @Post('subscriptions/:id/cancel/confirm')
  confirmCancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe({ body: contractSubmitSchema })) body: { signedXdr: string },
  ) {
    return this.subscriptions.confirmAction(user.userId, id, 'cancel', body.signedXdr);
  }
}
