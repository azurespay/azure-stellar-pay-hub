import { Asset, Keypair, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { parsePaymentEventData, stroopsToUnits, topicIsPayment } from './soroban-event';

function accountScVal(publicKey: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(publicKey)),
    ),
  );
}

function contractScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(contractId)),
  );
}

function amountScVal(stroops: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ lo: stroops, hi: 0n } as unknown as ConstructorParameters<
      typeof xdr.Int128Parts
    >[0]),
  );
}

function memoScVal(memo: string): xdr.ScVal {
  return xdr.ScVal.scvString(memo);
}

function entry(key: xdr.ScVal, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key, val });
}

function symbolKey(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

describe('parsePaymentEventData', () => {
  const from = Keypair.random().publicKey();
  const to = Keypair.random().publicKey();
  const token = Asset.native().contractId(Networks.TESTNET); // C-address
  const stroops = 123_456_789n; // 12.3456789 XLM

  it('decodes a positional vec layout (declaration order)', () => {
    const value = xdr.ScVal.scvVec([
      accountScVal(from),
      accountScVal(to),
      contractScVal(token),
      amountScVal(stroops),
      memoScVal(''),
    ]);
    const parsed = parsePaymentEventData(value.toXDR('base64').toString());
    expect(parsed).toEqual({
      from,
      to,
      token,
      amountStroops: stroops,
      memo: '',
    });
  });

  it('decodes a map layout keyed by symbol field names', () => {
    const value = xdr.ScVal.scvMap([
      entry(symbolKey('from'), accountScVal(from)),
      entry(symbolKey('to'), accountScVal(to)),
      entry(symbolKey('token'), contractScVal(token)),
      entry(symbolKey('amount'), amountScVal(stroops)),
      entry(symbolKey('memo'), memoScVal('INV-1001')),
    ]);
    const parsed = parsePaymentEventData(value.toXDR('base64').toString());
    expect(parsed).toEqual({
      from,
      to,
      token,
      amountStroops: stroops,
      memo: 'INV-1001',
    });
  });

  it('decodes a map layout keyed by string field names', () => {
    const value = xdr.ScVal.scvMap([
      entry(xdr.ScVal.scvString('from'), accountScVal(from)),
      entry(xdr.ScVal.scvString('to'), accountScVal(to)),
      entry(xdr.ScVal.scvString('token'), contractScVal(token)),
      entry(xdr.ScVal.scvString('amount'), amountScVal(stroops)),
      entry(xdr.ScVal.scvString('memo'), memoScVal('')),
    ]);
    const parsed = parsePaymentEventData(value.toXDR('base64').toString());
    expect(parsed).toEqual({
      from,
      to,
      token,
      amountStroops: stroops,
      memo: '',
    });
  });

  it('returns null for non-payment payloads and garbage', () => {
    expect(parsePaymentEventData(null)).toBeNull();
    expect(parsePaymentEventData(undefined)).toBeNull();
    expect(parsePaymentEventData('%%%not-xdr%%%')).toBeNull();
    expect(
      parsePaymentEventData(xdr.ScVal.scvSymbol('payment').toXDR('base64').toString()),
    ).toBeNull();
  });

  it('rejects zero or negative amounts', () => {
    const zero = xdr.ScVal.scvVec([
      accountScVal(from),
      accountScVal(to),
      contractScVal(token),
      amountScVal(0n),
      memoScVal(''),
    ]);
    expect(parsePaymentEventData(zero.toXDR('base64').toString())).toBeNull();
  });
});

describe('topicIsPayment', () => {
  it('accepts a payment symbol topic and rejects others', () => {
    const payment = [xdr.ScVal.scvSymbol('payment').toXDR('base64').toString()];
    const paused = [xdr.ScVal.scvSymbol('paused').toXDR('base64').toString()];
    expect(topicIsPayment(payment)).toBe(true);
    expect(topicIsPayment(paused)).toBe(false);
    expect(topicIsPayment([])).toBe(false);
    expect(topicIsPayment(undefined)).toBe(false);
    expect(topicIsPayment(['not-base64'])).toBe(false);
  });
});

describe('stroopsToUnits', () => {
  it('converts with XLM 7 decimals and trims trailing zeros', () => {
    expect(stroopsToUnits(100_000_000n, 7)).toBe('10');
    expect(stroopsToUnits(123_456_789n, 7)).toBe('12.3456789');
    expect(stroopsToUnits(1n, 7)).toBe('0.0000001');
    expect(stroopsToUnits(0n, 7)).toBe('0');
  });
});
