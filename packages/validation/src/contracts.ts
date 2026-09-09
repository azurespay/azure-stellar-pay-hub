import { z } from 'zod';
import {
  amountSchema,
  assetCodeSchema,
  issuerSchema,
  publicKeySchema,
} from './common';

/** The signable envelope the wallet must sign for a prepared contract call. */
export const contractSignedXdrSchema = z.string().min(20, 'Signed XDR is required');

/** Body for the submit/confirm endpoints of the contract integrations. */
export const contractSubmitSchema = z
  .object({ signedXdr: contractSignedXdrSchema })
  .strict();
export type ContractSubmit = z.infer<typeof contractSubmitSchema>;

export const createEscrowSchema = z
  .object({
    initiatorPublicKey: publicKeySchema,
    counterpartyPublicKey: publicKeySchema,
    arbiterPublicKey: publicKeySchema.optional(),
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
    /** ISO timestamp; the escrow can be released from this point. */
    releaseTime: z.string().datetime(),
    /** ISO timestamp; after this the initiator/counterparty may refund. */
    expiry: z.string().datetime().optional(),
  })
  .strict();
export type CreateEscrow = z.infer<typeof createEscrowSchema>;

export const escrowSubmitSchema = z
  .object({ signedXdr: contractSignedXdrSchema })
  .strict();
export type EscrowSubmit = z.infer<typeof escrowSubmitSchema>;

export const escrowCallerActionSchema = z
  .object({ callerPublicKey: publicKeySchema })
  .strict();
export type EscrowCallerAction = z.infer<typeof escrowCallerActionSchema>;

export const createSubscriptionPlanSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
    intervalSeconds: z.number().int().min(60).max(31_536_000),
  })
  .strict();
export type CreateSubscriptionPlan = z.infer<typeof createSubscriptionPlanSchema>;

export const subscribePlanSchema = z
  .object({ subscriberPublicKey: publicKeySchema })
  .strict();
export type SubscribePlan = z.infer<typeof subscribePlanSchema>;

export const subscriptionCallSchema = z
  .object({ callerPublicKey: publicKeySchema })
  .strict();
export type SubscriptionCall = z.infer<typeof subscriptionCallSchema>;

export const treasuryDepositSchema = z
  .object({
    fromPublicKey: publicKeySchema,
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  })
  .strict();
export type TreasuryDeposit = z.infer<typeof treasuryDepositSchema>;

export const treasuryProposeWithdrawalSchema = z
  .object({
    proposerPublicKey: publicKeySchema,
    toPublicKey: publicKeySchema,
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  })
  .strict();
export type TreasuryProposeWithdrawal = z.infer<typeof treasuryProposeWithdrawalSchema>;

export const treasuryMemberActionSchema = z
  .object({ memberPublicKey: publicKeySchema })
  .strict();
export type TreasuryMemberAction = z.infer<typeof treasuryMemberActionSchema>;

export const merchantRegisterOnChainSchema = z
  .object({
    ownerPublicKey: publicKeySchema,
    name: z.string().min(1).max(120),
    settlementPublicKey: publicKeySchema,
    commissionBps: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type MerchantRegisterOnChain = z.infer<typeof merchantRegisterOnChainSchema>;

export const merchantSettleSchema = z
  .object({
    ownerPublicKey: publicKeySchema,
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
  })
  .strict();
export type MerchantSettle = z.infer<typeof merchantSettleSchema>;

export const recordMerchantSaleSchema = z
  .object({
    payerPublicKey: publicKeySchema,
    assetCode: assetCodeSchema.default('XLM'),
    assetIssuer: issuerSchema,
    amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  })
  .strict();
export type RecordMerchantSale = z.infer<typeof recordMerchantSaleSchema>;

export const payOnChainInvoiceSchema = z
  .object({ payerPublicKey: publicKeySchema })
  .strict();
export type PayOnChainInvoice = z.infer<typeof payOnChainInvoiceSchema>;