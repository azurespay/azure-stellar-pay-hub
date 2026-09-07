import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let mockPrisma: Record<string, any>;
  let mockLogger: { warn: jest.Mock };

  const webhook = {
    id: 'merchant-1:https://example.com/hook',
    url: 'https://example.com/hook',
    secret: 'secret-material',
    events: ['payment.received', 'invoice.paid'],
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
    (service as unknown as { logger: { warn: jest.Mock } }).logger = mockLogger as never;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('persists a delivery with a stable deliveryId embedded in the signed payload', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook]);

    await service.dispatch('payment.received' as never, { transactionId: 'tx-1', amount: '5' });

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

    await service.dispatch('payment.received' as never, {});
    await service.dispatch('payment.received' as never, {});

    const ids = mockPrisma.webhookDelivery.create.mock.calls.map(
      (call: [{ data: { id: string } }]) => call[0].data.id,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('retries re-attempt the same delivery id and signed body', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([webhook]);
    mockPrisma.webhookDelivery.findUnique.mockResolvedValue(null); // first attempt no-ops
    await service.dispatch('invoice.paid' as never, { invoiceNumber: 'INV-1' });
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

    await service.dispatch('transaction.updated' as never, {});

    expect(mockPrisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});
