import { describe, expect, it } from '@jest/globals';
import { transactionQuerySchema, transactionStatusSchema } from './transaction';

describe('transactionQuerySchema', () => {
  it('accepts an empty query and applies pagination defaults', () => {
    const result = transactionQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
      expect(result.data.status).toBeUndefined();
      expect(result.data.assetCode).toBeUndefined();
      expect(result.data.search).toBeUndefined();
    }
  });

  // Regression: the public /transactions route piped a raw, unvalidated
  // `status` string straight into Prisma, so an unknown value could surface as
  // a 500. The schema must reject anything outside the Prisma TransactionStatus
  // enum before the service sees it.
  it('rejects an unknown status value', () => {
    for (const status of ['BOGUS', 'succeeded', '', 'CONFIRMED ', 'DROP TABLE']) {
      expect(transactionQuerySchema.safeParse({ status }).success).toBe(false);
    }
  });

  it('accepts every Prisma TransactionStatus, including CONFIRMED', () => {
    for (const status of ['PENDING', 'SUBMITTED', 'CONFIRMED', 'SUCCEEDED', 'FAILED', 'CANCELED']) {
      const result = transactionQuerySchema.safeParse({ status });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe(status);
      }
    }
  });

  it('exposes the same enum used for writes (no drift between filter and model)', () => {
    for (const status of transactionStatusSchema.options) {
      expect(transactionQuerySchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('coerces numeric query strings, since HTTP query params arrive as strings', () => {
    const result = transactionQuerySchema.safeParse({ page: '2', pageSize: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.pageSize).toBe(50);
    }
  });

  it('rejects non-numeric and out-of-range pagination', () => {
    expect(transactionQuerySchema.safeParse({ page: 'abc' }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ page: -1 }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
  });

  it('rejects an over-long or malformed assetCode and search term', () => {
    expect(transactionQuerySchema.safeParse({ assetCode: 'USDC-INVALID' }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ search: 'x'.repeat(121) }).success).toBe(false);
    expect(transactionQuerySchema.safeParse({ assetCode: 'USDC', search: 'abc123' }).success).toBe(
      true,
    );
  });
});
