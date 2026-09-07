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
      transaction: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
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
