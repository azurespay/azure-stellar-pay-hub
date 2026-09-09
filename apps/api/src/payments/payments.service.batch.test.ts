import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { createStellarNetwork } from '../infra/stellar';

jest.mock('../infra/stellar', () => ({
  createStellarNetwork: jest.fn(),
}));

const mockedCreateNetwork = createStellarNetwork as jest.MockedFunction<
  typeof createStellarNetwork
>;

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

// Valid testnet G… strkeys required by TransactionBuilder/Operation.payment.
const PAYER = 'GBQKUGN6QES76KYEOLT7BBA2Q2IBHEMCNFJAM6KIAM7PMABIIN5QDIKD';

function keyedConfig(map: Record<string, unknown>) {
  return { get: jest.fn((key: string) => map[key]) } as unknown as ConfigService;
}

/** A minimal Horizon Account stub usable by TransactionBuilder. */
function accountStub(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '123456789',
    incrementSequenceNumber: () => {},
  };
}

describe('PaymentsService — batch & split (multi-recipient XDR)', () => {
  let service: PaymentsService;
  let mockPrisma: Record<string, any>;
  let mockNetwork: {
    server: { loadAccount: jest.Mock };
    buildPaymentTransaction: jest.Mock;
    prepareSorobanSendTransaction: jest.Mock;
    config: { networkPassphrase: string };
  };

  beforeEach(() => {
    mockPrisma = {
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'tx-batch', ...data })),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      setting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    mockNetwork = {
      server: { loadAccount: jest.fn().mockResolvedValue(accountStub(PAYER)) },
      buildPaymentTransaction: jest.fn(),
      prepareSorobanSendTransaction: jest.fn(),
      config: { networkPassphrase: NETWORK_PASSPHRASE },
    };
    mockedCreateNetwork.mockReturnValue(mockNetwork as never);

    service = new PaymentsService(
      mockPrisma as any,
      keyedConfig({ STELLAR_NETWORK: 'testnet' }),
      { assertWalletOwnership: jest.fn().mockResolvedValue(true) } as any,
      {} as any,
      {} as any,
      {} as any,
      { getRate: jest.fn().mockResolvedValue(1) } as any,
      {} as any,
      { onPaymentSucceeded: jest.fn(), advanceScheduledPayment: jest.fn() } as any,
      { inc: jest.fn(), set: jest.fn() } as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Valid testnet G… strkeys required by Operation.payment.
  const DEST_A = 'GDFJJJVSGVLKSUNTPJ44UPWMQXJGRVGIMI2CK6VAS2XBCZCUIULE7FEW';
  const DEST_B = 'GBFMKLOKEHSPPR5XIPGWWCAKQXGC6X4PTT3RUBPFRGWQ54MGNZV55OBO';
  const DEST_C = 'GDEBEEKJE2LFKHMZYG7UCJWLKKESBRNFOR44SCLXBTNWDM46W5VNEFTW';

  async function decodePaymentOps(xdr: string) {
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    return tx.operations;
  }

  it('builds one payment op per recipient with the exact amounts (BATCH)', async () => {
    const dto = {
      type: 'BATCH',
      fromPublicKey: PAYER,
      destinations: [
        { publicKey: DEST_A, amount: '1' },
        { publicKey: DEST_B, amount: '2' },
        { publicKey: DEST_C, amount: '3' },
      ],
      assetCode: 'XLM',
      assetIssuer: null,
      memo: 'payroll',
      memoType: 'text',
    };

    const result = await service.create('user-1', dto as never);

    expect(mockNetwork.buildPaymentTransaction).not.toHaveBeenCalled();
    expect(mockNetwork.prepareSorobanSendTransaction).not.toHaveBeenCalled();
    expect(result.unsignedXdr).toBeDefined();
    const ops = await decodePaymentOps(result.unsignedXdr as string);
    expect(ops).toHaveLength(3);
    for (const [i, op] of ops.entries()) {
      expect(op.type).toBe('payment');
      expect((op as any).destination).toBe(dto.destinations[i].publicKey);
      // Stellar normalizes decimal amounts to 7 places ("1" → "1.0000000").
      expect((op as any).amount).toBe(`${dto.destinations[i].amount}.0000000`);
    }
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'batch',
        amount: '6', // sum of all recipients
        toPublicKey: null, // multi-recipient intents have no single destination
        status: 'PENDING',
        direction: 'OUTGOING',
        meta: expect.objectContaining({ type: 'BATCH', destinations: dto.destinations }),
      }),
    });
    expect(result).toEqual(expect.objectContaining({ kind: 'pending', id: 'tx-batch' }));
  });

  it('uses the classic Operation.payment path for SPLIT too', async () => {
    const dto = {
      type: 'SPLIT',
      fromPublicKey: PAYER,
      destinations: [
        { publicKey: DEST_A, amount: '5' },
        { publicKey: DEST_B, amount: '5' },
      ],
      assetCode: 'XLM',
      assetIssuer: null,
    };

    const result = await service.create('user-1', dto as never);

    expect(result.unsignedXdr).toBeDefined();
    const ops = await decodePaymentOps(result.unsignedXdr as string);
    expect(ops).toHaveLength(2);
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'split', amount: '10' }),
    });
  });

  it('never routes a batch through the Soroban contract route', async () => {
    // Even with PAYMENT_ROUTE=contract and XLM allowlisted, batches must stay
    // on the classic path (the contract's send_batch is not wired to the API).
    const contractService = new PaymentsService(
      mockPrisma as any,
      keyedConfig({
        STELLAR_NETWORK: 'testnet',
        PAYMENT_ROUTE: 'contract',
        CONTRACT_STELLAR_PAY_PAYMENT: 'CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA',
        PAYMENT_CONTRACT_ASSETS: ['XLM'],
      }),
      { assertWalletOwnership: jest.fn().mockResolvedValue(true) } as any,
      {} as any,
      {} as any,
      {} as any,
      { getRate: jest.fn().mockResolvedValue(1) } as any,
      {} as any,
      { onPaymentSucceeded: jest.fn(), advanceScheduledPayment: jest.fn() } as any,
      { inc: jest.fn(), set: jest.fn() } as any,
    );

    const dto = {
      type: 'BATCH',
      fromPublicKey: PAYER,
      destinations: [
        { publicKey: DEST_A, amount: '1' },
        { publicKey: DEST_B, amount: '2' },
      ],
      assetCode: 'XLM',
      assetIssuer: null,
    };
    await contractService.create('user-1', dto as never);

    expect(mockNetwork.prepareSorobanSendTransaction).not.toHaveBeenCalled();
    expect(mockNetwork.buildPaymentTransaction).not.toHaveBeenCalled();
    expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'batch' }),
    });
  });

  it('loads the source account from Horizon when building the batch XDR', async () => {
    const dto = {
      type: 'BATCH',
      fromPublicKey: PAYER,
      destinations: [{ publicKey: DEST_A, amount: '1' }],
      assetCode: 'XLM',
      assetIssuer: null,
    };
    await service.create('user-1', dto as never);
    expect(mockNetwork.server.loadAccount).toHaveBeenCalledWith(PAYER);
  });
});
