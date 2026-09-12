import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Prisma, PrismaService } from '@stellar-pay/database';
import { createLogger } from '@stellar-pay/logger';
import { isPrivateNetworkAddress } from '@stellar-pay/validation';
import type { WebhookEventType } from '@stellar-pay/types';

/** Injection token for the DNS resolver used by the SSRF guard (test seam). */
export const WEBHOOK_HOST_RESOLVER = 'WEBHOOK_HOST_RESOLVER';

/** Resolve a hostname to every address it maps to. */
export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultHostResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((answer) => answer.address);

/** Give a slow merchant endpoint a bounded amount of time to respond. */
const WEBHOOK_TIMEOUT_MS = 10_000;

@Injectable()
export class WebhooksService {
  private readonly logger = createLogger('webhooks');

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(WEBHOOK_HOST_RESOLVER)
    private readonly resolveHost?: HostResolver,
  ) {}

  /** Register (or update) webhook endpoints for the current merchant. */
  async register(merchantId: string, input: { url: string; events: string[]; secret?: string }) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    const secret = input.secret ?? merchant.webhookSecret ?? randomBytes(32).toString('hex');
    return this.prisma.webhook.upsert({
      where: { id: `${merchantId}:${input.url}` },
      update: { url: input.url, events: input.events, secret },
      create: {
        id: `${merchantId}:${input.url}`,
        merchantId,
        url: input.url,
        events: input.events,
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
   * Dispatch an event to the webhooks of the merchant that owns it. Delivery is
   * strictly owner-scoped: a merchant must never receive another merchant's
   * payment data (cross-tenant confidentiality). When no owner can be
   * attributed (e.g. a payer-initiated send with no merchant), nothing is
   * broadcast. Creates a delivery record and POSTs with an HMAC-SHA256
   * signature header; failed deliveries are retried by the scheduler with
   * exponential backoff.
   */
  async dispatch(
    event: WebhookEventType,
    payload: Record<string, unknown>,
    owner?: { merchantId: string },
  ): Promise<void> {
    const ownerMerchantId =
      owner?.merchantId ??
      (typeof payload.merchantId === 'string' ? (payload.merchantId as string) : undefined);
    if (!ownerMerchantId) {
      return; // not attributable to a merchant — never broadcast platform-wide
    }
    const webhooks = await this.prisma.webhook.findMany({
      where: { merchantId: ownerMerchantId, status: 'ACTIVE' },
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
          } as Prisma.InputJsonValue,
          status: 'PENDING',
          nextRetryAt: new Date(Date.now() + 5_000),
        },
      });
      void this.attemptDelivery(webhook.id, delivery.id).catch(() => undefined);
    }
  }

  /**
   * SSRF guard for outbound deliveries.
   *
   * Registration already rejects obviously internal URLs, but the hostname is
   * merchant-controlled and can be changed to point at a private address after
   * the fact (or resolve there via DNS). Since the API makes this request from
   * inside the deployment network, every attempt re-checks the DNS answer and
   * refuses loopback / private / link-local / CGNAT targets.
   */
  private async assertPublicTarget(url: string): Promise<void> {
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, '');
    if (isPrivateNetworkAddress(host)) {
      throw new Error('webhook target is a private or loopback address');
    }
    const addresses = await (this.resolveHost ?? defaultHostResolver)(host);
    if (addresses.length === 0) {
      throw new Error('webhook target did not resolve');
    }
    const blocked = addresses.find((address) => isPrivateNetworkAddress(address));
    if (blocked) {
      throw new Error(`webhook target resolves to a non-public address (${blocked})`);
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
      await this.assertPublicTarget(webhook.url);
    } catch (err) {
      // Permanently undeliverable, so do not burn the retry budget on it:
      // `nextRetryAt: null` keeps the row out of the retry window.
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: `blocked: ${(err as Error).message}`,
          nextRetryAt: null,
        },
      });
      this.logger.warn(
        { webhookId, url: webhook.url, reason: (err as Error).message },
        'webhook delivery blocked by SSRF guard',
      );
      return;
    }
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stellar-pay-signature': signature },
        body,
        // A hanging merchant endpoint must not hold the attempt open forever.
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
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
