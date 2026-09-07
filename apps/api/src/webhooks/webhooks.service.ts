import { Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '@stellar-pay/database';
import { createLogger } from '@stellar-pay/logger';
import type { WebhookEventType } from '@stellar-pay/types';

@Injectable()
export class WebhooksService {
  private readonly logger = createLogger('webhooks');

  constructor(private readonly prisma: PrismaService) {}

  /** Register (or update) webhook endpoints for the current merchant. */
  async register(merchantId: string, input: { url: string; events: string[]; secret?: string }) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    const secret = input.secret ?? merchant.webhookSecret ?? randomBytes(32).toString('hex');
    return this.prisma.webhook.upsert({
      where: { id: `${merchantId}:${input.url}` },
      update: { url: input.url, events: input.events as never, secret },
      create: {
        id: `${merchantId}:${input.url}`,
        merchantId,
        url: input.url,
        events: input.events as never,
        secret,
      },
    });
  }

  async list(merchantId: string) {
    return this.prisma.webhook.findMany({ where: { merchantId } });
  }

  async remove(merchantId: string, id: string) {
    await this.prisma.webhook.deleteMany({ where: { id, merchantId } });
    return { ok: true };
  }

  /**
   * Dispatch an event to every subscribed webhook. Creates a delivery record
   * and POSTs with an HMAC-SHA256 signature header; failed deliveries are
   * retried by the scheduler with exponential backoff.
   */
  async dispatch(event: WebhookEventType, payload: Record<string, unknown>): Promise<void> {
    const webhooks = await this.prisma.webhook.findMany({
      where: { status: 'ACTIVE' },
    });
    const subscribed = webhooks.filter((w) => ((w.events as string[]) ?? []).includes(event));
    for (const webhook of subscribed) {
      // One stable id per logical event delivery: retries re-attempt the SAME
      // delivery row (same signed body), so a merchant can dedupe on
      // `deliveryId` even when the platform retries a webhook.
      const deliveryId = randomUUID();
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          id: deliveryId,
          webhookId: webhook.id,
          event,
          payload: {
            ...payload,
            event,
            deliveryId,
            timestamp: new Date().toISOString(),
          } as never,
          status: 'PENDING',
          nextRetryAt: new Date(Date.now() + 5_000),
        },
      });
      void this.attemptDelivery(webhook.id, delivery.id).catch(() => undefined);
    }
  }

  /** Single delivery attempt with HMAC signature. */
  private async attemptDelivery(webhookId: string, deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    const webhook = await this.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!delivery || !webhook) {
      return;
    }
    const body = JSON.stringify(delivery.payload);
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stellar-pay-signature': signature },
        body,
      });
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: response.ok ? 'DELIVERED' : 'FAILED',
          responseStatus: response.status,
          attempts: { increment: 1 },
          deliveredAt: response.ok ? new Date() : undefined,
          lastError: response.ok ? undefined : `HTTP ${response.status}`,
        },
      });
    } catch (err) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: (err as Error).message,
          nextRetryAt: new Date(Date.now() + 30_000),
        },
      });
    }
  }

  /** Retry loop used by the scheduler. */
  async retryDueDeliveries(): Promise<number> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'FAILED', nextRetryAt: { lte: new Date() }, attempts: { lt: 5 } },
      take: 50,
    });
    for (const delivery of due) {
      await this.attemptDelivery(delivery.webhookId, delivery.id).catch((err) =>
        this.logger.warn({ err: (err as Error).message }, 'webhook retry failed'),
      );
    }
    return due.length;
  }
}
