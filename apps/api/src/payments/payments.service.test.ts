import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let mockPrisma: Record<string, any>;
  let mockConfig: Record<string, jest.Mock>;
  let mockWallet: Record<string, jest.Mock>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockRates: Record<string, jest.Mock>;
  let mockIpfs: Record<string, jest.Mock>;
  let mockReconciliation: Record<string, jest.Mock>;
  let mockMetrics: { inc: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    mockConfig = {
      get: jest.fn((key: string) => (key === 'STELLAR_NETWORK' ? 'testnet' : undefined)),
    };
    mockPrisma = {
      transaction: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      scheduledPayment: {
        create: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      invoice: { findFirst: jest.fn(), update: jest.fn() },
      paymentLink: { findFirst: jest.fn(), update: jest.fn() },
      setting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(true) };
    mockNotifications = {
      paymentSent: jest.fn(),
      paymentFailed: jest.fn(),
      invoicePaid: jest.fn(),
    };
    mockWebhooks = { dispatch: jest.fn() };
    mockRealtime = { emitToUser: jest.fn() };
    mockRates = { getRate: jest.fn().mockResolvedValue(1.0) };
    mockIpfs = {
      buildReceiptPayload: jest.fn().mockReturnValue({}),
      pinReceipt: jest.fn().mockResolvedValue({
        cid: 'test-cid',
        url: 'https://ipfs.io/ipfs/test-cid',
      }),
    };
    mockReconciliation = { onPaymentSucceeded: jest.fn(), advanceScheduledPayment: jest.fn() };
    mockMetrics = { inc: jest.fn(), set: jest.fn() };

    service = new PaymentsService(
      mockPrisma as any,
      mockConfig as unknown as ConfigService,
      mockWallet as any,
      mockNotifications as any,
      mockWebhooks as any,
      mockRealtime as any,
      mockRates as any,
      mockIpfs as any,
      mockReconciliation as any,
      mockMetrics as any,
    );
  });

  describe('submit', () => {
    const userId = 'user-1';
    const txId = 'tx-1';

    it('throws NotFoundException when transaction not found', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue(null);
      await expect(service.submit(userId, txId, 'fake-xdr')).rejects.toThrow(
        'Transaction not found',
      );
    });

    it('throws BadRequestException when already submitted', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: txId,
        status: 'SUCCEEDED',
      });
      await expect(service.submit(userId, txId, 'fake-xdr')).rejects.toThrow(
        'Transaction already submitted',
      );
    });
  });

  describe('history', () => {
    it('returns paginated results with defaults', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transaction.count.mockResolvedValue(0);
      const result = await service.history('user-1', {});
      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(20);
      expect(result.meta.total).toBe(0);
    });

    it('clamps pageSize to 100 maximum', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transaction.count.mockResolvedValue(0);
      const result = await service.history('user-1', { pageSize: 500 });
      expect(result.meta.pageSize).toBe(100);
    });

    // Regression: `total`/`totalPages` were computed from an UNFILTERED count
    // while the page itself was filtered, so the pagination metadata disagreed
    // with the rows whenever status/direction/assetCode was supplied. The page
    // query and the count must now share the exact same `where`.
    it('applies status/direction/assetCode to BOTH the page query and the count', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([{ id: 'tx-1' }]);
      mockPrisma.transaction.count.mockResolvedValue(1);

      const result = await service.history('user-1', {
        status: 'SUCCEEDED',
        direction: 'OUTGOING',
        assetCode: 'USDC',
      });

      const expectedWhere = {
        userId: 'user-1',
        status: 'SUCCEEDED',
        direction: 'OUTGOING',
        assetCode: 'USDC',
      };
      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      // The count MUST receive the same filter — this is the regression.
      expect(mockPrisma.transaction.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(result.meta.total).toBe(1);
      expect(result.meta.totalPages).toBe(1);
    });

    it('reports the filtered total, not the unfiltered row count', async () => {
      // 3 matching rows filtered out of a much larger unfiltered table.
      mockPrisma.transaction.findMany.mockResolvedValue([{ id: 'tx-1' }]);
      mockPrisma.transaction.count.mockResolvedValue(3);

      const result = await service.history('user-1', { status: 'CONFIRMED' });

      expect(result.meta.total).toBe(3);
      expect(result.meta.totalPages).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('derives totalPages from the filtered total', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transaction.count.mockResolvedValue(45);

      const result = await service.history('user-1', { direction: 'INCOMING', pageSize: 20 });

      expect(result.meta.total).toBe(45);
      expect(result.meta.totalPages).toBe(3);
    });

    it('scopes to the caller and omits unset filters', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transaction.count.mockResolvedValue(0);

      await service.history('user-1', {});

      expect(mockPrisma.transaction.findMany.mock.calls[0][0].where).toEqual({
        userId: 'user-1',
      });
      expect(mockPrisma.transaction.count.mock.calls[0][0].where).toEqual({ userId: 'user-1' });
    });
  });

  describe('cancelScheduled', () => {
    it('marks a scheduled payment as CANCELED', async () => {
      mockPrisma.scheduledPayment.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.cancelScheduled('user-1', 'sched-1');
      expect(result).toEqual({ ok: true });
    });
  });
});
