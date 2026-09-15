import { describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULT_STELLAR_RETRY,
  isRetryableStellarError,
  withRetry,
  type RetryConfig,
} from './retry';

/** A Horizon/Soroban HTTP failure, shaped like the stellar-sdk throws them. */
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const noSleep = { sleepImpl: () => Promise.resolve() };

describe('isRetryableStellarError', () => {
  it('retries rate limits and server-side failures', () => {
    for (const status of [429, 500, 502, 503, 504, 408]) {
      expect(isRetryableStellarError(httpError(status))).toBe(true);
    }
  });

  it('reads the status from either response shape', () => {
    expect(isRetryableStellarError({ response: { statusCode: 503 } })).toBe(true);
  });

  it('does not retry client errors, which repeat identically', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStellarError(httpError(status))).toBe(false);
    }
  });

  it('retries transport failures that never reached an answer', () => {
    expect(isRetryableStellarError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableStellarError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true,
    );
    expect(
      isRetryableStellarError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    ).toBe(true);
    expect(
      isRetryableStellarError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
    ).toBe(true);
  });

  it('does not retry a transaction the network already rejected', () => {
    // Re-sending the same envelope can only produce the same rejection.
    expect(isRetryableStellarError(new Error('Transaction failed: tx_bad_seq'))).toBe(false);
    expect(isRetryableStellarError(new Error('Transaction failed: op_no_destination'))).toBe(false);
    expect(isRetryableStellarError(new Error('account not found'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without waiting', async () => {
    const sleepImpl = jest.fn(() => Promise.resolve());
    const operation = jest.fn(() => Promise.resolve('ok'));

    await expect(withRetry(operation, DEFAULT_STELLAR_RETRY, { sleepImpl })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('retries a transient failure and returns the eventual success', async () => {
    const sleepImpl = jest.fn(() => Promise.resolve());
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, DEFAULT_STELLAR_RETRY, { sleepImpl })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it('reports each retry through onRetry', async () => {
    const onRetry = jest.fn();
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue('ok');

    await withRetry(operation, DEFAULT_STELLAR_RETRY, { ...noSleep, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(httpError(503));

    await expect(
      withRetry(operation, { ...DEFAULT_STELLAR_RETRY, maxAttempts: 3 }, noSleep),
    ).rejects.toThrow('HTTP 503');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a non-retryable error instead of burning attempts', async () => {
    const sleepImpl = jest.fn(() => Promise.resolve());
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('Transaction failed: tx_bad_seq'));

    await expect(withRetry(operation, DEFAULT_STELLAR_RETRY, { sleepImpl })).rejects.toThrow(
      'tx_bad_seq',
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('backs off exponentially and caps the delay', async () => {
    const delays: number[] = [];
    const sleepImpl = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const config: RetryConfig = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 400 };
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(httpError(503));

    await expect(withRetry(operation, config, { sleepImpl })).rejects.toThrow();
    expect(delays).toHaveLength(4);

    // Equal jitter: each delay sits within [half, full] of its window, and the
    // window doubles until the cap takes over.
    const windows = [100, 200, 400, 400];
    delays.forEach((delay, index) => {
      const window = windows[index]!;
      expect(delay).toBeGreaterThanOrEqual(window / 2);
      expect(delay).toBeLessThanOrEqual(window);
    });
  });

  it('can be disabled with maxAttempts: 1', async () => {
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(httpError(503));

    await expect(
      withRetry(operation, { ...DEFAULT_STELLAR_RETRY, maxAttempts: 1 }, noSleep),
    ).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('defaults to three attempts', () => {
    expect(DEFAULT_STELLAR_RETRY.maxAttempts).toBe(3);
  });
});
