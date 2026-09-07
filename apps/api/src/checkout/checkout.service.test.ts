import { ConfigService } from '@nestjs/config';
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
  let submitMock: jest.Mock;

  const pendingTx = {
    id: 'tx-1',
    userId: null,
    fromPublicKey: 'GPAYER',
    toPublicKey: 'GMERCHANT',
    amount: '14.5',
    assetCode: 'USDC',
    kind: 'invoice',
    status: 'PENDING',
    meta: { type: 'INVOICE', invoiceNumber: 'INV-2026-ABC123' },
  };

  beforeEach(() => {
    mockConfig = {
      get: jest.fn((key: string) => (key === 'STELLAR_NETWORK' ? 'testnet' : undefined)),
    };
    mockPrisma = {
      transaction: { findUnique: jest.fn(), update: jest.fn() },
    };
    mockReconciliation = { onPaymentSucceeded: jest.fn() };
    submitMock = jest.fn();
    mockedCreateNetwork.mockReturnValue({ submitSignedTransaction: submitMock } as never);

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
