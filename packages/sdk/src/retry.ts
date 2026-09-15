/**
 * Exponential backoff for transient Stellar endpoint failures.
 *
 * Horizon and Soroban RPC both answer `429` when rate limiting and `5xx` while
 * a node is unhealthy or failing over, and the stellar-sdk retries neither — a
 * single unlucky request surfaced to the user as a failed payment. Reads are
 * always safe to repeat. Re-submitting an identical signed envelope is
 * idempotent too: the envelope carries the same sequence number, so a second
 * submission can only be rejected as a duplicate, never applied twice — and the
 * API treats a submission error as "still pending" and lets the event indexer
 * decide the outcome, so a retry cannot manufacture a false success.
 */

export interface RetryConfig {
  /** Total attempts, including the first one. */
  maxAttempts: number;
  /** Delay before the second attempt, doubled for each attempt after that. */
  baseDelayMs: number;
  /** Ceiling for a single delay, so a long outage cannot stall a caller. */
  maxDelayMs: number;
}

/** Three attempts (250ms, then 500ms) keeps a request well inside its timeout. */
export const DEFAULT_STELLAR_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/** errno-style codes that mean the request never reached an answer. */
const RETRYABLE_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Error names from `AbortSignal.timeout()` and fetch-level aborts. */
const RETRYABLE_NAMES = new Set(['AbortError', 'TimeoutError']);

function httpStatus(error: unknown): number | undefined {
  const response = (error as { response?: unknown } | null)?.response;
  const status =
    (response as { status?: unknown } | null)?.status ??
    (response as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Retry only what is worth retrying: rate limits, timeouts and server-side
 * failures. A `4xx` is the caller's mistake — repeating it wastes a round trip
 * and delays the real error — and a transaction rejected by the network
 * (`tx_bad_seq`, `op_no_destination`, …) is terminal, so re-sending it would
 * only produce the same rejection.
 */
export function isRetryableStellarError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) {
    return true;
  }

  if (error instanceof Error && RETRYABLE_NAMES.has(error.name)) {
    return true;
  }

  // `fetch` rejects with a bare TypeError when the connection fails outright.
  return error instanceof TypeError;
}

/**
 * Equal-jitter delay: half the exponential window, plus a random share of the
 * rest. Jitter keeps a fleet of workers from retrying in lockstep after an
 * outage, which is what turns a recovering node straight back over.
 */
function backoffDelay(attempt: number, config: RetryConfig): number {
  const window = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
  return Math.round(window / 2 + Math.random() * (window / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryContext {
  /** Observability hook — fired once per retry, before the delay. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable for tests, so the suite never waits on a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Run `operation`, retrying transient failures with exponential backoff. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_STELLAR_RETRY,
  context: RetryContext = {},
): Promise<T> {
  const wait = context.sleepImpl ?? sleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, config.maxAttempts); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === config.maxAttempts || !isRetryableStellarError(error)) {
        throw error;
      }

      const delayMs = backoffDelay(attempt, config);
      context.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs);
    }
  }

  // Unreachable while maxAttempts >= 1 — the loop either returns or throws.
  throw lastError;
}
