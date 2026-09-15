'use client';

import { ApiClient } from '@stellar-pay/sdk';

// The API is mounted under /api (apps/api/src/main.ts sets that global prefix)
// and the SDK builds URLs as `${baseUrl}${path}` from paths like
// '/auth/challenge'. baseUrl therefore has to carry the prefix — a bare origin
// 404s every request, which is how the Vercel projects were first configured.
const LOCAL_API = 'http://localhost:4000';
const HOSTED_API = 'https://stellar-pay-api.up.railway.app';

/** Appends the /api prefix unless the caller already included it. */
export function withApiPrefix(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

/**
 * A blank value means "not configured". A Vercel variable can be defined but
 * empty, and `withApiPrefix('')` returns the relative `/api`, which the SDK's
 * `new URL()` rejects outright — so blank falls through to the default instead.
 */
function configuredOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Production talks to the API on its own origin. Development keeps the browser
 * same-origin so the rewrites in next.config.mjs proxy /api/* to the local API;
 * the SDK needs an absolute URL, so only server-side code calls it directly.
 * The fallback matches the documented hosted API (see docs/deployment.md).
 */
export function resolveApiUrl(
  isProduction: boolean,
  configured: string | undefined,
  browserOrigin: string | undefined,
): string {
  const explicit = configuredOrUndefined(configured);
  if (isProduction) {
    return withApiPrefix(explicit ?? HOSTED_API);
  }
  return withApiPrefix(configuredOrUndefined(browserOrigin) ?? explicit ?? LOCAL_API);
}

export const API_URL = resolveApiUrl(
  process.env.NODE_ENV === 'production',
  process.env.NEXT_PUBLIC_API_URL,
  typeof window === 'undefined' ? undefined : window.location.origin,
);

const TOKEN_KEY = 'stellar-pay:token';
const REFRESH_KEY = 'stellar-pay:refresh';

export function getToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export const api = new ApiClient({
  baseUrl: API_URL,
  getToken,
  onUnauthorized: () => {
    clearTokens();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('stellar-pay:unauthorized'));
    }
  },
});
