import { describe, expect, it } from '@jest/globals';
import {
  AssetType,
  InvoiceStatus,
  MerchantStatus,
  NETWORK_PASSPHRASES,
  NotificationChannel,
  NotificationType,
  StellarNetwork,
  TransactionStatus,
  UserRole,
  WalletProvider,
  WebhookEventType,
} from './common';

/**
 * These enums are a wire and persistence contract: the values are stored in
 * Postgres, embedded in JWTs, sent to webhook consumers and compared by the API
 * and the frontends. The tests below pin the exact strings so a rename cannot
 * silently invalidate existing rows or break a consumer.
 */
describe('StellarNetwork', () => {
  it('uses the values the API and contracts expect', () => {
    expect(StellarNetwork.PUBLIC).toBe('public');
    expect(StellarNetwork.TESTNET).toBe('testnet');
    expect(StellarNetwork.STANDALONE).toBe('standalone');
  });

  it('has a passphrase for every network', () => {
    for (const network of Object.values(StellarNetwork)) {
      expect(typeof NETWORK_PASSPHRASES[network]).toBe('string');
      expect(NETWORK_PASSPHRASES[network].length).toBeGreaterThan(0);
    }
  });

  it('carries the canonical passphrases, which must match Horizon exactly', () => {
    expect(NETWORK_PASSPHRASES[StellarNetwork.PUBLIC]).toBe(
      'Public Global Stellar Network ; September 2015',
    );
    expect(NETWORK_PASSPHRASES[StellarNetwork.TESTNET]).toBe('Test SDF Network ; September 2015');
    expect(NETWORK_PASSPHRASES[StellarNetwork.STANDALONE]).toBe(
      'Standalone Network ; February 2017',
    );
  });
});

describe('platform enums', () => {
  it('pins the auth and wallet values used in JWTs and API responses', () => {
    expect(Object.values(UserRole)).toEqual(['USER', 'MERCHANT', 'SUPPORT', 'ADMIN']);
    expect(Object.values(WalletProvider)).toEqual(['FREIGHTER', 'XBULL', 'ALBEDO']);
  });

  it('pins the transaction statuses, matching the Prisma enum exactly', () => {
    // `CONFIRMED` is written by the indexer once a contract call is observed
    // on-chain; consumers treat it as success alongside `SUCCEEDED`. It must
    // stay in this list: the shared enum previously omitted it even though the
    // Prisma enum and `@stellar-pay/validation` both had it.
    expect(Object.values(TransactionStatus)).toEqual([
      'PENDING',
      'SUBMITTED',
      'CONFIRMED',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
    ]);
  });

  it('pins the lifecycle enums persisted on invoices, merchants and assets', () => {
    expect(Object.values(InvoiceStatus)).toEqual([
      'DRAFT',
      'ISSUED',
      'PAID',
      'PARTIALLY_PAID',
      'EXPIRED',
      'CANCELED',
    ]);
    expect(Object.values(MerchantStatus)).toEqual(['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED']);
    expect(Object.values(AssetType)).toEqual(['NATIVE', 'STELLAR', 'CUSTOM']);
  });

  it('pins the notification channel and type values stored per notification', () => {
    expect(Object.values(NotificationChannel)).toEqual([
      'EMAIL',
      'SMS',
      'PUSH',
      'IN_APP',
      'WEBHOOK',
    ]);
    expect(Object.values(NotificationType)).toEqual([
      'PAYMENT_SENT',
      'PAYMENT_RECEIVED',
      'INVOICE_PAID',
      'FAILED_TRANSACTION',
      'ACCOUNT_ACTIVITY',
    ]);
  });
});

describe('WebhookEventType', () => {
  it('uses the lowercase dotted form consumers subscribe to', () => {
    expect(Object.values(WebhookEventType)).toEqual([
      'payment.received',
      'payment.failed',
      'invoice.paid',
      'settlement.completed',
      'customer.created',
    ]);
  });

  it('is all lowercase and dotted, matching the webhook payload convention', () => {
    for (const event of Object.values(WebhookEventType)) {
      expect(event).toBe(event.toLowerCase());
      expect(event).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });
});

describe('enum hygiene', () => {
  const enums: Record<string, Record<string, string>> = {
    StellarNetwork,
    UserRole,
    TransactionStatus,
    InvoiceStatus,
    MerchantStatus,
    NotificationChannel,
    NotificationType,
    WebhookEventType,
  };

  it.each(Object.entries(enums))('%s has no duplicated values', (_name, enumObject) => {
    const values = Object.values(enumObject);
    expect(new Set(values).size).toBe(values.length);
  });
});
