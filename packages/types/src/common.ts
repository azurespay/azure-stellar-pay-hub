/** Stellar network identifiers. */
export enum StellarNetwork {
  PUBLIC = 'public',
  TESTNET = 'testnet',
  STANDALONE = 'standalone',
}

/** Well-known network passphrases. */
export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  [StellarNetwork.PUBLIC]: 'Public Global Stellar Network ; September 2015',
  [StellarNetwork.TESTNET]: 'Test SDF Network ; September 2015',
  [StellarNetwork.STANDALONE]: 'Standalone Network ; February 2017',
};

export enum UserRole {
  USER = 'USER',
  MERCHANT = 'MERCHANT',
  SUPPORT = 'SUPPORT',
  ADMIN = 'ADMIN',
}

export enum UserStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export enum WalletProvider {
  FREIGHTER = 'FREIGHTER',
  XBULL = 'XBULL',
  ALBEDO = 'ALBEDO',
}

export enum WalletStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export enum SessionStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  /** Contract-route settlement confirmed on-chain by the event indexer. */
  CONFIRMED = 'CONFIRMED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
}

export enum TransactionDirection {
  INCOMING = 'INCOMING',
  OUTGOING = 'OUTGOING',
}

export enum AssetType {
  NATIVE = 'NATIVE',
  STELLAR = 'STELLAR',
  CUSTOM = 'CUSTOM',
}

export enum TrustlineStatus {
  ACTIVE = 'ACTIVE',
  DELETED = 'DELETED',
}

export enum MerchantStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED',
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PAID = 'PAID',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  EXPIRED = 'EXPIRED',
  CANCELED = 'CANCELED',
}

export enum ProductStatus {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum PaymentLinkStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  EXPIRED = 'EXPIRED',
}

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  PUSH = 'PUSH',
  IN_APP = 'IN_APP',
  WEBHOOK = 'WEBHOOK',
}

export enum NotificationType {
  PAYMENT_SENT = 'PAYMENT_SENT',
  PAYMENT_RECEIVED = 'PAYMENT_RECEIVED',
  INVOICE_PAID = 'INVOICE_PAID',
  FAILED_TRANSACTION = 'FAILED_TRANSACTION',
  ACCOUNT_ACTIVITY = 'ACCOUNT_ACTIVITY',
}

export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  READ = 'READ',
}

export enum WebhookEventType {
  PAYMENT_RECEIVED = 'payment.received',
  PAYMENT_FAILED = 'payment.failed',
  INVOICE_PAID = 'invoice.paid',
  SETTLEMENT_COMPLETED = 'settlement.completed',
  CUSTOMER_CREATED = 'customer.created',
}

/** Amounts are represented as decimal strings to avoid float precision loss. */
export type AmountString = string;
