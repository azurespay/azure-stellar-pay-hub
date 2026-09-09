import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { InfraModule } from './infra/infra.module';
import { RedisService } from './infra/redis.service';
import { RedisThrottlerStorage } from './infra/redis-throttler.storage';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { RolesGuard } from './common/roles.guard';
import { CsrfGuard } from './common/csrf.guard';
import { AuditInterceptor } from './common/audit.interceptor';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { WalletModule } from './wallet/wallet.module';
import { UsersModule } from './users/users.module';
import { PaymentsModule } from './payments/payments.module';
import { TransactionsModule } from './transactions/transactions.module';
import { AssetsModule } from './assets/assets.module';
import { MerchantsModule } from './merchants/merchants.module';
import { InvoicesModule } from './invoices/invoices.module';
import { PaymentLinksModule } from './payment-links/payment-links.module';
import { CheckoutModule } from './checkout/checkout.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { MetricsModule } from './metrics/metrics.module';
import { EscrowsModule } from './escrows/escrows.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({
  imports: [
    // Rate-limit state lives in Redis (not per-process memory) so the limits
    // hold when the API runs more than one instance. E2E suites opt out with
    // THROTTLER_BACKEND=memory so each booted test app gets a fresh in-memory
    // budget — a shared Redis budget would leak counts between suites that run
    // sequentially against the same Postgres/Redis test stack.
    ThrottlerModule.forRootAsync({
      imports: [InfraModule],
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
        ...(process.env.THROTTLER_BACKEND === 'memory'
          ? {}
          : { storage: new RedisThrottlerStorage(redis.raw) }),
      }),
    }),
    InfraModule,
    AuthModule,
    WalletModule,
    UsersModule,
    PaymentsModule,
    TransactionsModule,
    AssetsModule,
    MerchantsModule,
    InvoicesModule,
    PaymentLinksModule,
    CheckoutModule,
    NotificationsModule,
    WebhooksModule,
    AnalyticsModule,
    AdminModule,
    RealtimeModule,
    SchedulerModule,
    MetricsModule,
    EscrowsModule,
    SubscriptionsModule,
    TreasuryModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
