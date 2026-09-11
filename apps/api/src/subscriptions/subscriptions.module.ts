import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [WalletModule, RealtimeModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, ContractIntegrationService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
