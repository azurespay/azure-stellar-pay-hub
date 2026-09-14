import { envSchema } from './schema';

/**
 * Only these three have no default, so they are the minimum a caller must set.
 * Everything else is optional or defaulted.
 */
const requiredEnv = {
  JWT_SECRET: 'test-secret-at-least-16-chars',
  ADMIN_PASSWORD: 'CiTestPass123!',
  WEBHOOK_SIGNING_SECRET: 'test-webhook-secret-16-chars',
};

describe('envSchema', () => {
  it('accepts a blank optional URL instead of failing boot', () => {
    // Regression: `pnpm generate:env` copies `.env.example`, which declares
    // `IPFS_API_URL=` (empty). `dotenv`/Nx surface that as `''`, which a bare
    // `z.string().url().optional()` rejects — breaking both the documented
    // local `pnpm test:unit` run and any deployment that copies the example.
    const parsed = envSchema.safeParse({ ...requiredEnv, IPFS_API_URL: '' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.IPFS_API_URL).toBeUndefined();
  });

  it('treats a blank defaulted URL as unset and applies the default', () => {
    const parsed = envSchema.parse({ ...requiredEnv, HORIZON_URL: '' });

    expect(parsed.HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
  });

  it('parses every blank-valued key shipped in .env.example', () => {
    const parsed = envSchema.safeParse({
      ...requiredEnv,
      API_PUBLIC_URL: 'http://localhost:4000',
      SOROBAN_RPC_URL: '',
      CONTRACT_STELLAR_PAY_PAYMENT: '',
      IPFS_GATEWAY: '',
      IPFS_API_URL: '',
      IPFS_API_KEY: '',
      PINATA_JWT: '',
      WEB3_STORAGE_TOKEN: '',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      SMS_API_KEY: '',
    });

    expect(parsed.success).toBe(true);
  });

  it('still rejects a malformed non-empty URL', () => {
    const parsed = envSchema.safeParse({ ...requiredEnv, IPFS_API_URL: 'not-a-url' });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['IPFS_API_URL']);
  });

  it('still requires secrets that have no safe default', () => {
    const { JWT_SECRET: _omitted, ...withoutJwt } = requiredEnv;
    const parsed = envSchema.safeParse(withoutJwt);

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues.map((i) => i.path.join('.'))).toContain(
      'JWT_SECRET',
    );
  });
});
