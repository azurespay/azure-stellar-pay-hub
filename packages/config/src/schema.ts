import { z } from 'zod';

/**
 * `dotenv` (and Docker/Kubernetes env blocks) surface a declared-but-empty key
 * as `''`, not `undefined`. For optional settings an empty value means "not
 * configured" rather than "invalid", so normalise it to `undefined` before
 * validation. Without this, copying `.env.example` verbatim (where
 * `IPFS_API_URL=` is intentionally blank) fails API boot with a URL error.
 */
const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

/** Optional URL: absent or blank both mean "unset"; a present value must be a URL. */
const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().url().optional());

/** URL with a fallback: absent or blank both take the default. */
const urlWithDefault = (fallback: string) =>
  z.preprocess(emptyToUndefined, z.string().url().default(fallback));

/**
 * Source of truth for every environment variable used by the platform.
 * The API validates its process.env against this schema at boot so that
 * misconfigured deployments fail fast.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // API
    API_PORT: z.coerce.number().int().positive().default(4000),
    API_PUBLIC_URL: optionalUrl(),
    METRICS_ENABLED: z.string().default('false'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    // Auth
    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('7d'),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    // Database / cache
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://postgres:postgres@localhost:5432/stellar_pay?schema=public'),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // Stellar
    STELLAR_NETWORK: z.enum(['public', 'testnet', 'standalone']).default('testnet'),
    HORIZON_URL: urlWithDefault('https://horizon-testnet.stellar.org'),
    SOROBAN_RPC_URL: optionalUrl(),
    NETWORK_PASSPHRASE: z.string().optional(),

    // Soroban payment route (experimental). `classic` builds Stellar
    // Operation.payment XDR; `contract` invokes the deployed payment contract's
    // `send` entry point for the configured assets.
    PAYMENT_ROUTE: z.enum(['classic', 'contract']).default('classic'),
    CONTRACT_STELLAR_PAY_PAYMENT: z.string().optional(),
    // Other deployed contract addresses (see `.deployed-contracts.env`). These
    // gate the escrow / invoices / subscriptions / treasury / merchant
    // on-chain integrations: each feature is inactive when its contract
    // address is not configured.
    CONTRACT_STELLAR_PAY_ESCROW: z.string().optional(),
    CONTRACT_STELLAR_PAY_INVOICES: z.string().optional(),
    CONTRACT_STELLAR_PAY_SUBSCRIPTIONS: z.string().optional(),
    CONTRACT_STELLAR_PAY_TREASURY: z.string().optional(),
    CONTRACT_STELLAR_PAY_MERCHANT: z.string().optional(),
    PAYMENT_CONTRACT_ASSETS: z
      .string()
      .default('XLM')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      ),

    // Admin seed
    ADMIN_EMAIL: z.string().email().default('admin@stellar-pay.dev'),
    ADMIN_PASSWORD: z.string().min(8),

    // Notifications
    NOTIFICATIONS_EMAIL_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMS_PROVIDER: z.enum(['console', 'twilio', 'vonage']).default('console'),
    SMS_API_KEY: z.string().optional(),
    PUSH_PROVIDER: z.enum(['console', 'fcm']).default('console'),
    WEBHOOK_SIGNING_SECRET: z.string().min(16),

    // IPFS
    IPFS_PROVIDER: z.enum(['local', 'pinata', 'web3']).default('local'),
    IPFS_GATEWAY: urlWithDefault('https://ipfs.io/ipfs/'),
    IPFS_API_URL: optionalUrl(),
    IPFS_API_KEY: z.string().optional(),
    PINATA_JWT: z.string().optional(),
    WEB3_STORAGE_TOKEN: z.string().optional(),

    ANALYTICS_PROVIDER: z.enum(['console', 'posthog']).default('console'),

    // Public app URLs
    WEB_APP_URL: urlWithDefault('http://localhost:3000'),
    ADMIN_APP_URL: urlWithDefault('http://localhost:3001'),
    EXPLORER_APP_URL: urlWithDefault('http://localhost:3002'),
    DOCS_APP_URL: urlWithDefault('http://localhost:3003'),
  })
  .passthrough();

export type EnvConfig = z.infer<typeof envSchema>;
