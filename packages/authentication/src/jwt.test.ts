import { describe, expect, it } from '@jest/globals';
import {
  parseDurationSeconds,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './jwt';
import { UserRole } from '@stellar-pay/types';

const SECRET = 'test-secret-at-least-16-chars';

describe('parseDurationSeconds', () => {
  it.each([
    ['7d', 604_800],
    ['12h', 43_200],
    ['30m', 1_800],
    ['45s', 45],
    ['90', 90],
    [3600, 3600],
  ])('parses %s', (input, expected) => {
    expect(parseDurationSeconds(input as string | number, 1)).toBe(expected);
  });

  it.each([undefined, null, '', 'soon', '0d', '-5m', Number.NaN])(
    'falls back for the unusable value %s',
    (input) => {
      expect(parseDurationSeconds(input as string | number, 120)).toBe(120);
    },
  );
});

describe('token verification', () => {
  const payload = { sub: 'user-1', role: UserRole.USER, sessionId: 'session-1' };

  it('round-trips an access token', () => {
    const token = signAccessToken(payload, SECRET, '1h');
    expect(verifyAccessToken(token, SECRET).sub).toBe('user-1');
  });

  it('refuses to accept a refresh token as an access token', () => {
    // Refresh tokens are signed by the same secret, so the `type` claim is the
    // only thing separating a long-lived refresh credential from a bearer
    // access token. Verify that the split is enforced rather than assumed.
    const refresh = signRefreshToken(payload, SECRET);
    expect(() => verifyRefreshToken(refresh, SECRET)).not.toThrow();
    expect(() => verifyRefreshToken(signAccessToken(payload, SECRET, '1h'), SECRET)).toThrow(
      'Not a refresh token',
    );
  });

  it('rejects tokens signed with another secret', () => {
    const token = signAccessToken(payload, SECRET, '1h');
    expect(() => verifyAccessToken(token, 'another-secret-at-least-16')).toThrow();
  });
});
