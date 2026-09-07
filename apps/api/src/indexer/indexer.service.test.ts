import { ConfigService } from '@nestjs/config';
import { xdr } from '@stellar/stellar-sdk';
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
      mockWebhooks as any,
      mockRealtime as any,
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
        mockWebhooks as any,
        mockRealtime as any,
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
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'payment.received',
        expect.objectContaining({ transactionId: 'tx-contract-1' }),
      );
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
