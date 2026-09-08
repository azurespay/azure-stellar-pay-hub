import {
  checkoutPayInvoiceSchema,
  checkoutPayLinkSchema,
  posPaymentSchema,
  signedXdrSchema,
} from './index';

const G = 'GDPAX5W7MZXQ42QIJTZRU3HIOH4HWL5SNXBUAE56WCJOIGTNJTAPUNHX';

describe('checkout validation schemas', () => {
  it('accepts a valid pay-link request with an optional amount', () => {
    expect(checkoutPayLinkSchema.parse({ publicKey: G, amount: '10.5' })).toEqual({
      publicKey: G,
      amount: '10.5',
    });
    expect(checkoutPayLinkSchema.parse({ publicKey: G })).toEqual({ publicKey: G });
  });

  it('rejects an invalid payer public key or amount', () => {
    expect(() => checkoutPayLinkSchema.parse({ publicKey: 'not-a-key' })).toThrow();
    expect(() => checkoutPayLinkSchema.parse({ publicKey: G, amount: '-1' })).toThrow();
    expect(() => checkoutPayLinkSchema.parse({ publicKey: G, extra: true })).toThrow();
  });

  it('accepts a valid invoice-pay request and rejects unknown fields', () => {
    expect(checkoutPayInvoiceSchema.parse({ publicKey: G })).toEqual({ publicKey: G });
    expect(() => checkoutPayInvoiceSchema.parse({ publicKey: G, amount: '1' })).toThrow();
  });

  it('validates signedXdr submissions (non-empty, bounded)', () => {
    expect(signedXdrSchema.parse({ signedXdr: 'AAAA' })).toEqual({ signedXdr: 'AAAA' });
    expect(() => signedXdrSchema.parse({ signedXdr: '' })).toThrow();
    expect(() => signedXdrSchema.parse({})).toThrow();
  });
});

describe('POS payment schema', () => {
  it('accepts product-only, amount-only, or both', () => {
    const productIds = ['00000000-0000-4000-8000-000000000001'];
    expect(posPaymentSchema.parse({ productIds })).toEqual({ productIds });
    expect(posPaymentSchema.parse({ amount: '5' })).toEqual({ amount: '5' });
    expect(posPaymentSchema.parse({ productIds, amount: '5', customerPublicKey: G })).toEqual({
      productIds,
      amount: '5',
      customerPublicKey: G,
    });
  });

  it('rejects neither products nor an amount', () => {
    expect(() => posPaymentSchema.parse({})).toThrow();
  });

  it('rejects a bad amount or bad product id', () => {
    expect(() => posPaymentSchema.parse({ amount: 'abc' })).toThrow();
    expect(() => posPaymentSchema.parse({ productIds: ['not-a-uuid'] })).toThrow();
  });
});
