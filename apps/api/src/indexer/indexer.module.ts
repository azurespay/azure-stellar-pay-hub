import { Module } from '@nestjs/common';
import { IndexerService } from './indexer.service';
import { HorizonInboundService } from './horizon-inbound.service';
import { InboundReconciliationService } from './inbound.service';
import { ContractReconciliationService } from './contract-reconciliation.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [NotificationsModule, WebhooksModule, RealtimeModule, PaymentsModule],
  providers: [
    IndexerService,
    HorizonInboundService,
    InboundReconciliationService,
    ContractReconciliationService,
  ],
  exports: [IndexerService, HorizonInboundService],
})
export class IndexerModule {}
