import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { CheckoutService } from './checkout.service';
import { createStellarNetwork } from '../infra/stellar';

jest.mock('../infra/stellar', () => ({
  createStellarNetwork: jest.fn(),
}));

const mockedCreateNetwork = createStellarNetwork as jest.MockedFunction<
  typeof createStellarNetwork
>;

describe('CheckoutService', () => {
  let service: CheckoutService;
  let mockPrisma: Record<string, any>;
  let mockConfig: Record<string, jest.Mock>;
  let mockReconciliation: Record<string, jest.Mock>;
  let networkMock: {
    submitSignedTransaction: jest.Mock;
    verifySignedPaymentMatchesIntent: jest.Mock;
    buildPaymentTransaction: jest.Mock;
  };
  let submitMock: jest.Mock;

  const PAYER = Keypair.random().publicKey();
  const MERCHANT = Keypair.random().publicKey();

  const pendingTx = {
    id: 'tx-1',
    userId: null,
    fromPublicKey: PAYER,
    toPublicKey: MERCHANT,
    amount: '14.5',
    assetCode: 'USDC',
    kind: 'invoice',
    status: 'PENDING',
    memoType: 'text',
    meta: { type: 'INVOICE', invoiceNumber: 'INV-2026-ABC123' },
  };

  beforeEach(() => {
    mockConfig = {
      get: jest.fn((key: string) => (key === 'STELLAR_NETWORK' ? 'testnet' : undefined)),
    };
    mockPrisma = {
      transaction: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'tx-checkout', status: 'PENDING' }),
      },
      paymentLink: { findUnique: jest.fn() },
      invoice: { findUnique: jest.fn() },
    };
    mockReconciliation = { onPaymentSucceeded: jest.fn() };
    submitMock = jest.fn();
    networkMock = {
      submitSignedTransaction: submitMock,
      verifySignedPaymentMatchesIntent: jest.fn().mockReturnValue({ matches: true }),
      buildPaymentTransaction: jest.fn().mockResolvedValue('checkout-xdr'),
    };
    mockedCreateNetwork.mockReturnValue(networkMock as never);

    service = new CheckoutService(
      mockPrisma as any,
      mockConfig as unknown as ConfigService,
      mockReconciliation as any,
    );
  });

  it('throws NotFoundException when the transaction does not exist', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    await expect(service.submitSigned('missing', 'xdr')).rejects.toThrow('Transaction not found');
  });

  it('rejects a signed XDR that does not match the recorded intent', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(pendingTx);
    // Simulate a tampered XDR (e.g. $1 signed for a $50 intent).
    networkMock.verifySignedPaymentMatchesIntent.mockReturnValue({
      matches: false,
      reason: 'amount 1 does not match the expected 50',
    });

    await expect(service.submitSigned('tx-1', 'tampered-xdr')).rejects.toThrow(
      'Signed transaction does not match the payment intent',
    );
    expect(networkMock.verifySignedPaymentMatchesIntent).toHaveBeenCalledWith(
      'tampered-xdr',
      expect.objectContaining({ amount: '14.5', toPublicKey: MERCHANT, assetCode: 'USDC' }),
    );
    expect(mockPrisma.transaction.updateMany).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
  });

  it('claims the intent PENDING → SUBMITTED before submitting', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(pendingTx);
    submitMock.mockResolvedValue({
      status: 'FAILED',
      hash: null,
      fee: '100',
      errorMessage: 'op rejected',
    });
    mockPrisma.transaction.update.mockResolvedValue({
      ...pendingTx,
      status: 'FAILED',
      errorMessage: 'op rejected',
    });

    await service.submitSigned('tx-1', 'signed-xdr');

    expect(mockPrisma.transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx-1', status: 'PENDING' },
      data: { status: 'SUBMITTED' },
    });
  });

  it('rejects a second submit whose atomic claim lost the race', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(pendingTx);
    mockPrisma.transaction.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.submitSigned('tx-1', 'signed-xdr')).rejects.toThrow(
      'Transaction already submitted',
    );
    expect(submitMock).not.toHaveBeenCalled();
  });

  describe('payPaymentLink — server-authoritative amounts and expiry', () => {
    const activeLink = {
      code: 'link1',
      title: 'Coffee',
      description: null,
      amount: '50',
      assetCode: 'XLM',
      assetIssuer: null,
      fixedAmount: true,
      expiresAt: null,
      status: 'ACTIVE',
      totalPayments: 0,
      merchant: {
        name: 'Demo',
        slug: 'demo',
        logoUrl: null,
        settlementPublicKey: MERCHANT,
      },
    };

    beforeEach(() => {
      mockPrisma.paymentLink.findUnique.mockResolvedValue(activeLink);
    });

    it('ignores a customer-supplied amount on a fixed-amount link', async () => {
      await service.payPaymentLink('link1', PAYER, '1');

      expect(networkMock.buildPaymentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: MERCHANT, amount: '50' }),
      );
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: '50', kind: 'payment_link' }),
      });
    });

    it('uses the link amount when none is supplied', async () => {
      await service.payPaymentLink('link1', PAYER);
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: '50' }),
      });
    });

    it('allows a customer amount on an open (non-fixed) link', async () => {
      mockPrisma.paymentLink.findUnique.mockResolvedValue({
        ...activeLink,
        amount: null,
        fixedAmount: false,
      });

      await service.payPaymentLink('link1', PAYER, '7.5');

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: '7.5' }),
      });
    });

    it('refuses an expired link', async () => {
      mockPrisma.paymentLink.findUnique.mockResolvedValue({
        ...activeLink,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service.payPaymentLink('link1', PAYER)).rejects.toThrow(
        'Payment link has expired',
      );
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('payInvoice — open-invoice-only enforcement', () => {
    beforeEach(() => {
      mockPrisma.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        number: 'INV-1',
        merchantId: 'merchant-1',
        merchant: { name: 'Demo', settlementPublicKey: MERCHANT },
        title: 'Invoice',
        description: null,
        items: [],
        amount: '10',
        assetCode: 'XLM',
        assetIssuer: null,
        status: 'ISSUED',
      });
    });

    it('refuses a CANCELED invoice', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue({
        id: 'inv-1',
        number: 'INV-1',
        merchantId: 'merchant-1',
        merchant: { name: 'Demo', settlementPublicKey: MERCHANT },
        title: 'Invoice',
        description: null,
        items: [],
        amount: '10',
        assetCode: 'XLM',
        assetIssuer: null,
        status: 'CANCELED',
      });

      await expect(service.payInvoice('INV-1', PAYER)).rejects.toThrow(/cannot be paid/);
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  it('reverts the claim to PENDING when the network transport fails', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(pendingTx);
    submitMock.mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.submitSigned('tx-1', 'signed-xdr')).rejects.toThrow('ECONNRESET');

    expect(mockPrisma.transaction.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'tx-1', status: 'PENDING' },
      data: { status: 'SUBMITTED' },
    });
    expect(mockPrisma.transaction.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'tx-1', status: 'SUBMITTED' },
      data: { status: 'PENDING' },
    });
    expect(mockPrisma.transaction.update).not.toHaveBeenCalled();
    expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
  });

  it('persists a SUCCEEDED submission and reconciles invoices/payment links', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(pendingTx);
    submitMock.mockResolvedValue({
      status: 'SUCCEEDED',
      hash: 'deadbeef',
      fee: '100',
      errorMessage: null,
    });
    const succeededTx = { ...pendingTx, status: 'SUCCEEDED', hash: 'deadbeef' };
    mockPrisma.transaction.update.mockResolvedValue(succeededTx);

    const result = await service.submitSigned('tx-1', 'signed-xdr');

    expect(result).toEqual({ status: 'SUCCEEDED', hash: 'deadbeef', errorMessage: null });
    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: {
        hash: 'deadbeef',
        status: 'SUCCEEDED',
        fee: '100',
        errorMessage: null,
      },
    });
    // The merchant-side bookkeeping runs for checkout success, exactly like
    // the authenticated `/payments/:id/submit` path.
    expect(mockReconciliation.onPaymentSucceeded).toHaveBeenCalledTimes(1);
    expect(mockReconciliation.onPaymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tx-1', status: 'SUCCEEDED', hash: 'deadbeef' }),
    );
  });

  it('does not reconcile when the network rejects the transaction', async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(pendingTx);
    submitMock.mockResolvedValue({
      status: 'FAILED',
      hash: null,
      fee: '100',
      errorMessage: 'Transaction rejected',
    });
    const failedTx = { ...pendingTx, status: 'FAILED', errorMessage: 'Transaction rejected' };
    mockPrisma.transaction.update.mockResolvedValue(failedTx);

    const result = await service.submitSigned('tx-1', 'bad-signed-xdr');

    expect(result).toEqual({
      status: 'FAILED',
      hash: null,
      errorMessage: 'Transaction rejected',
    });
    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: {
        hash: null,
        status: 'FAILED',
        fee: '100',
        errorMessage: 'Transaction rejected',
      },
    });
    expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
  });
});
