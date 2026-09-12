import { z } from 'zod';

export const publicKeySchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, 'Must be a valid Stellar public key (G...)');

export const muxedPublicKeySchema = z
  .string()
  .regex(/^M[A-Z2-7]{68}$/, 'Must be a valid Stellar muxed address (M...)');

export const anyPublicKeySchema = z
  .string()
  .regex(/^[GM][A-Z2-7]{55,68}$/, 'Must be a valid Stellar public key (G... or M...)');

export const idSchema = z.string().uuid();

export const amountSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+)?$/, 'Amount must be a non-negative decimal string');

export const assetCodeSchema = z.string().regex(/^[a-zA-Z0-9]{1,12}$/);

export const issuerSchema = publicKeySchema.nullable().optional();

/**
 * Stellar text memos are limited to 28 **bytes**, not 28 characters. Counting
 * UTF-16 code units (`z.string().max(28)`) lets a 28-character emoji memo
 * through validation and then fail on-chain (Horizon rejects the envelope), so
 * the limit is measured on the encoded bytes — the same rule
 * `isValidMemo` in `@stellar-pay/shared` applies.
 */
export const memoSchema = z
  .string()
  .refine((memo) => new TextEncoder().encode(memo).length <= 28, 'Memo must be at most 28 bytes')
  .optional();

export const memoTypeSchema = z.enum(['text', 'hash', 'id']).optional();

export const pageSchema = z.coerce.number().int().min(1).optional().default(1);
export const pageSizeSchema = z.coerce.number().int().min(1).max(100).optional().default(20);

export const paginationQuerySchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
