import { ConfigService } from '@nestjs/config';
import { InboundReconciliationService, normalizeAmount } from './inbound.service';

function keyedConfig(map: Record<string, unknown>) {
  return { get: jest.fn((key: string) => map[key]) } as unknown as ConfigService;
}

describe('InboundReconciliationService', () => {
  let service: InboundReconciliationService;
  let mockPrisma: Record<string, any>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockReconciliation: Record<string, jest.Mock>;

  const merchant = {
    id: 'merchant-1',
    userId: 'user-merchant',
    settlementPublicKey: 'GAMERCHANTXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'ACTIVE',
  };

  const baseInput = {
    eventId: '12884901889',
    source: 'horizon' as const,
    fromPublicKey: 'GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    toPublicKey: merchant.settlementPublicKey,
    amount: '10',
    assetCode: 'XLM',
    assetIssuer: null,
    hash: 'aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899aa',
    memo: null,
  };

  beforeEach(() => {
    mockPrisma = {
      chainEvent: { create: jest.fn().mockResolvedValue({ id: 'ce-1' }) },
      merchant: { findFirst: jest.fn().mockResolvedValue(merchant) },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ id: 'tx-inbound', ...data })),
      },
      invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    mockNotifications = { paymentReceived: jest.fn().mockResolvedValue(undefined) };
    mockWebhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
    mockRealtime = { emitToUser: jest.fn() };
    mockReconciliation = { onPaymentSucceeded: jest.fn().mockResolvedValue(undefined) };

    service = new InboundReconciliationService(
      mockPrisma as any,
      keyedConfig({ STELLAR_NETWORK: 'testnet' }),
      mockNotifications as any,
      mockWebhooks as any,
      mockRealtime as any,
      mockReconciliation as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('credits a generic inbound payment to the merchant exactly once', async () => {
    const result = await service.handle(baseInput);

    expect(result).toEqual({ created: true, transactionId: 'tx-inbound' });
    expect(mockPrisma.chainEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: `horizon:${baseInput.eventId}`,
        source: 'horizon',
        txHash: baseInput.hash,
      }),
    });
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toPublicKey: merchant.settlementPublicKey,
        fromPublicKey: baseInput.fromPublicKey,
        amount: '10',
        assetCode: 'XLM',
        status: 'CONFIRMED',
        direction: 'INCOMING',
        kind: 'inbound',
        meta: expect.objectContaining({ source: 'horizon', merchantId: 'merchant-1' }),
      }),
    });
    expect(mockNotifications.paymentReceived).toHaveBeenCalledWith({
      userId: 'user-merchant',
      amount: '10',
      assetCode: 'XLM',
      toPublicKey: baseInput.fromPublicKey,
    });
    expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
      'payment.received',
      expect.objectContaining({ transactionId: 'tx-inbound', amount: '10' }),
    );
    expect(mockRealtime.emitToUser).toHaveBeenCalledWith(
      'user-merchant',
      'payment.received',
      expect.objectContaining({ status: 'CONFIRMED', amount: '10' }),
    );
    expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
  });

  it('is idempotent: a duplicate event id is ignored before any state changes', async () => {
    mockPrisma.chainEvent.create.mockRejectedValue({ code: 'P2002' });

    const result = await service.handle(baseInput);

    expect(result).toEqual({ created: false });
    expect(mockPrisma.merchant.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    expect(mockNotifications.paymentReceived).not.toHaveBeenCalled();
  });

  it('ignores payments to addresses that are not ACTIVE merchants', async () => {
    mockPrisma.merchant.findFirst.mockResolvedValue(null);

    const result = await service.handle(baseInput);

    expect(result).toEqual({ created: false });
    expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
  });

  it('skips payments whose transaction is already recorded by the platform', async () => {
    mockPrisma.transaction.findFirst.mockResolvedValue({ id: 'existing', hash: baseInput.hash });

    const result = await service.handle(baseInput);

    expect(result).toEqual({ created: false });
    expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    expect(mockNotifications.paymentReceived).not.toHaveBeenCalled();
  });

  it('never double-credits when a different event id races on the same hash', async () => {
    // The hash `@unique` constraint is the backstop: a second event id for the
    // same on-chain payment (e.g. both listeners observe it) loses the insert
    // and must not create a second record or fire side effects.
    mockPrisma.transaction.create.mockRejectedValueOnce({ code: 'P2002' });

    const result = await service.handle(baseInput);

    expect(result).toEqual({ created: false });
    expect(mockNotifications.paymentReceived).not.toHaveBeenCalled();
    expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
    expect(mockRealtime.emitToUser).not.toHaveBeenCalled();
    expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
  });

  it('rejects non-positive amounts', async () => {
    const result = await service.handle({ ...baseInput, amount: '0' });
    expect(result).toEqual({ created: false });
    expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
  });

  it('reconciles an open invoice when the memo is its number and the amount matches', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: 'inv-1',
      number: 'INV-1001',
      merchantId: 'merchant-1',
      status: 'ISSUED',
      amount: '10',
      assetCode: 'XLM',
    });

    const result = await service.handle({
      ...baseInput,
      memo: 'INV-1001',
      hash: null,
    });

    expect(result.created).toBe(true);
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'invoice',
        memo: 'INV-1001',
        meta: expect.objectContaining({
          type: 'INVOICE',
          invoiceNumber: 'INV-1001',
        }),
      }),
    });
    // Invoice path reuses the shared reconciliation (PAID + merchant notify +
    // webhooks) instead of the generic inbound side effects.
    expect(mockReconciliation.onPaymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invoice' }),
    );
    expect(mockNotifications.paymentReceived).not.toHaveBeenCalled();
    expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
    expect(mockRealtime.emitToUser).toHaveBeenCalled();
  });

  it('falls back to a generic inbound when the memo invoice amount does not match', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({
      id: 'inv-2',
      number: 'INV-1002',
      merchantId: 'merchant-1',
      status: 'ISSUED',
      amount: '99',
      assetCode: 'XLM',
    });

    const result = await service.handle({ ...baseInput, memo: 'INV-1002', hash: null });

    expect(result.created).toBe(true);
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'inbound' }),
    });
    expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockNotifications.paymentReceived).toHaveBeenCalled();
  });
});

describe('normalizeAmount', () => {
  it('trims trailing zeros and leading zeros', () => {
    expect(normalizeAmount('10.0000000')).toBe('10');
    expect(normalizeAmount('0007.500')).toBe('7.5');
    expect(normalizeAmount('0.500')).toBe('0.5');
    expect(normalizeAmount('0')).toBe('0');
  });
});
