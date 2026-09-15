import { describe, expect, it } from '@jest/globals';
import { ApiClient, ApiClientError } from './client';

describe('ApiClient', () => {
  const baseUrl = 'https://api.example.com';

  it('builds URLs correctly', async () => {
    let capturedUrl = '';
    const mockFetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch });
    await client.auth.challenge('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

    expect(capturedUrl).toContain('https://api.example.com/auth/challenge');
  });

  it('adds auth header when getToken is provided', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = ((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({
      baseUrl,
      fetchImpl: mockFetch,
      getToken: () => 'test-token-123',
    });
    await client.users.me();

    expect(capturedHeaders['Authorization']).toBe('Bearer test-token-123');
  });

  it('sets Content-Type header', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = ((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch });
    await client.auth.logout();

    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });

  it('calls onUnauthorized on 401', async () => {
    let called = false;
    const mockFetch = () =>
      Promise.resolve(new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }));

    const client = new ApiClient({
      baseUrl,
      fetchImpl: mockFetch as typeof fetch,
      onUnauthorized: () => {
        called = true;
      },
    });

    try {
      await client.users.me();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
    }
    expect(called).toBe(true);
  });

  it('throws ApiClientError on non-200 responses', async () => {
    let capturedError: unknown;
    const mockFetch = () =>
      Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch as typeof fetch });

    try {
      await client.users.me();
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(ApiClientError);
    expect((capturedError as ApiClientError).statusCode).toBe(404);
    expect((capturedError as ApiClientError).message).toBe('Not Found');
  });

  it('supports query parameters', async () => {
    let capturedUrl = '';
    const mockFetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch });
    await client.payments.list({ page: 2, pageSize: 10, status: 'SUCCEEDED' });

    expect(capturedUrl).toContain('page=2');
    expect(capturedUrl).toContain('pageSize=10');
    expect(capturedUrl).toContain('status=SUCCEEDED');
  });

  it('strips trailing slash from baseUrl', async () => {
    let capturedUrl = '';
    const mockFetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl: 'https://api.example.com/', fetchImpl: mockFetch });
    await client.users.me();

    expect(capturedUrl).toBe('https://api.example.com/users/me');
  });

  it('forwards caller headers, so a payment can carry an Idempotency-Key', async () => {
    // `POST /payments` de-duplicates per user on that header; without it the
    // double-charge guard the API implements was unreachable from the client.
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = ((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch });
    await client.request({
      method: 'POST',
      path: '/payments',
      body: { type: 'SEND' },
      headers: { 'Idempotency-Key': 'create-key-1' },
    });

    expect(capturedHeaders['Idempotency-Key']).toBe('create-key-1');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });

  it('sends an Idempotency-Key from payments.create', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = ((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch });
    await client.payments.create({ type: 'SEND' }, { idempotencyKey: 'order-42' });

    expect(capturedHeaders['Idempotency-Key']).toBe('order-42');
  });

  it('omits the Idempotency-Key header when no key is supplied', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = ((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({ baseUrl, fetchImpl: mockFetch });
    await client.payments.create({ type: 'SEND' });

    expect(capturedHeaders['Idempotency-Key']).toBeUndefined();
  });

  it('still sets Authorization after caller headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = ((_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const client = new ApiClient({
      baseUrl,
      fetchImpl: mockFetch,
      getToken: () => 'test-token-123',
    });
    await client.request({ path: '/users/me', headers: { 'X-Trace': 'abc' } });

    expect(capturedHeaders['Authorization']).toBe('Bearer test-token-123');
    expect(capturedHeaders['X-Trace']).toBe('abc');
  });
});
