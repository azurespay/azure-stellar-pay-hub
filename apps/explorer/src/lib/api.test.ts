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
  it('normalises the deployed bare origin to the prefixed form', () => {
    expect(resolveApiUrl(HOSTED, false)).toBe(`${HOSTED}/api`);
  });

  it('treats a blank configured value as unset rather than as a relative base', () => {
    // A Vercel variable can exist but be empty; `withApiPrefix('')` is `/api`,
    // which the SDK's `new URL()` rejects outright.
    expect(resolveApiUrl('', true)).toBe(`${HOSTED}/api`);
    expect(resolveApiUrl('   ', true)).toBe(`${HOSTED}/api`);
    expect(resolveApiUrl('', false)).toBe(`${LOCAL}/api`);
  });
});

describe('API_URL', () => {
  // The SDK builds request URLs as `${baseUrl}${path}` from paths like
  // '/transactions', so a base missing the prefix reaches /transactions and 404s.
  it('carries the /api prefix the API is mounted under', () => {
    expect(API_URL.endsWith('/api')).toBe(true);
  });

  it('never returns a relative base, which the SDK cannot parse', () => {
    expect(() => new URL(`${API_URL}/transactions`)).not.toThrow();
  });
});
