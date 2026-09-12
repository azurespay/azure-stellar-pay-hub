import { z } from 'zod';
import {
  amountSchema,
  assetCodeSchema,
  issuerSchema,
  memoSchema,
  memoTypeSchema,
  pageSchema,
  pageSizeSchema,
  publicKeySchema,
} from './common';
import { transactionDirectionSchema, transactionStatusSchema } from './transaction';

const destinationSchema = z
  .object({
    publicKey: publicKeySchema,
    amount: amountSchema,
    memo: memoSchema,
  })
  .strict();

export const createPaymentSchema = z
  .object({
    type: z.enum([
      'SEND',
      'QR',
      'PAYMENT_LINK',
      'SCHEDULED',
      'RECURRING',
      'BATCH',
      'SPLIT',
      'INVOICE',
      'CROSS_BORDER',
      'ESCROW',
      'SUBSCRIPTION',
    ]),
    fromPublicKey: publicKeySchema,
    destinations: z.array(destinationSchema).min(1, 'At least one destination is required'),
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    memo: memoSchema,
    memoType: memoTypeSchema,
    /** ISO timestamp - when to execute (scheduled/recurring). */
    scheduledFor: z.string().datetime().optional(),
    recurring: z
      .object({
        interval: z.enum(['daily', 'weekly', 'monthly']),
        count: z.number().int().min(1).max(365).optional(),
      })
      .optional(),
  })
  .strict();

export type CreatePayment = z.infer<typeof createPaymentSchema>;

export const paymentRequestSchema = z
  .object({
    publicKey: publicKeySchema,
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    amount: amountSchema.optional(),
    memo: memoSchema,
    message: z.string().max(280).optional(),
  })
  .strict();

export type PaymentRequestInput = z.infer<typeof paymentRequestSchema>;

export const transactionListQuerySchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
  // Reuses the shared status enum so CONFIRMED (the contract-route terminal
  // state) is filterable here too, instead of being silently excluded.
  status: transactionStatusSchema.optional(),
  direction: transactionDirectionSchema.optional(),
  assetCode: assetCodeSchema.optional(),
});

export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;
