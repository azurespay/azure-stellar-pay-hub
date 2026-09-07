import { SchedulerService } from './scheduler.service';

describe('SchedulerService', () => {
  let service: SchedulerService;
  let mockPrisma: Record<string, any>;
  let mockRedis: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockIndexer: Record<string, jest.Mock>;
  let mockHorizonInbound: Record<string, jest.Mock>;
  let mockPaymentLinks: Record<string, jest.Mock>;

  const dueSchedule = {
    id: 'sched-1',
    userId: 'user-1',
    fromPublicKey: 'GPAYER',
    toPublicKey: 'GPAYEE',
    amount: '25',
    assetCode: 'USDC',
    assetIssuer: null,
    memo: null,
    interval: 'weekly',
    nextRunAt: new Date(Date.now() - 1000),
    status: 'ACTIVE',
    totalRuns: 1,
    maxRuns: null,
  };

  beforeEach(() => {
    mockPrisma = {
      scheduledPayment: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ id: 'tx-occ', ...data })),
      },
    };
    mockRedis = { acquireLock: jest.fn().mockResolvedValue(true) };
    mockWebhooks = { retryDueDeliveries: jest.fn().mockResolvedValue(0) };
    mockNotifications = { notify: jest.fn().mockResolvedValue(undefined) };
    mockIndexer = { syncOnce: jest.fn().mockResolvedValue(undefined) };
    mockHorizonInbound = { syncOnce: jest.fn().mockResolvedValue(undefined) };
    mockPaymentLinks = { expireDue: jest.fn().mockResolvedValue(0) };

    service = new SchedulerService(
      mockPrisma as any,
      mockRedis as any,
      mockWebhooks as any,
      mockNotifications as any,
      mockIndexer as any,
      mockHorizonInbound as any,
      mockPaymentLinks as any,
    );
  });

  describe('scheduled payment occurrences (confirmation-gated)', () => {
    it('creates a PENDING occurrence for a due schedule without advancing the schedule row', async () => {
      mockPrisma.scheduledPayment.findMany.mockResolvedValue([dueSchedule]);

      await (service as any).processScheduledPayments();

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          status: 'PENDING',
          kind: 'recurring',
          meta: { scheduledId: 'sched-1', run: 2 },
        }),
      });
      // The schedule itself is NOT touched at creation time: advancement is
      // deferred to on-chain confirmation (advanceScheduledPayment).
      expect(mockPrisma.scheduledPayment.update).not.toHaveBeenCalled();
      expect(mockPrisma.scheduledPayment.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        'user-1',
        'ACCOUNT_ACTIVITY',
        'Scheduled payment is ready',
        { transactionId: 'tx-occ', amount: '25', assetCode: 'USDC' },
      );
    });

    it('skips a schedule that already has an occurrence in flight (PENDING/SUBMITTED)', async () => {
      mockPrisma.scheduledPayment.findMany.mockResolvedValue([dueSchedule]);
      mockPrisma.transaction.findFirst.mockResolvedValue({ id: 'tx-occ-1', status: 'PENDING' });

      await (service as any).processScheduledPayments();

      expect(mockPrisma.transaction.findFirst).toHaveBeenCalledWith({
        where: {
          status: { in: ['PENDING', 'SUBMITTED'] },
          meta: { path: ['scheduledId'], equals: 'sched-1' },
        },
      });
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
      expect(mockNotifications.notify).not.toHaveBeenCalled();
    });

    it('does not double-create when both the scheduled and subscription ticks see the same due row', async () => {
      mockPrisma.scheduledPayment.findMany.mockResolvedValue([dueSchedule]);
      mockPrisma.transaction.findFirst
        .mockResolvedValueOnce(null) // scheduled tick: no in-flight -> creates
        .mockResolvedValueOnce({ id: 'tx-occ-1', status: 'PENDING' }); // subscription tick: skip

      await (service as any).processScheduledPayments();
      await (service as any).processSubscriptionRenewals();

      expect(mockPrisma.transaction.create).toHaveBeenCalledTimes(1);
    });

    it('uses the subscription_renewal kind for interval renewals and notifies that renewal is due', async () => {
      mockPrisma.scheduledPayment.findMany.mockResolvedValue([dueSchedule]);

      await (service as any).processSubscriptionRenewals();

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'subscription_renewal' }),
      });
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        'user-1',
        'ACCOUNT_ACTIVITY',
        'Subscription renewal is due',
        expect.any(Object),
      );
    });

    it('labels one-off schedules with the scheduled kind', async () => {
      mockPrisma.scheduledPayment.findMany.mockResolvedValue([{ ...dueSchedule, interval: null }]);

      await (service as any).processScheduledPayments();

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'scheduled' }),
      });
    });
  });
});
