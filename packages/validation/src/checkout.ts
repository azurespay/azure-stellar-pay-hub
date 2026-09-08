import { z } from 'zod';
import { amountSchema, publicKeySchema } from './common';

/** Payer requests an intent for a payment link (amount only for open links). */
export const checkoutPayLinkSchema = z
  .object({
    publicKey: publicKeySchema,
    amount: amountSchema.optional(),
  })
  .strict();

export type CheckoutPayLink = z.infer<typeof checkoutPayLinkSchema>;

/** Payer requests an intent for an invoice. */
export const checkoutPayInvoiceSchema = z
  .object({
    publicKey: publicKeySchema,
  })
  .strict();

export type CheckoutPayInvoice = z.infer<typeof checkoutPayInvoiceSchema>;

/** Submission of a wallet-signed XDR envelope (base64). */
export const signedXdrSchema = z.object({
  signedXdr: z.string().min(1, 'signedXdr is required').max(4096, 'signedXdr is too long'),
});

export type SignedXdr = z.infer<typeof signedXdrSchema>;
