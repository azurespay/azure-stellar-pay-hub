import { ConfigService } from '@nestjs/config';
import { SorobanSubmissionError } from '@stellar-pay/sdk';
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
  let mockMetrics: { inc: jest.Mock; set: jest.Mock };
  let mockRates: Record<string, jest.Mock>;
  let mockIpfs: Record<string, jest.Mock>;
  let mockWallet: Record<string, jest.Mock>;
  let mockNetwork: {
    buildPaymentTransaction: jest.Mock;
    prepareSorobanSendTransaction: jest.Mock;
    sorobanTokenAddress: jest.Mock;
    submitSignedTransaction: jest.Mock;
    submitSorobanSendTransaction: jest.Mock;
    verifySignedPaymentMatchesIntent: jest.Mock;
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
      // No Settings rows = no gates by default.
      setting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    mockWallet = { assertWalletOwnership: jest.fn().mockResolvedValue(true) };
    mockNotifications = { paymentSent: jest.fn(), paymentFailed: jest.fn() };
    mockWebhooks = { dispatch: jest.fn() };
    mockRealtime = { emitToUser: jest.fn() };
    mockRates = { getRate: jest.fn().mockResolvedValue(1) };
    mockIpfs = { pinReceipt: jest.fn().mockResolvedValue({}), buildReceiptPayload: jest.fn() };
    mockReconciliation = { onPaymentSucceeded: jest.fn(), advanceScheduledPayment: jest.fn() };
    mockMetrics = { inc: jest.fn(), set: jest.fn() };

    mockNetwork = {
      buildPaymentTransaction: jest.fn().mockResolvedValue('classic-xdr'),
      prepareSorobanSendTransaction: jest.fn().mockResolvedValue({
        unsignedXdr: 'soroban-xdr',
        minResourceFee: '100',
        latestLedger: 100,
      }),
      sorobanTokenAddress: jest.fn().mockReturnValue(TOKEN_ADDRESS),
      submitSignedTransaction: jest.fn(),
      submitSorobanSendTransaction: jest.fn(),
      verifySignedPaymentMatchesIntent: jest.fn().mockReturnValue({ matches: true }),
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
      mockMetrics as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create — contract route', () => {
    it('simulates+assembles a Soroban send XDR with a sp: correlation memo and persists kind=contract_send', async () => {
      const result = await service.create('user-1', dto as never);

      expect(mockWallet.assertWalletOwnership).toHaveBeenCalledWith('user-1', 'GPAYER');
      expect(mockNetwork.sorobanTokenAddress).toHaveBeenCalledWith('XLM', null);
      expect(mockNetwork.prepareSorobanSendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'GPAYER',
          to: 'GPAYEE',
          // The invocation must target the DEPLOYED PAYMENT CONTRACT, not the
          // token SAC (regression: `send` on the SAC fails "symbol not found").
          contractId: CONTRACT_ID,
          tokenAddress: TOKEN_ADDRESS,
          amount: '10',
        }),
      );
      const memoArg = mockNetwork.prepareSorobanSendTransaction.mock.calls[0][0].memo;
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

    it('stores the idempotency key + unsigned XDR and replays the original intent', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue(null);

      const first = await service.create('user-1', dto as never, 'create-key-1');

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          idempotencyKey: 'create-key-1',
          kind: 'contract_send',
          meta: expect.objectContaining({ unsignedXdr: 'soroban-xdr' }),
        }),
      });
      expect(first).toEqual(
        expect.objectContaining({ id: 'tx-contract', unsignedXdr: 'soroban-xdr' }),
      );

      // A retried request with the same key returns the original intent and
      // does not create a second payment.
      mockPrisma.transaction.create.mockClear();
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-contract',
        status: 'PENDING',
        kind: 'contract_send',
        meta: { unsignedXdr: 'soroban-xdr' },
      });

      const replay = await service.create('user-1', dto as never, 'create-key-1');

      expect(replay).toEqual(
        expect.objectContaining({
          id: 'tx-contract',
          idempotent: true,
          unsignedXdr: 'soroban-xdr',
        }),
      );
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('returns the winner row when a concurrent create loses the unique-key race', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValueOnce(null); // pre-check
      mockPrisma.transaction.create.mockRejectedValueOnce({ code: 'P2002' });
      mockPrisma.transaction.findFirst.mockResolvedValueOnce({
        id: 'tx-contract',
        status: 'PENDING',
        kind: 'contract_send',
        meta: { unsignedXdr: 'soroban-xdr' },
      }); // refetch in the catch

      const result = await service.create('user-1', dto as never, 'create-key-1');

      expect(result).toEqual(expect.objectContaining({ id: 'tx-contract', idempotent: true }));
    });

    it('falls back to classic XDR when the asset is not in the contract-asset allowlist', async () => {
      const validIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const usdcDto = { ...dto, assetCode: 'USDC', assetIssuer: validIssuer };
      await service.create('user-1', usdcDto as never);

      expect(mockNetwork.buildPaymentTransaction).toHaveBeenCalled();
      expect(mockNetwork.prepareSorobanSendTransaction).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'payment' }),
      });
    });

    it('surfaces an un-allowlisted SAC as a clear 400-class error at create time', async () => {
      const reason = 'Soroban simulation failed: contract reverted (TokenNotAllowed)';
      mockNetwork.prepareSorobanSendTransaction.mockRejectedValueOnce(
        new SorobanSubmissionError(reason),
      );

      await expect(service.create('user-1', dto as never)).rejects.toMatchObject({
        // BadRequestException → HTTP 400, never a 500 for a configuration/
        // on-chain revert at intent-creation time.
        response: expect.objectContaining({ statusCode: 400 }),
      });
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('submit — classic route anti-manipulation gate', () => {
    it('verifies the signed XDR matches the intent before submitting', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-classic',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'payment',
        direction: 'OUTGOING',
        toPublicKey: 'GPAYEE',
        amount: '10',
        assetCode: 'XLM',
        assetIssuer: null,
        memo: null,
        memoType: 'text',
      });
      mockNetwork.submitSignedTransaction.mockResolvedValue({
        status: 'SUCCEEDED',
        hash: '0xhash',
        fee: '100',
      });
      mockPrisma.transaction.update.mockResolvedValue({
        id: 'tx-classic',
        status: 'SUCCEEDED',
        hash: '0xhash',
      });

      await service.submit('user-1', 'tx-classic', 'signed-xdr');

      expect(mockNetwork.verifySignedPaymentMatchesIntent).toHaveBeenCalledWith(
        'signed-xdr',
        expect.objectContaining({
          amount: '10',
          assetCode: 'XLM',
          toPublicKey: 'GPAYEE',
        }),
      );
      expect(mockNetwork.submitSignedTransaction).toHaveBeenCalledWith('signed-xdr');
    });

    it('rejects a tampered XDR before it reaches the network', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-classic',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'payment',
        direction: 'OUTGOING',
        toPublicKey: 'GPAYEE',
        amount: '50',
        assetCode: 'XLM',
        assetIssuer: null,
        memo: null,
        memoType: 'text',
      });
      mockNetwork.verifySignedPaymentMatchesIntent.mockReturnValue({
        matches: false,
        reason: 'amount 1 does not match the expected 50',
      });

      await expect(service.submit('user-1', 'tx-classic', 'tampered-xdr')).rejects.toThrow(
        'Signed transaction does not match the payment intent',
      );
      expect(mockNetwork.submitSignedTransaction).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.update).not.toHaveBeenCalled();
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
      mockNetwork.submitSorobanSendTransaction.mockResolvedValue({
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

    it('rejects a concurrent duplicate submission whose claim lost the race', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-contract',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'contract_send',
      });
      mockPrisma.transaction.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.submit('user-1', 'tx-contract', 'signed-xdr')).rejects.toThrow(
        'Transaction already submitted',
      );
      // The loser never reaches the network.
      expect(mockNetwork.submitSorobanSendTransaction).not.toHaveBeenCalled();
    });

    it('reverts the SUBMITTED claim to PENDING when the transport fails', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-contract',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'contract_send',
        amount: '10',
        assetCode: 'XLM',
      });
      mockNetwork.submitSorobanSendTransaction.mockRejectedValue(new Error('ECONNRESET'));

      await expect(service.submit('user-1', 'tx-contract', 'signed-xdr')).rejects.toThrow(
        'ECONNRESET',
      );

      expect(mockPrisma.transaction.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'tx-contract', status: 'PENDING' },
        data: { status: 'SUBMITTED' },
      });
      expect(mockPrisma.transaction.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'tx-contract', status: 'SUBMITTED' },
        data: { status: 'PENDING' },
      });
      // An infrastructure failure is not a payment failure.
      expect(mockNotifications.paymentFailed).not.toHaveBeenCalled();
    });

    it('notifies on failure like classic payments', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-contract',
        userId: 'user-1',
        status: 'PENDING',
        kind: 'contract_send',
      });
      mockNetwork.submitSorobanSendTransaction.mockResolvedValue({
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
        mockMetrics as any,
      );

      await classicService.create('user-1', dto as never);

      expect(mockNetwork.buildPaymentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'GPAYER', to: 'GPAYEE', amount: '10' }),
      );
      expect(mockNetwork.prepareSorobanSendTransaction).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'payment', status: 'PENDING' }),
      });
    });

    it('builds a text-memo XDR when a memo is sent without memoType (submission parity)', async () => {
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
        mockMetrics as any,
      );
      const memoDto = {
        ...dto,
        memo: 'e2e-test-payment',
        memoType: undefined,
      };

      await classicService.create('user-1', memoDto as never);

      // The unsigned XDR the wallet signs must carry the same memo the submit
      // gate verifies — otherwise every memo'd send is rejected as tampered.
      expect(mockNetwork.buildPaymentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          memo: 'e2e-test-payment',
          memoType: 'text',
        }),
      );
    });
  });

  describe('platform gates (Setting table)', () => {
    it('blocks payment creation during maintenance mode', async () => {
      mockPrisma.setting.findMany.mockResolvedValueOnce([{ key: 'maintenance_mode', value: true }]);
      await expect(service.create('user-1', dto as never)).rejects.toThrow(
        'temporarily paused for maintenance',
      );
      expect(mockNetwork.prepareSorobanSendTransaction).not.toHaveBeenCalled();
    });

    it('rejects amounts below the configured minimum', async () => {
      mockPrisma.setting.findMany.mockResolvedValueOnce([
        { key: 'min_payment_amount', value: '0.5' },
      ]);
      const tinyDto = {
        ...dto,
        destinations: [{ publicKey: 'GPAYEE', amount: '0.1' }],
      };
      await expect(service.create('user-1', tinyDto as never)).rejects.toThrow(
        'Amount must be at least 0.5',
      );
    });

    it('lets equal-or-larger amounts through the minimum gate', async () => {
      mockPrisma.setting.findMany.mockResolvedValueOnce([
        { key: 'min_payment_amount', value: '0.5' },
      ]);
      const bigDto = {
        ...dto,
        destinations: [{ publicKey: 'GPAYEE', amount: '0.5' }],
      };
      await expect(service.create('user-1', bigDto as never)).resolves.toBeDefined();
    });
  });

  describe('approveOccurrence', () => {
    const tx = {
      id: 'tx-occ-1',
      userId: 'user-1',
      status: 'PENDING',
      kind: 'recurring',
      fromPublicKey: 'GPAYER',
      toPublicKey: 'GPAYEE',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      memo: 'invoice-42',
      memoType: 'text',
      meta: { scheduledId: 'sched-1', run: 2 },
    };

    beforeEach(() => {
      mockPrisma.transaction.findFirst.mockResolvedValue(tx);
      mockNetwork.buildPaymentTransaction.mockResolvedValue('approval-xdr');
    });

    it('builds a signable XDR for the owner of a scheduler-created occurrence', async () => {
      const result = await service.approveOccurrence('user-1', 'tx-occ-1');

      expect(mockPrisma.transaction.findFirst).toHaveBeenCalledWith({
        where: { id: 'tx-occ-1', userId: 'user-1' },
      });
      expect(mockNetwork.buildPaymentTransaction).toHaveBeenCalledWith({
        from: 'GPAYER',
        to: 'GPAYEE',
        amount: '10',
        assetCode: 'XLM',
        assetIssuer: null,
        memo: 'invoice-42',
        memoType: 'text',
      });
      expect(result).toEqual(
        expect.objectContaining({ id: 'tx-occ-1', unsignedXdr: 'approval-xdr' }),
      );
    });

    it('rejects other users (owner-scoped, no oracle)', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue(null);
      await expect(service.approveOccurrence('attacker', 'tx-occ-1')).rejects.toThrow(
        'Transaction not found',
      );
      expect(mockNetwork.buildPaymentTransaction).not.toHaveBeenCalled();
    });

    it('refuses non-occurrence kinds and non-PENDING rows', async () => {
      mockPrisma.transaction.findFirst.mockResolvedValue({ ...tx, kind: 'payment' });
      await expect(service.approveOccurrence('user-1', 'tx-occ-1')).rejects.toThrow(
        'Not an approvable scheduled payment',
      );

      mockPrisma.transaction.findFirst.mockResolvedValue({ ...tx, status: 'SUBMITTED' });
      await expect(service.approveOccurrence('user-1', 'tx-occ-1')).rejects.toThrow(
        'Payment is not awaiting approval',
      );
      expect(mockNetwork.buildPaymentTransaction).not.toHaveBeenCalled();
    });
  });
});
