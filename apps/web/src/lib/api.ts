'use client';

import { ApiClient } from '@stellar-pay/sdk';

// In development, Next.js rewrites proxy /api/* → localhost:4000 so we can use
// relative URLs. In production (Vercel), use the full API URL from env vars;
// the fallback matches the documented hosted API (see docs/deployment.md).
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? (process.env.NEXT_PUBLIC_API_URL ?? 'https://stellar-pay-api.up.railway.app')
    : '';

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
