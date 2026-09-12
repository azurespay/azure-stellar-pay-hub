import { z } from 'zod';
import { amountSchema, assetCodeSchema, issuerSchema, memoSchema, publicKeySchema } from './common';

const invoiceItemSchema = z
  .object({
    name: z.string().min(1).max(120),
    quantity: z.number().int().positive().default(1),
    unitPrice: amountSchema,
    currency: z.string().length(3).toUpperCase().default('USD'),
  })
  .strict();

export const createInvoiceSchema = z
  .object({
    title: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    items: z.array(invoiceItemSchema).min(1),
    assetCode: assetCodeSchema.optional().default('USDC'),
    assetIssuer: issuerSchema,
    customerPublicKey: publicKeySchema.optional(),
    customerEmail: z.string().email().optional(),
    customerName: z.string().max(120).optional(),
    dueDate: z.string().datetime().optional(),
    memo: memoSchema,
  })
  .strict();

export type CreateInvoice = z.infer<typeof createInvoiceSchema>;

export const payInvoiceSchema = z
  .object({
    fromPublicKey: publicKeySchema,
    /** Signed XDR envelope (wallet signs client-side). */
    signedXdr: z.string().min(1).optional(),
  })
  .strict();

export type PayInvoice = z.infer<typeof payInvoiceSchema>;
