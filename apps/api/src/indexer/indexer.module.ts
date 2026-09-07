import { Module } from '@nestjs/common';
import { IndexerService } from './indexer.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [NotificationsModule, WebhooksModule, RealtimeModule],
  providers: [IndexerService],
  exports: [IndexerService],
})
export class IndexerModule {}
