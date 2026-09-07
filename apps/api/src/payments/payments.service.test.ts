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
    mockReconciliation = { onPaymentSucceeded: jest.fn() };
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
  });

  describe('cancelScheduled', () => {
    it('marks a scheduled payment as CANCELED', async () => {
      mockPrisma.scheduledPayment.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.cancelScheduled('user-1', 'sched-1');
      expect(result).toEqual({ ok: true });
    });
  });
});
