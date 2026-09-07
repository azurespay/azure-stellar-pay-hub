import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { createStellarNetwork } from '../infra/stellar';

jest.mock('../infra/stellar', () => ({
  createStellarNetwork: jest.fn(),
}));

const mockedCreateNetwork = createStellarNetwork as jest.MockedFunction<
  typeof createStellarNetwork
>;

function keyedConfig(map: Record<string, unknown>) {
  return { get: jest.fn((key: string) => map[key]) } as unknown as ConfigService;
}

describe('PaymentsService — Soroban contract route (PAYMENT_ROUTE=contract)', () => {
  let service: PaymentsService;
  let mockPrisma: Record<string, any>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockReconciliation: Record<string, jest.Mock>;
  let mockRates: Record<string, jest.Mock>;
  let mockIpfs: Record<string, jest.Mock>;
  let mockWallet: Record<string, jest.Mock>;
  let mockNetwork: {
    buildPaymentTransaction: jest.Mock;
    buildSorobanSendTransaction: jest.Mock;
    sorobanTokenAddress: jest.Mock;
    submitSignedTransaction: jest.Mock;
  };

  const CONTRACT_ID = 'CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA';
  const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  const contractConfig = keyedConfig({
    STELLAR_NETWORK: 'testnet',
    PAYMENT_ROUTE: 'contract',
    CONTRACT_STELLAR_PAY_PAYMENT: CONTRACT_ID,
    PAYMENT_CONTRACT_ASSETS: ['XLM'],
  });

  const dto = {
    type: 'SEND',
    fromPublicKey: 'GPAYER',
    destinations: [{ publicKey: 'GPAYEE', amount: '10' }],
    assetCode: 'XLM',
    assetIssuer: null,
    memo: undefined,
    memoType: undefined,
  };

  beforeEach(() => {
    mockPrisma = {
      transaction: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'tx-contract' }),
        update: jest.fn().mockResolvedValue({ id: 'tx-contract', status: 'SUBMITTED' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(true) };
    mockNotifications = { paymentSent: jest.fn(), paymentFailed: jest.fn() };
    mockWebhooks = { dispatch: jest.fn() };
    mockRealtime = { emitToUser: jest.fn() };
    mockRates = { getRate: jest.fn().mockResolvedValue(1) };
    mockIpfs = { pinReceipt: jest.fn().mockResolvedValue({}), buildReceiptPayload: jest.fn() };
    mockReconciliation = { onPaymentSucceeded: jest.fn() };

    mockNetwork = {
      buildPaymentTransaction: jest.fn().mockResolvedValue('classic-xdr'),
      buildSorobanSendTransaction: jest.fn().mockResolvedValue('soroban-xdr'),
      sorobanTokenAddress: jest.fn().mockReturnValue(TOKEN_ADDRESS),
      submitSignedTransaction: jest.fn(),
    };
    mockedCreateNetwork.mockReturnValue(mockNetwork as never);

    service = new PaymentsService(
      mockPrisma as any,
      contractConfig,
      mockWallet as any,
      mockNotifications as any,
      mockWebhooks as any,
      mockRealtime as any,
      mockRates as any,
      mockIpfs as any,
      mockReconciliation as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create — contract route', () => {
    it('builds a Soroban send XDR with a sp: correlation memo and persists kind=contract_send', async () => {
      const result = await service.create('user-1', dto as never);

      expect(mockWallet.assertWalletOwnership).toHaveBeenCalledWith('user-1', 'GPAYER');
      expect(mockNetwork.sorobanTokenAddress).toHaveBeenCalledWith('XLM', null);
      expect(mockNetwork.buildSorobanSendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'GPAYER',
          to: 'GPAYEE',
          tokenAddress: TOKEN_ADDRESS,
          amount: '10',
        }),
      );
      const memoArg = mockNetwork.buildSorobanSendTransaction.mock.calls[0][0].memo;
      expect(memoArg).toMatch(/^sp:/);
      expect(mockNetwork.buildPaymentTransaction).not.toHaveBeenCalled();

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'contract_send',
          status: 'PENDING',
          meta: expect.objectContaining({
            route: 'contract',
            contractId: CONTRACT_ID,
            tokenAddress: TOKEN_ADDRESS,
            correlationId: expect.any(String),
          }),
        }),
      });
      expect(result).toEqual(
        expect.objectContaining({ kind: 'pending', id: 'tx-contract', unsignedXdr: 'soroban-xdr' }),
      );
    });

    it('falls back to classic XDR when the asset is not in the contract-asset allowlist', async () => {
      const validIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const usdcDto = { ...dto, assetCode: 'USDC', assetIssuer: validIssuer };
      await service.create('user-1', usdcDto as never);

      expect(mockNetwork.buildPaymentTransaction).toHaveBeenCalled();
      expect(mockNetwork.buildSorobanSendTransaction).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'payment' }),
      });
    });
  });

  describe('submit — contract route', () => {
    it('persists SUBMITTED (not SUCCEEDED) and skips payer success events', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-contract',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'contract_send',
        amount: '10',
        assetCode: 'XLM',
      });
      mockNetwork.submitSignedTransaction.mockResolvedValue({
        status: 'SUCCEEDED',
        hash: '0xhash',
        fee: '100',
        sequence: '1',
        ledger: 1,
      });
      mockPrisma.transaction.update.mockResolvedValue({
        id: 'tx-contract',
        status: 'SUBMITTED',
        hash: '0xhash',
      });

      const updated = await service.submit('user-1', 'tx-contract', 'signed-xdr');

      expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-contract' },
        data: { hash: '0xhash', status: 'SUBMITTED', fee: '100', errorMessage: undefined },
      });
      expect(updated.status).toBe('SUBMITTED');
      // No notifications/realtime/webhooks until the on-chain event is indexed.
      expect(mockReconciliation.onPaymentSucceeded).not.toHaveBeenCalled();
      expect(mockNotifications.paymentSent).not.toHaveBeenCalled();
      expect(mockRealtime.emitToUser).not.toHaveBeenCalled();
    });

    it('notifies on failure like classic payments', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-contract',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'contract_send',
      });
      mockNetwork.submitSignedTransaction.mockResolvedValue({
        status: 'FAILED',
        hash: null,
        fee: '100',
        errorMessage: 'op rejected',
      });

      await service.submit('user-1', 'tx-contract', 'signed-xdr');

      expect(mockNotifications.paymentFailed).toHaveBeenCalled();
    });
  });

  describe('classic route stays the default', () => {
    it('routes through Operation.payment when PAYMENT_ROUTE is unset', async () => {
      const classicService = new PaymentsService(
        mockPrisma as any,
        keyedConfig({ STELLAR_NETWORK: 'testnet' }),
        mockWallet as any,
        mockNotifications as any,
        mockWebhooks as any,
        mockRealtime as any,
        mockRates as any,
        mockIpfs as any,
        mockReconciliation as any,
      );

      await classicService.create('user-1', dto as never);

      expect(mockNetwork.buildPaymentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'GPAYER', to: 'GPAYEE', amount: '10' }),
      );
      expect(mockNetwork.buildSorobanSendTransaction).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'payment', status: 'PENDING' }),
      });
    });
  });
});
