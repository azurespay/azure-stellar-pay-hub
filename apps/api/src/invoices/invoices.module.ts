import { Module } from '@nestjs/common';
import { InvoicePayController, InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ContractIntegrationService } from '../contracts/contract-integration.service';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [WalletModule, RealtimeModule],
  controllers: [InvoicesController, InvoicePayController],
  providers: [InvoicesService, ContractIntegrationService],
  exports: [InvoicesService],
})
export class InvoicesModule {}