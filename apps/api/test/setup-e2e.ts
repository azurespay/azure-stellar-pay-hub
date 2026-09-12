import Redis from 'ioredis';

/**
 * Redis state (rate-limit counters, auth challenges, job locks) outlives the
 * Jest process, and every e2e suite shares one Redis instance. The security
 * suite deliberately exhausts the `/auth/challenge` budget, so without a reset
 * the next suite — or a second local run — can start already throttled and
 * report failures that have nothing to do with the code under test.
 *
 * Flush the database before each e2e file so every suite begins from a clean
 * slice. This runs against the disposable test Redis from `pnpm docker:up`
 * (or the CI service container), addressed by the same `REDIS_URL` the API
 * uses. The client is closed afterwards so Jest has no open handle keeping it
 * alive.
 */
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

let client: Redis | undefined;

beforeAll(async () => {
  client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });
  try {
    await client.connect();
    await client.flushdb();
  } catch (err) {
    throw new Error(
      `Could not reset Redis at ${redisUrl} before this e2e suite. Start the test ` +
        `stack with \`pnpm docker:up\` (or point REDIS_URL at one) and retry. ` +
        `Cause: ${(err as Error).message}`,
    );
  }
});

afterAll(async () => {
  await client?.quit().catch(() => undefined);
  client = undefined;
});
