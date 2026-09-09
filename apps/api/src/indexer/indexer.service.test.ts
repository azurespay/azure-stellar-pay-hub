import { ConfigService } from '@nestjs/config';
import { Asset, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { IndexerService, extractCorrelationMemo } from './indexer.service';

const RPC_URL = 'https://soroban-testnet.example.com/rpc';
const CONTRACT_ID = 'CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA';

function keyedConfig(map: Record<string, unknown>) {
  return { get: jest.fn((key: string) => map[key]) } as unknown as ConfigService;
}

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload };
}

function scvStringValue(text: string): string {
  // Contract event values are XDR base64 of an ScVal; a #[contracttype]
  // struct serializes to a vec/map, so nest the memo inside one to exercise
  // the recursive scan.
  const scVal = xdr.ScVal.scvVec([xdr.ScVal.scvString('GAAA'), xdr.ScVal.scvString(text)]);
  return scVal.toXDR('base64').toString();
}

describe('IndexerService', () => {
  let service: IndexerService;
  let mockPrisma: Record<string, any>;
  let mockRedis: Record<string, jest.Mock>;
  let mockNotifications: Record<string, jest.Mock>;
  let mockWebhooks: Record<string, jest.Mock>;
  let mockRealtime: Record<string, jest.Mock>;
  let mockInbound: Record<string, jest.Mock>;
  let mockMetrics: { inc: jest.Mock; set: jest.Mock };
  let mockReconciliation: Record<string, jest.Mock>;
  let fetchMock: jest.Mock;

  const submittedTx = {
    id: 'tx-contract-1',
    userId: 'user-1',
    hash: 'hash-abc',
    amount: '10',
    assetCode: 'XLM',
    toPublicKey: 'GPAYEE',
    fromPublicKey: 'GPAYER',
    kind: 'contract_send',
    status: 'SUBMITTED',
    meta: { route: 'contract', correlationId: 'corr-1' },
  };

  beforeEach(() => {
    mockPrisma = {
      transaction: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    mockNotifications = { paymentSent: jest.fn().mockResolvedValue(undefined) };
    mockWebhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
    mockRealtime = { emitToUser: jest.fn() };
    mockInbound = { handle: jest.fn().mockResolvedValue({ created: false }) };
    mockMetrics = { inc: jest.fn(), set: jest.fn() };
    mockReconciliation = { advanceScheduledPayment: jest.fn().mockResolvedValue(undefined) };

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new IndexerService(
      mockPrisma as any,
      keyedConfig({
        SOROBAN_RPC_URL: RPC_URL,
        CONTRACT_STELLAR_PAY_PAYMENT: CONTRACT_ID,
      }),
      mockRedis as any,
      mockNotifications as any,
      mockRealtime as any,
      mockInbound as any,
      mockMetrics as any,
      mockReconciliation as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('enabled gating', () => {
    it('stays idle (no RPC calls) when contract/RPC are unset', async () => {
      const idle = new IndexerService(
        mockPrisma as any,
        keyedConfig({}),
        mockRedis as any,
        mockNotifications as any,
        mockRealtime as any,
        mockInbound as any,
        mockMetrics as any,
        mockReconciliation as any,
      );
      await idle.syncOnce();
      await idle.syncOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getTransaction confirmation (primary signal)', () => {
    it('confirms a SUBMITTED contract send exactly once when the ledger reports SUCCESS', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([submittedTx]);
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (body.method === 'getTransaction') {
          return jsonResponse({ result: { status: 'SUCCESS', ledger: 4068001 } });
        }
        return jsonResponse({ result: { events: [], cursor: 'c-1' } });
      });

      await service.syncOnce();

      expect(mockPrisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-contract-1', status: 'SUBMITTED' },
        data: { status: 'CONFIRMED' },
      });
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('user-1', 'transaction.updated', {
        id: 'tx-contract-1',
        status: 'CONFIRMED',
      });
      expect(mockNotifications.paymentSent).toHaveBeenCalledWith({
        userId: 'user-1',
        amount: '10',
        assetCode: 'XLM',
        toPublicKey: 'GPAYEE',
      });
      // The schedule (if this tx belongs to one) advances only on the winning
      // on-chain CONFIRMED transition.
      expect(mockReconciliation.advanceScheduledPayment).toHaveBeenCalledWith(submittedTx);
      // No webhook broadcast on a payer-initiated contract send: it has no
      // merchant owner, so fan-out would leak other merchants' data.
      expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
    });

    it('is idempotent: a lost updateMany race (count 0) fires no side effects twice', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([submittedTx]);
      mockPrisma.transaction.updateMany.mockResolvedValue({ count: 0 });
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (body.method === 'getTransaction') {
          return jsonResponse({ result: { status: 'SUCCESS' } });
        }
        return jsonResponse({ result: { events: [], cursor: 'c-1' } });
      });

      await service.syncOnce();

      expect(mockPrisma.transaction.updateMany).toHaveBeenCalledTimes(1);
      expect(mockRealtime.emitToUser).not.toHaveBeenCalled();
      expect(mockNotifications.paymentSent).not.toHaveBeenCalled();
      expect(mockWebhooks.dispatch).not.toHaveBeenCalled();
      // No advance on a lost race either: side effects fire only on the winner.
      expect(mockReconciliation.advanceScheduledPayment).not.toHaveBeenCalled();
    });

    it('does not confirm when the ledger does not report SUCCESS', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([submittedTx]);
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (body.method === 'getTransaction') {
          return jsonResponse({ result: { status: 'NOT_FOUND' } });
        }
        return jsonResponse({ result: { events: [], cursor: 'c-1' } });
      });

      await service.syncOnce();

      expect(mockPrisma.transaction.updateMany).not.toHaveBeenCalled();
      expect(mockRealtime.emitToUser).not.toHaveBeenCalled();
    });

    it('skips rows without a hash and tolerates RPC errors per row', async () => {
      const noHash = { ...submittedTx, hash: null };
      mockPrisma.transaction.findMany.mockResolvedValue([noHash]);
      fetchMock.mockRejectedValue(new Error('rpc down'));

      await service.syncOnce(); // must not throw

      expect(mockPrisma.transaction.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getEvents ingestion (best-effort correlation)', () => {
    it('confirms a SUBMITTED row when an ingested payment event carries its sp: memo', async () => {
      // No SUBMITTED rows to poll by hash — confirmation must come from events.
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transaction.findFirst.mockResolvedValue(submittedTx);

      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (body.method === 'getLatestLedger') {
          return jsonResponse({ result: { sequence: 4068001 } });
        }
        if (body.method === 'getEvents') {
          return jsonResponse({
            result: {
              events: [
                {
                  id: '00040680010000000001',
                  type: 'contract',
                  contractId: CONTRACT_ID,
                  topic: ['payment'],
                  value: scvStringValue('sp:corr-1'),
                },
              ],
              cursor: '00040680010000000001',
              latestLedger: 4068001,
            },
          });
        }
        return jsonResponse({ result: null });
      });

      await service.syncOnce();

      expect(mockPrisma.transaction.findFirst).toHaveBeenCalledWith({
        where: { meta: { path: ['correlationId'], equals: 'corr-1' } },
      });
      expect(mockPrisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'tx-contract-1', status: 'SUBMITTED' },
        data: { status: 'CONFIRMED' },
      });
      // Cursor persisted so the next poll resumes exactly here.
      expect(mockRedis.set).toHaveBeenCalledWith('indexer:soroban:cursor', '00040680010000000001');
    });

    it('ignores events without a platform sp: memo', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (body.method === 'getLatestLedger') {
          return jsonResponse({ result: { sequence: 4068001 } });
        }
        if (body.method === 'getEvents') {
          return jsonResponse({
            result: {
              events: [
                {
                  id: 'evt-2',
                  type: 'contract',
                  contractId: CONTRACT_ID,
                  value: scvStringValue('external-wallet-memo'),
                },
              ],
              cursor: 'evt-2',
            },
          });
        }
        return jsonResponse({ result: null });
      });

      await service.syncOnce();

      expect(mockPrisma.transaction.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('inbound payment events (not initiated through the API)', () => {
    const NATIVE_SAC = Asset.native().contractId(Networks.TESTNET);

    function accountScVal(publicKey: string): xdr.ScVal {
      return xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeAccount(
          xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(publicKey)),
        ),
      );
    }

    function contractScVal(contractId: string): xdr.ScVal {
      return xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeContract(
          // v14 typings type the arm as Hash while decodeContract returns Buffer.
          StrKey.decodeContract(contractId) as unknown as xdr.Hash,
        ),
      );
    }

    function paymentValue(opts: {
      from: string;
      to: string;
      token: string;
      stroops: bigint;
      memo?: string;
    }): string {
      const scVal = xdr.ScVal.scvVec([
        accountScVal(opts.from),
        accountScVal(opts.to),
        contractScVal(opts.token),
        xdr.ScVal.scvI128(
          new xdr.Int128Parts({ lo: opts.stroops, hi: 0n } as unknown as ConstructorParameters<
            typeof xdr.Int128Parts
          >[0]),
        ),
        xdr.ScVal.scvString(opts.memo ?? ''),
      ]);
      return scVal.toXDR('base64').toString();
    }

    function paymentTopic(): string[] {
      return [xdr.ScVal.scvSymbol('payment').toXDR('base64').toString()];
    }

    function withIngestedEvents(events: Array<Record<string, unknown>>) {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        if (body.method === 'getLatestLedger') {
          return jsonResponse({ result: { sequence: 4068001 } });
        }
        if (body.method === 'getEvents') {
          return jsonResponse({ result: { events, cursor: 'c-final' } });
        }
        return jsonResponse({ result: null });
      });
    }

    it('delegates an XLM merchant payment event to inbound reconciliation (stroops → units)', async () => {
      const payer = Keypair.random();
      const merchant = Keypair.random();
      withIngestedEvents([
        {
          id: 'evt-inbound-1',
          type: 'contract',
          contractId: CONTRACT_ID,
          txHash: 'a'.repeat(64),
          ledger: 4068001,
          topic: paymentTopic(),
          value: paymentValue({
            from: payer.publicKey(),
            to: merchant.publicKey(),
            token: NATIVE_SAC,
            stroops: 100_000_000n, // 10 XLM
            memo: '',
          }),
        },
      ]);

      await service.syncOnce();

      expect(mockInbound.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt-inbound-1',
          source: 'soroban',
          fromPublicKey: payer.publicKey(),
          toPublicKey: merchant.publicKey(),
          amount: '10',
          assetCode: 'XLM',
          assetIssuer: null,
          hash: 'a'.repeat(64),
          memo: null,
          contractId: CONTRACT_ID,
          ledger: 4068001,
        }),
      );
    });

    it('does not delegate events for unsupported (non-native) tokens', async () => {
      const other = Keypair.random();
      const merchant = Keypair.random();
      const otherSac = StrKey.encodeContract(Buffer.alloc(32, 9));
      withIngestedEvents([
        {
          id: 'evt-inbound-2',
          type: 'contract',
          contractId: CONTRACT_ID,
          topic: paymentTopic(),
          value: paymentValue({
            from: other.publicKey(),
            to: merchant.publicKey(),
            token: otherSac,
            stroops: 50_000_000n,
          }),
        },
      ]);

      await service.syncOnce();

      expect(mockInbound.handle).not.toHaveBeenCalled();
    });

    it('never treats a platform send as inbound when its row exists', async () => {
      const payer = Keypair.random();
      const merchant = Keypair.random();
      // The correlation branch finds the platform row and returns early.
      mockPrisma.transaction.findFirst.mockResolvedValue({
        id: 'tx-platform',
        kind: 'contract_send',
        status: 'CONFIRMED',
        userId: 'user-1',
        amount: '10',
        assetCode: 'XLM',
        toPublicKey: merchant.publicKey(),
      });
      withIngestedEvents([
        {
          id: 'evt-inbound-3',
          type: 'contract',
          contractId: CONTRACT_ID,
          txHash: 'b'.repeat(64),
          topic: paymentTopic(),
          value: paymentValue({
            from: payer.publicKey(),
            to: merchant.publicKey(),
            token: NATIVE_SAC,
            stroops: 100_000_000n,
            memo: 'sp:corr-123',
          }),
        },
      ]);

      await service.syncOnce();

      expect(mockInbound.handle).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.updateMany).not.toHaveBeenCalled(); // already CONFIRMED
    });
  });
});

describe('extractCorrelationMemo', () => {
  it('finds an sp: memo nested inside a vec ScVal', () => {
    const event = { value: scvStringValue('sp:corr-9') };
    expect(extractCorrelationMemo(event)).toBe('corr-9');
  });

  it('accepts the object form (value: { xdr }) returned by some RPC versions', () => {
    const event = { value: { xdr: scvStringValue('sp:corr-10') } };
    expect(extractCorrelationMemo(event)).toBe('corr-10');
  });

  it('returns null for a memo without the sp: prefix', () => {
    const event = { value: scvStringValue('plain-memo') };
    expect(extractCorrelationMemo(event)).toBeNull();
  });

  it('returns null for unparseable or missing values', () => {
    expect(extractCorrelationMemo({ value: '%%%not-xdr%%%' })).toBeNull();
    expect(extractCorrelationMemo({ value: { xdr: '%%%not-xdr%%%' } })).toBeNull();
    expect(extractCorrelationMemo({})).toBeNull();
  });
});
