import { ConfigService } from '@nestjs/config';
import { HorizonInboundService } from './horizon-inbound.service';

function keyedConfig(map: Record<string, unknown>) {
  return { get: jest.fn((key: string) => map[key]) } as unknown as ConfigService;
}

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload };
}

describe('HorizonInboundService', () => {
  let service: HorizonInboundService;
  let mockPrisma: Record<string, any>;
  let mockRedis: Record<string, jest.Mock>;
  let mockInbound: Record<string, jest.Mock>;
  let fetchMock: jest.Mock;

  const MERCHANT_ADDRESS = 'GAMERCHANTADDRESS123456789012345678901234567890';
  const FROM = 'GPAYERADDRESS987654321098765432109876543210987654';

  function paymentRecord(overrides: Record<string, unknown>) {
    return {
      type: 'payment',
      from: FROM,
      to: MERCHANT_ADDRESS,
      amount: '10.0000000',
      asset_type: 'native',
      transaction_hash: 'aa'.repeat(32),
      transaction_successful: true,
      paging_token: '12884901889',
      ...overrides,
    };
  }

  beforeEach(() => {
    mockPrisma = {
      merchant: {
        findMany: jest.fn().mockResolvedValue([{ settlementPublicKey: MERCHANT_ADDRESS }]),
      },
    };
    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    mockInbound = { handle: jest.fn().mockResolvedValue({ created: true }) };

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new HorizonInboundService(
      mockPrisma as any,
      keyedConfig({ HORIZON_URL: 'https://horizon-testnet.example.org' }),
      mockRedis as any,
      mockInbound as any,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('polls each active merchant and credits inbound payments with native→XLM mapping', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [paymentRecord({})],
        },
      }),
    );

    await service.syncOnce();

    expect(fetchMock).toHaveBeenCalledWith(
      `https://horizon-testnet.example.org/accounts/${MERCHANT_ADDRESS}/payments?order=asc&limit=100`,
      expect.anything(),
    );
    expect(mockInbound.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'horizon',
        eventId: '12884901889',
        fromPublicKey: FROM,
        toPublicKey: MERCHANT_ADDRESS,
        amount: '10.0000000',
        assetCode: 'XLM',
        assetIssuer: null,
        hash: 'aa'.repeat(32),
        memo: null,
      }),
    );
    expect(mockRedis.set).toHaveBeenCalledWith(
      `indexer:horizon:${MERCHANT_ADDRESS}`,
      '12884901889',
    );
  });

  it('maps issued assets to their code + issuer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [
            paymentRecord({
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: 'GISSUSER',
              paging_token: 'tok-usdc',
            }),
          ],
        },
      }),
    );

    await service.syncOnce();

    expect(mockInbound.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        assetCode: 'USDC',
        assetIssuer: 'GISSUSER',
        eventId: 'tok-usdc',
      }),
    );
  });

  it('ignores outbound payments (merchant is the sender) and non-payment operations', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [
            paymentRecord({ to: FROM, paging_token: 'tok-out' }), // merchant pays out
            { ...paymentRecord({}), type: 'create_account', paging_token: 'tok-create' },
          ],
        },
      }),
    );

    await service.syncOnce();

    expect(mockInbound.handle).not.toHaveBeenCalled();
    // Cursor still advances past the fetched page.
    expect(mockRedis.set).toHaveBeenCalledWith(`indexer:horizon:${MERCHANT_ADDRESS}`, 'tok-create');
  });

  it('resumes from the persisted cursor on the next poll', async () => {
    mockRedis.get.mockResolvedValue('tok-100');
    fetchMock.mockResolvedValue(
      jsonResponse({ _embedded: { records: [paymentRecord({ paging_token: 'tok-101' })] } }),
    );

    await service.syncOnce();

    expect(fetchMock).toHaveBeenCalledWith(
      `https://horizon-testnet.example.org/accounts/${MERCHANT_ADDRESS}/payments?order=asc&limit=100&cursor=tok-100`,
      expect.anything(),
    );
  });

  it('continues when a merchant feed is unreachable', async () => {
    mockPrisma.merchant.findMany.mockResolvedValue([
      { settlementPublicKey: 'MERCHANT-A' },
      { settlementPublicKey: 'MERCHANT-B' },
    ]);
    fetchMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(jsonResponse({ _embedded: { records: [] } }));

    await expect(service.syncOnce()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
