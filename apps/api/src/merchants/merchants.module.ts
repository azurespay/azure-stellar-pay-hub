import { Module } from '@nestjs/common';
import { MerchantsController } from './merchants.controller';
import { MerchantsService } from './merchants.service';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [WalletModule, RealtimeModule],
  controllers: [MerchantsController],
  providers: [MerchantsService, ContractIntegrationService],
  exports: [MerchantsService],
})
export class MerchantsModule {}
