import { WebhookEventType } from '@stellar-pay/types';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let mockPrisma: Record<string, any>;
  let mockLogger: { warn: jest.Mock };

  const webhook = {
    id: 'merchant-1:https://example.com/hook',
    merchantId: 'merchant-1',
    url: 'https://example.com/hook',
    secret: 'secret-material',
    events: ['payment.received', 'invoice.paid'],
    status: 'ACTIVE',
  };

  const otherMerchantWebhook = {
    id: 'merchant-2:https://other.example.com/hook',
    merchantId: 'merchant-2',
    url: 'https://other.example.com/hook',
    secret: 'secret-2',
    events: ['payment.received'],
    status: 'ACTIVE',
  };

  beforeEach(() => {
    mockLogger = { warn: jest.fn() };
    mockPrisma = {
      webhook: { findMany: jest.fn(), findUnique: jest.fn() },
      webhookDelivery: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: data.id })),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null), // no-op the async attempt tail
        update: jest.fn(),
      },
    };
    service = new WebhooksService(mockPrisma as any);
    (service as unknown as { logger: { warn: jest.Mock } }).logger = mockLogger as unknown as {
      warn: jest.Mock;
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('persists a delivery with a stable deliveryId embedded in the signed payload', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook]);

    await service.dispatch(
      WebhookEventType.PAYMENT_RECEIVED,
      { transactionId: 'tx-1', amount: '5' },
      { merchantId: 'merchant-1' },
    );

    expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    const { data } = mockPrisma.webhookDelivery.create.mock.calls[0][0];
    const id = data.id;
    expect(id).toEqual(expect.any(String));
    expect(data.payload).toEqual(
      expect.objectContaining({
        deliveryId: id, // the merchant can dedupe on this exact value
        event: 'payment.received',
        timestamp: expect.any(String),
        transactionId: 'tx-1',
        amount: '5',
      }),
    );
  });

  it('gives every logical event a distinct deliveryId', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook]);

    await service.dispatch(WebhookEventType.PAYMENT_RECEIVED, {}, { merchantId: 'merchant-1' });
    await service.dispatch(WebhookEventType.PAYMENT_RECEIVED, {}, { merchantId: 'merchant-1' });

    const ids = mockPrisma.webhookDelivery.create.mock.calls.map(
      (call: [{ data: { id: string } }]) => call[0].data.id,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("never delivers another merchant's event (cross-tenant isolation)", async () => {
    // Two merchants subscribed to the same event type; the query filters by
    // the owning merchant, so an event for merchant-1 never reaches merchant-2.
    mockPrisma.webhook.findMany.mockImplementation(
      async ({ where }: { where: { merchantId: string } }) =>
        Promise.resolve(
          [webhook, otherMerchantWebhook].filter((w) => w.merchantId === where.merchantId),
        ),
    );

    await service.dispatch(WebhookEventType.PAYMENT_RECEIVED, {}, { merchantId: 'merchant-1' });

    expect(mockPrisma.webhook.findMany).toHaveBeenCalledWith({
      where: { merchantId: 'merchant-1', status: 'ACTIVE' },
    });
    expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    const delivery = mockPrisma.webhookDelivery.create.mock.calls[0][0];
    expect(delivery.data.webhookId).toBe('merchant-1:https://example.com/hook');
  });

  it('never broadcasts an event with no attributable merchant', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook, otherMerchantWebhook]);

    await service.dispatch(WebhookEventType.PAYMENT_RECEIVED, {});

    expect(mockPrisma.webhook.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it('retries re-attempt the same delivery id and signed body', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook]);
    mockPrisma.webhookDelivery.findUnique.mockResolvedValue(null); // first attempt no-ops
    await service.dispatch(
      WebhookEventType.INVOICE_PAID,
      { invoiceNumber: 'INV-1' },
      { merchantId: 'merchant-1' },
    );
    const { data } = mockPrisma.webhookDelivery.create.mock.calls[0][0];
    const id = data.id;

    // Scheduler-driven retry re-attempts the SAME delivery row.
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([
      { id, webhookId: webhook.id, status: 'FAILED', payload: data.payload },
    ]);
    mockPrisma.webhookDelivery.findUnique.mockResolvedValue({
      id,
      webhookId: webhook.id,
      payload: data.payload,
    });
    mockPrisma.webhook.findUnique.mockResolvedValue(webhook);
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      await service.retryDueDeliveries();
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(webhook.url);
    // The retried body still carries the original deliveryId so a merchant can
    // recognise it as the same logical event.
    expect(JSON.parse(String(init.body)).deliveryId).toBe(id);
  });

  it('only dispatches to webhooks subscribed to the event', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook]);

    // Valid event type the webhook is NOT subscribed to (it only subscribes to
    // payment.received + invoice.paid) — exercises the subscription filter.
    await service.dispatch(WebhookEventType.SETTLEMENT_COMPLETED, {}, { merchantId: 'merchant-1' });

    expect(mockPrisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});
