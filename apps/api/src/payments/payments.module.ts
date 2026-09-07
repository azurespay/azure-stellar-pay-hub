import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ExchangeRateService } from './exchange-rate.service';
import { TransactionReconciliationService } from './transaction-reconciliation.service';
import { WalletModule } from '../wallet/wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [WalletModule, NotificationsModule, WebhooksModule, RealtimeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, ExchangeRateService, TransactionReconciliationService],
  exports: [PaymentsService, TransactionReconciliationService],
})
export class PaymentsModule {}
