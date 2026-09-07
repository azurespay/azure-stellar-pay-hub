import { TransactionReconciliationService } from './transaction-reconciliation.service';

describe('TransactionReconciliationService', () => {
  let service: TransactionReconciliationService;
  let mockPrisma: Record<string, any>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;

  const baseTx = {
    id: 'tx-1',
    amount: '14.5',
    assetCode: 'USDC',
    toPublicKey: 'GPAYER',
    kind: 'invoice',
    meta: {},
  };

  beforeEach(() => {
    mockPrisma = {
      invoice: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paymentLink: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
      scheduledPayment: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockNotifications = { invoicePaid: jest.fn(), notify: jest.fn() };
    mockWebhooks = { dispatch: jest.fn() };
    service = new TransactionReconciliationService(
      mockPrisma as any,
      mockNotifications as any,
      mockWebhooks as any,
    );
  });

  describe('invoice reconciliation', () => {
    it('marks an ISSUED invoice PAID, notifies the merchant and dispatches webhooks', async () => {
      const invoice = {
        id: 'inv-1',
        number: 'INV-2026-ABC123',
        merchantId: 'merchant-1',
        status: 'ISSUED',
      };
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);

      await service.onPaymentSucceeded({
        ...baseTx,
        kind: 'invoice',
        meta: { type: 'INVOICE', invoiceNumber: 'INV-2026-ABC123' },
      });

      expect(mockPrisma.invoice.findUnique).toHaveBeenCalledWith({
        where: { number: 'INV-2026-ABC123' },
      });
      expect(mockPrisma.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: { in: ['ISSUED', 'DRAFT'] } },
        data: {
          status: 'PAID',
          paidAt: expect.any(Date),
          paymentTransactionId: 'tx-1',
        },
      });
      expect(mockNotifications.invoicePaid).toHaveBeenCalledWith({
        merchantId: 'merchant-1',
        invoiceNumber: 'INV-2026-ABC123',
      });
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'invoice.paid',
        {
          invoiceNumber: 'INV-2026-ABC123',
          transactionId: 'tx-1',
        },
        { merchantId: 'merchant-1' },
      );
      // Owner-scoped: the merchant that owns the invoice receives the event.
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'payment.received',
        {
          transactionId: 'tx-1',
          amount: '14.5',
          assetCode: 'USDC',
          toPublicKey: 'GPAYER',
        },
        { merchantId: 'merchant-1' },
      );
    });

    it('does not modify an invoice that is already PAID or CANCELED', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        number: 'INV-2026-ABC123',
        merchantId: 'merchant-1',
        status: 'CANCELED',
      });

      await service.onPaymentSucceeded({
        ...baseTx,
        meta: { type: 'INVOICE', invoiceNumber: 'INV-2026-ABC123' },
      });

      expect(mockPrisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.invoicePaid).not.toHaveBeenCalled();
      // No owner-scoped fan-out either: nothing may be broadcast platform-wide.
      expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
    });

    it('falls back to the customer-public-key heuristic when no invoice number is recorded', async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: 'inv-2',
        number: 'INV-2026-DEF456',
        merchantId: 'merchant-1',
        status: 'DRAFT',
      });

      await service.onPaymentSucceeded({ ...baseTx, kind: 'invoice' });

      expect(mockPrisma.invoice.findFirst).toHaveBeenCalledWith({
        where: { customerPublicKey: 'GPAYER', status: { in: ['ISSUED', 'DRAFT'] } },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrisma.invoice.updateMany).toHaveBeenCalled();
    });

    it('does not double-notify when a concurrent reconciler already marked the invoice PAID', async () => {
      const invoice = {
        id: 'inv-1',
        number: 'INV-2026-ABC123',
        merchantId: 'merchant-1',
        status: 'ISSUED',
      };
      mockPrisma.invoice.findUnique.mockResolvedValue(invoice);
      // Another worker won the guarded ISSUED/DRAFT → PAID transition.
      mockPrisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await service.onPaymentSucceeded({
        ...baseTx,
        kind: 'invoice',
        meta: { type: 'INVOICE', invoiceNumber: 'INV-2026-ABC123' },
      });

      expect(mockPrisma.invoice.updateMany).toHaveBeenCalledTimes(1);
      expect(mockNotifications.invoicePaid).not.toHaveBeenCalled();
      expect(mockWebhooks.dispatch).not.toHaveBeenCalledWith('invoice.paid', expect.anything());
    });
  });

  describe('payment-link reconciliation', () => {
    it('increments stats for the ACTIVE link that was paid', async () => {
      mockPrisma.paymentLink.findUnique.mockResolvedValue({
        id: 'link-1',
        code: 'demo-coffee',
        status: 'ACTIVE',
        totalPayments: 0,
        totalCollected: '0',
      });

      await service.onPaymentSucceeded({
        ...baseTx,
        kind: 'payment_link',
        amount: '5',
        meta: { type: 'PAYMENT_LINK', paymentLinkCode: 'demo-coffee' },
      });

      expect(mockPrisma.paymentLink.findUnique).toHaveBeenCalledWith({
        where: { code: 'demo-coffee' },
      });
      expect(mockPrisma.paymentLink.update).toHaveBeenCalledWith({
        where: { id: 'link-1' },
        data: { totalPayments: { increment: 1 }, totalCollected: '5' },
      });
    });

    it('skips inactive links', async () => {
      mockPrisma.paymentLink.findFirst.mockResolvedValue(null);

      await service.onPaymentSucceeded({
        ...baseTx,
        kind: 'payment_link',
        meta: { type: 'PAYMENT_LINK' },
      });

      expect(mockPrisma.paymentLink.update).not.toHaveBeenCalled();
    });
  });

  describe('scheduled payment advancement (confirmation-gated)', () => {
    const schedule = {
      id: 'sched-1',
      userId: 'user-1',
      interval: 'weekly',
      totalRuns: 1,
      maxRuns: null,
      status: 'ACTIVE',
    };

    it('advances the schedule only when its occurrence transaction is confirmed', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(schedule);

      await service.advanceScheduledPayment({
        id: 'tx-occ-2',
        meta: { scheduledId: 'sched-1', run: 2 },
      });

      expect(mockPrisma.scheduledPayment.findUnique).toHaveBeenCalledWith({
        where: { id: 'sched-1' },
      });
      expect(mockPrisma.scheduledPayment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sched-1', status: 'ACTIVE' },
          data: expect.objectContaining({ totalRuns: 2, status: 'ACTIVE' }),
        }),
      );
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        'user-1',
        'ACCOUNT_ACTIVITY',
        'Scheduled payment confirmed',
        { scheduledId: 'sched-1', transactionId: 'tx-occ-2', run: 2 },
      );
    });

    it('marks the plan COMPLETED when maxRuns is reached and does not schedule further runs', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue({
        ...schedule,
        totalRuns: 2,
        maxRuns: 3,
      });

      await service.advanceScheduledPayment({
        id: 'tx-occ-3',
        meta: { scheduledId: 'sched-1' },
      });

      const call = mockPrisma.scheduledPayment.updateMany.mock.calls[0][0];
      expect(call.data.status).toBe('COMPLETED');
      expect(call.data.nextRunAt).toBeInstanceOf(Date);
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        'user-1',
        'ACCOUNT_ACTIVITY',
        'Scheduled payment plan completed',
        expect.any(Object),
      );
    });

    it('is a no-op for transactions that are not schedule occurrences', async () => {
      await service.advanceScheduledPayment({ id: 'tx-1', meta: { type: 'SEND' } });

      expect(mockPrisma.scheduledPayment.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.scheduledPayment.updateMany).not.toHaveBeenCalled();
    });

    it('never advances a paused/canceled/completed schedule (idempotent guard)', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue({
        ...schedule,
        status: 'COMPLETED',
      });

      await service.advanceScheduledPayment({
        id: 'tx-occ-4',
        meta: { scheduledId: 'sched-1' },
      });

      expect(mockPrisma.scheduledPayment.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.notify).not.toHaveBeenCalled();
    });

    it('fires no side effects when a concurrent reconciler already advanced the schedule', async () => {
      mockPrisma.scheduledPayment.findUnique.mockResolvedValue(schedule);
      mockPrisma.scheduledPayment.updateMany.mockResolvedValue({ count: 0 });

      await service.advanceScheduledPayment({
        id: 'tx-occ-2',
        meta: { scheduledId: 'sched-1' },
      });

      expect(mockPrisma.scheduledPayment.updateMany).toHaveBeenCalledTimes(1);
      expect(mockNotifications.notify).not.toHaveBeenCalled();
    });
  });

  describe('plain payments', () => {
    it('performs no invoice/link lookups and never broadcasts without a merchant owner', async () => {
      await service.onPaymentSucceeded({ ...baseTx, kind: 'payment', meta: { type: 'SEND' } });

      expect(mockPrisma.invoice.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.paymentLink.findFirst).not.toHaveBeenCalled();
      // A payer-initiated send has no merchant webhook consumer: broadcasting
      // payment.received to every subscribed webhook would leak other
      // merchants' transaction data, so nothing is dispatched.
      expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
    });
  });
});
