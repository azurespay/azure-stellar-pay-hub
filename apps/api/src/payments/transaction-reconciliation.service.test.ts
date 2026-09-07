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
    };
    mockNotifications = { invoicePaid: jest.fn() };
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
