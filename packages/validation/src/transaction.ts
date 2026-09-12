import { z } from 'zod';
import { assetCodeSchema, pageSchema, pageSizeSchema } from './common';

/** Mirrors the Prisma `TransactionStatus` enum. */
export const transactionStatusSchema = z.enum([
  'PENDING',
  'SUBMITTED',
  'CONFIRMED',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
]);

/** Mirrors the Prisma `TransactionDirection` enum. */
export const transactionDirectionSchema = z.enum(['INCOMING', 'OUTGOING']);

export const transactionQuerySchema = z.object({
  status: transactionStatusSchema.optional(),
  // Reuses the shared asset-code schema (alphanumeric, 1-12 chars) so the
  // explorer filter cannot accept a malformed code the model can never hold.
  assetCode: assetCodeSchema.optional(),
  search: z.string().max(120).optional(),
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
