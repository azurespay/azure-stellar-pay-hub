import { z } from 'zod';
import { amountSchema, assetCodeSchema, issuerSchema, publicKeySchema } from './common';
import { webhookUrlSchema } from './webhook';

export const createMerchantSchema = z
  .object({
    name: z.string().min(2).max(80),
    slug: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and dashes'),
    description: z.string().max(500).optional(),
    logoUrl: z.string().url().optional(),
    websiteUrl: z.string().url().optional(),
    currency: z.string().length(3).toUpperCase().optional().default('USD'),
    settlementAssetCode: assetCodeSchema.optional().default('USDC'),
    settlementAssetIssuer: issuerSchema,
    settlementPublicKey: publicKeySchema,
    webhookUrl: webhookUrlSchema.optional(),
  })
  .strict();

export type CreateMerchant = z.infer<typeof createMerchantSchema>;

export const updateMerchantSchema = createMerchantSchema.partial();

export type UpdateMerchant = z.infer<typeof updateMerchantSchema>;

export const productSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    priceAmount: amountSchema,
    assetCode: assetCodeSchema.optional().default('USDC'),
    assetIssuer: issuerSchema,
    imageUrl: z.string().url().optional(),
  })
  .strict();

export type CreateProduct = z.infer<typeof productSchema>;

export const posPaymentSchema = z
  .object({
    productIds: z.array(z.string().uuid()).optional(),
    customerPublicKey: publicKeySchema.optional(),
    amount: amountSchema.optional(),
    assetCode: assetCodeSchema.optional(),
  })
  .strict()
  .refine((v) => v.productIds?.length || v.amount, {
    message: 'Provide either productIds or an amount',
    path: ['amount'],
  });

export type PosPayment = z.infer<typeof posPaymentSchema>;
