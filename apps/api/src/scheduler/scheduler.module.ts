import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IndexerModule } from '../indexer/indexer.module';

@Module({
  imports: [WebhooksModule, NotificationsModule, IndexerModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
