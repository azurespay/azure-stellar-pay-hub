import { z } from 'zod';
import { memoSchema, publicKeySchema } from './common';

export const updateProfileSchema = z
  .object({
    displayName: z.string().min(1).max(80).optional(),
    avatarUrl: z.string().url().nullable().optional(),
    locale: z.string().length(2).optional(),
    email: z.string().email().nullable().optional(),
  })
  .strict();

export type UpdateProfile = z.infer<typeof updateProfileSchema>;

export const createContactSchema = z
  .object({
    name: z.string().min(1).max(80),
    publicKey: publicKeySchema,
    memo: memoSchema,
    memoType: z.enum(['text', 'hash', 'id']).optional().default('text'),
    isFavorite: z.boolean().optional().default(false),
    network: z.enum(['public', 'testnet', 'standalone']).optional().default('testnet'),
  })
  .strict();

export type CreateContact = z.infer<typeof createContactSchema>;

export const createBeneficiarySchema = z
  .object({
    name: z.string().min(1).max(80),
    publicKey: publicKeySchema,
    currency: z.string().length(3).toUpperCase(),
    country: z.string().length(2).toUpperCase().optional(),
    bankDetails: z.record(z.string(), z.any()).optional(),
  })
  .strict();

export type CreateBeneficiary = z.infer<typeof createBeneficiarySchema>;

export const preferencesSchema = z
  .object({
    currency: z.string().length(3).toUpperCase().optional(),
    theme: z.enum(['dark', 'light']).optional(),
    notificationPreferences: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();

export type UpdatePreferences = z.infer<typeof preferencesSchema>;
