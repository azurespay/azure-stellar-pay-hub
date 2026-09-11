import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [WalletModule, RealtimeModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, ContractIntegrationService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
