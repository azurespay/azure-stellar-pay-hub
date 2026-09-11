import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { parseContractEvent } from './contract-events';

function accountScVal(publicKey: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(publicKey)),
    ),
  );
}

function contractScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId) as unknown as xdr.Hash),
  );
}

function i128(stroops: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: stroops,
      hi: 0n,
    } as unknown as ConstructorParameters<typeof xdr.Int128Parts>[0]),
  );
}

function u64(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(value as never);
}

function topic(name: string): string[] {
  return [xdr.ScVal.scvSymbol(name).toXDR('base64').toString()];
}

/** Encode a #[contracttype] struct as a positional vec (protocol-22+ layout). */
function vecValue(fields: xdr.ScVal[]): string {
  return xdr.ScVal.scvVec(fields).toXDR('base64').toString();
}

/** Encode a #[contracttype] struct as a name-keyed map (alternate layout). */
function mapValue(entries: Array<[string, xdr.ScVal]>): string {
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  )
    .toXDR('base64')
    .toString();
}

describe('parseContractEvent', () => {
  const payer = Keypair.random().publicKey();
  const recipient = Keypair.random().publicKey();
  const sac = 'CC5UUVJCU3WRXDPDE3MEP65BN7XASQDV6O5IWVQRT53D5UKJ63UVHLCA';

  it('returns null for unknown topics and unparseable payloads', () => {
    expect(parseContractEvent(['garbage'], undefined)).toBeNull();
    expect(
      parseContractEvent([xdr.ScVal.scvSymbol('nope').toXDR('base64').toString()], '%%%'),
    ).toBeNull();
    expect(parseContractEvent(undefined, undefined)).toBeNull();
  });

  it('parses the escrow `created` event (positional vec)', () => {
    const value = vecValue([
      u64(7n),
      accountScVal(payer),
      accountScVal(recipient),
      i128(100_000_000n),
    ]);
    const event = parseContractEvent(topic('created'), value);
    expect(event).toEqual({
      topic: 'created',
      id: 7n,
      initiator: payer,
      counterparty: recipient,
      amountStroops: 100_000_000n,
    });
  });

  it('parses the escrow `released` event (name-keyed map)', () => {
    const value = mapValue([
      ['id', u64(7n)],
      ['to', accountScVal(recipient)],
      ['amount', i128(100_000_000n)],
    ]);
    const event = parseContractEvent(topic('released'), value);
    expect(event).toEqual({
      topic: 'released',
      id: 7n,
      to: recipient,
      amountStroops: 100_000_000n,
    });
  });

  it('parses the escrow `refund` event', () => {
    const value = vecValue([u64(7n), accountScVal(payer), i128(100_000_000n)]);
    const event = parseContractEvent(topic('refund'), value);
    expect(event?.topic).toBe('refund');
    expect(event?.id).toBe(7n);
    expect(event?.to).toBe(payer);
  });

  it('parses the invoices `issued` and `paid` events', () => {
    const merchant = Keypair.random().publicKey();
    const customer = Keypair.random().publicKey();
    const issued = parseContractEvent(
      topic('issued'),
      vecValue([u64(3n), accountScVal(merchant), accountScVal(customer), i128(50_000_000n)]),
    );
    expect(issued).toEqual({
      topic: 'issued',
      id: 3n,
      merchant,
      customer,
      amountStroops: 50_000_000n,
    });

    const paid = parseContractEvent(
      topic('paid'),
      vecValue([u64(3n), accountScVal(customer), accountScVal(merchant), i128(50_000_000n)]),
    );
    expect(paid).toEqual({
      topic: 'paid',
      id: 3n,
      payer: customer,
      merchant,
      amountStroops: 50_000_000n,
    });
  });

  it('parses the subscriptions `sub` and `renew` events', () => {
    const subscriber = Keypair.random().publicKey();
    const merchant = Keypair.random().publicKey();
    const sub = parseContractEvent(
      topic('sub'),
      vecValue([u64(11n), accountScVal(subscriber), u64(4n)]),
    );
    expect(sub).toEqual({ topic: 'sub', id: 11n, subscriber, planId: 4n });

    const renew = parseContractEvent(
      topic('renew'),
      vecValue([u64(11n), u64(4n), i128(25_000_000n), accountScVal(merchant)]),
    );
    expect(renew).toEqual({
      topic: 'renew',
      id: 11n,
      planId: 4n,
      amountStroops: 25_000_000n,
      merchant,
    });
  });

  it('parses treasury `deposit`, `wprop`, `wappr`, `wexec` events', () => {
    const from = Keypair.random().publicKey();
    const member = Keypair.random().publicKey();
    const to = Keypair.random().publicKey();

    const deposit = parseContractEvent(
      topic('deposit'),
      vecValue([contractScVal(sac), accountScVal(from), i128(10_000_000n)]),
    );
    expect(deposit).toEqual({ topic: 'deposit', token: sac, from, amountStroops: 10_000_000n });

    const wprop = parseContractEvent(
      topic('wprop'),
      vecValue([
        u64(2n),
        contractScVal(sac),
        accountScVal(to),
        i128(10_000_000n),
        accountScVal(from),
      ]),
    );
    expect(wprop?.topic).toBe('wprop');
    expect(wprop?.id).toBe(2n);
    expect(wprop?.by).toBe(from);

    const wappr = parseContractEvent(topic('wappr'), vecValue([u64(2n), accountScVal(member)]));
    expect(wappr).toEqual({ topic: 'wappr', id: 2n, member });

    const wexec = parseContractEvent(
      topic('wexec'),
      vecValue([u64(2n), contractScVal(sac), accountScVal(to), i128(10_000_000n)]),
    );
    expect(wexec?.topic).toBe('wexec');
    expect(wexec?.id).toBe(2n);
    expect(wexec?.to).toBe(to);
  });

  it('parses the merchant `reg`, `sale`, and `settle` events', () => {
    const owner = Keypair.random().publicKey();
    const settlement = Keypair.random().publicKey();

    const reg = parseContractEvent(
      topic('reg'),
      vecValue([u64(1n), accountScVal(owner), xdr.ScVal.scvString('Acme')]),
    );
    expect(reg).toEqual({ topic: 'reg', id: 1n, owner, name: 'Acme' });

    const sale = parseContractEvent(
      topic('sale'),
      vecValue([u64(1n), contractScVal(sac), i128(9_000_000n)]),
    );
    expect(sale).toEqual({ topic: 'sale', id: 1n, token: sac, amountStroops: 9_000_000n });

    const settle = parseContractEvent(
      topic('settle'),
      vecValue([
        u64(1n),
        contractScVal(sac),
        i128(8_900_000n),
        i128(100_000n),
        accountScVal(settlement),
      ]),
    );
    expect(settle).toEqual({
      topic: 'settle',
      id: 1n,
      token: sac,
      amountStroops: 8_900_000n,
      commissionStroops: 100_000n,
      to: settlement,
    });
  });

  it('rejects events with missing required fields', () => {
    // escrow `created` without an amount
    const value = vecValue([u64(7n), accountScVal(payer), accountScVal(recipient)]);
    expect(parseContractEvent(topic('created'), value)).toBeNull();
  });
});
