import { ApiClient } from '@stellar-pay/sdk';

// The API is mounted under /api (apps/api/src/main.ts sets that global prefix)
// and the SDK builds URLs as `${baseUrl}${path}` from paths like
// '/transactions', so the prefix has to be present. The deployed vercel.json
// carries the explicit prefixed form; these helpers make a bare origin (or a
// blank variable) resolve to the same thing instead of 404ing.
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

export function resolveApiUrl(configured: string | undefined, isProduction: boolean): string {
  return withApiPrefix(
    configuredOrUndefined(configured) ?? (isProduction ? HOSTED_API : LOCAL_API),
  );
}

export const API_URL = resolveApiUrl(
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NODE_ENV === 'production',
);

export const explorerApi = new ApiClient({ baseUrl: API_URL });
