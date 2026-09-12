import { describe, expect, it } from '@jest/globals';
import { createId, hashSecret, newNonce, newSecret } from './id';

describe('createId', () => {
  it('returns an RFC 4122 v4 UUID', () => {
    expect(createId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createId()));
    expect(ids.size).toBe(200);
  });
});

describe('newNonce', () => {
  it('returns the requested number of hex-encoded random bytes', () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(newNonce(16)).toHaveLength(32);
  });

  it('never repeats (no Math.random fallback in the hot path)', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => newNonce(16)));
    expect(nonces.size).toBe(200);
  });
});

describe('newSecret', () => {
  it('returns a URL-safe string with no padding', () => {
    const secret = newSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(40); // 32 bytes → 43 base64url chars
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => newSecret(16)));
    expect(secrets.size).toBe(100);
  });
});

describe('hashSecret', () => {
  it('is deterministic and one-way (sha-256 hex)', async () => {
    const a = await hashSecret('webhook-secret');
    const b = await hashSecret('webhook-secret');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashSecret('webhook-secret ')).not.toBe(a);
  });
});
