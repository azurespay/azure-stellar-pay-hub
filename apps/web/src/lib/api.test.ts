// The SDK re-exports @stellar/stellar-sdk, which needs browser globals that
// jsdom does not provide (TextEncoder). These tests cover URL resolution only,
// so the client itself is stubbed and the module under test stays real.
jest.mock('@stellar-pay/sdk', () => ({ ApiClient: class {} }));

import { API_URL, resolveApiUrl, withApiPrefix } from './api';

const HOSTED = 'https://stellar-pay-api.up.railway.app';
const LOCAL = 'http://localhost:4000';

describe('withApiPrefix', () => {
  it('appends the API prefix to a bare origin', () => {
    expect(withApiPrefix(HOSTED)).toBe(`${HOSTED}/api`);
  });

  it('leaves an origin that already carries the prefix alone', () => {
    expect(withApiPrefix(`${HOSTED}/api`)).toBe(`${HOSTED}/api`);
  });

  it('ignores trailing slashes so the prefix is not duplicated', () => {
    expect(withApiPrefix(`${HOSTED}/`)).toBe(`${HOSTED}/api`);
    expect(withApiPrefix(`${HOSTED}/api/`)).toBe(`${HOSTED}/api`);
  });
});

describe('resolveApiUrl', () => {
  it('uses the configured origin in production and adds the prefix', () => {
    expect(resolveApiUrl(true, 'https://api.example.com', undefined)).toBe(
      'https://api.example.com/api',
    );
  });

  it('falls back to the documented hosted API when nothing is configured', () => {
    expect(resolveApiUrl(true, undefined, undefined)).toBe(`${HOSTED}/api`);
  });

  it('treats a blank configured value as unset rather than as a relative base', () => {
    // A Vercel variable can exist but be empty; `withApiPrefix('')` is `/api`,
    // which the SDK's `new URL()` rejects outright.
    expect(resolveApiUrl(true, '', undefined)).toBe(`${HOSTED}/api`);
    expect(resolveApiUrl(true, '   ', undefined)).toBe(`${HOSTED}/api`);
    expect(resolveApiUrl(false, '', undefined)).toBe(`${LOCAL}/api`);
  });

  it('ignores a blank browser origin in development', () => {
    expect(resolveApiUrl(false, undefined, '')).toBe(`${LOCAL}/api`);
  });

  it('keeps the browser same-origin in development so the /api rewrite proxies it', () => {
    expect(resolveApiUrl(false, undefined, 'http://localhost:3000')).toBe(
      'http://localhost:3000/api',
    );
  });

  it('falls back to the local API when there is no browser origin (SSR)', () => {
    expect(resolveApiUrl(false, undefined, undefined)).toBe(`${LOCAL}/api`);
  });

  it('never returns a relative base, which the SDK cannot parse', () => {
    const bases = [
      resolveApiUrl(true, undefined, undefined),
      resolveApiUrl(true, 'https://api.example.com', undefined),
      resolveApiUrl(true, '', undefined),
      resolveApiUrl(false, undefined, 'http://localhost:3000'),
      resolveApiUrl(false, '', ''),
      resolveApiUrl(false, undefined, undefined),
    ];

    for (const base of bases) {
      expect(() => new URL(`${base}/auth/challenge`)).not.toThrow();
    }
  });
});

describe('API_URL', () => {
  // The SDK builds request URLs as `${baseUrl}${path}`, so a base missing the
  // prefix reaches /auth/challenge instead of /api/auth/challenge and 404s.
  it('resolves to an absolute, /api-prefixed endpoint', () => {
    const url = new URL(`${API_URL}/auth/challenge`);

    expect(url.protocol).toBe('http:');
    expect(url.pathname.endsWith('/api/auth/challenge')).toBe(true);
  });
});
