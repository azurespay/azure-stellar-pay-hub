import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Prisma, PrismaService } from '@stellar-pay/database';
import {
  ConsoleChannelProvider,
  NotificationService as NotificationDispatcher,
  WebhookChannelProvider,
} from '@stellar-pay/notifications';
import { createLogger } from '@stellar-pay/logger';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { NotificationChannel, NotificationType } from '@stellar-pay/types';

interface PaymentNotificationInput {
  userId: string;
  amount: string;
  assetCode: string;
  toPublicKey?: string;
  reason?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = createLogger('notifications');
  private readonly dispatcher: NotificationDispatcher;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    config: ConfigService,
  ) {
    const webhookSecret = config.get<string>('WEBHOOK_SIGNING_SECRET')!;
    this.dispatcher = new NotificationDispatcher()
      .addProvider(new ConsoleChannelProvider('EMAIL' as NotificationChannel))
      .addProvider(new ConsoleChannelProvider('SMS' as NotificationChannel))
      .addProvider(new ConsoleChannelProvider('PUSH' as NotificationChannel))
      .addProvider(
        new WebhookChannelProvider((payload) =>
          createHmac('sha256', webhookSecret).update(payload).digest('hex'),
        ),
      );
  }

  async paymentSent(input: PaymentNotificationInput): Promise<void> {
    await this.notify(input.userId, 'PAYMENT_SENT' as NotificationType, 'Payment sent', {
      amount: input.amount,
      assetCode: input.assetCode,
      toPublicKey: input.toPublicKey,
    });
  }

  async paymentReceived(input: PaymentNotificationInput): Promise<void> {
    await this.notify(input.userId, 'PAYMENT_RECEIVED' as NotificationType, 'Payment received', {
      amount: input.amount,
      assetCode: input.assetCode,
      fromPublicKey: input.toPublicKey,
    });
  }

  async paymentFailed(input: PaymentNotificationInput & { reason: string }): Promise<void> {
    await this.notify(
      input.userId,
      'FAILED_TRANSACTION' as NotificationType,
      'Transaction failed',
      {
        amount: input.amount,
        assetCode: input.assetCode,
        reason: input.reason,
      },
    );
  }

  async invoicePaid(input: { merchantId: string; invoiceNumber: string }): Promise<void> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: input.merchantId } });
    if (!merchant) {
      return;
    }
    await this.notify(merchant.userId, 'INVOICE_PAID' as NotificationType, 'Invoice paid', {
      invoiceNumber: input.invoiceNumber,
    });
  }

  async notify(
    userId: string,
    type: NotificationType,
    title: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId,
          type,
          channel: 'IN_APP' as NotificationChannel,
          title,
          body: title,
          payload: payload as Prisma.InputJsonValue,
          status: 'SENT',
        },
      });
      this.realtime.emitToUser(userId, 'notification', notification);
      // Fan-out to other channels (best-effort).
      await this.dispatcher.dispatchAll([
        { userId, channel: 'EMAIL' as NotificationChannel, type, title, payload, to: undefined },
        { userId, channel: 'SMS' as NotificationChannel, type, title, payload },
      ]);
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'notification dispatch failed');
    }
  }

  async list(userId: string, page = 1, pageSize = 20) {
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return {
      data: items,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
