import { Module } from '@nestjs/common';
import { EscrowsController } from './escrows.controller';
import { EscrowsService } from './escrows.service';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [WalletModule, RealtimeModule, NotificationsModule],
  controllers: [EscrowsController],
  providers: [EscrowsService, ContractIntegrationService],
  exports: [EscrowsService],
})
export class EscrowsModule {}
