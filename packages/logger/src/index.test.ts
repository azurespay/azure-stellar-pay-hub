import { afterEach, describe, expect, it } from '@jest/globals';

type LoggerModule = typeof import('./index');

const ORIGINAL_ENV = { ...process.env };

/**
 * The module reads `NODE_ENV` at import time to decide between the pretty
 * development transport and JSON output, so each case reloads it with the
 * environment it wants to assert on.
 */
function loadModule(): LoggerModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./index') as LoggerModule;
}

/** The public contract is deliberately minimal, so read pino's level via a cast. */
function levelOf(logger: unknown): string {
  return (logger as { level: string }).level;
}

function withEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Capture what a logger actually writes to stdout and return it as records.
 *
 * pino writes synchronously in this configuration (no pretty transport outside
 * development), so the lines are complete by the time the callback returns.
 */
function captureJsonLines(run: () => void): Array<Record<string, unknown>> {
  const original = process.stdout.write.bind(process.stdout);
  let written = '';
  process.stdout.write = ((chunk: unknown) => {
    written += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return written
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createLogger', () => {
  it('returns the documented logger contract', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;

    const { createLogger } = loadModule();
    const logger = createLogger('svc');

    for (const method of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'child']) {
      expect(typeof (logger as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('binds the service name, so log lines are attributable', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;

    const { createLogger } = loadModule();
    const logger = createLogger('api') as unknown as { bindings(): Record<string, unknown> };

    expect(logger.bindings().service).toBe('api');
  });

  it('returns a logger with the same contract from child()', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;

    const { createLogger } = loadModule();
    const child = createLogger('svc').child({ requestId: 'abc' });

    expect(typeof child.info).toBe('function');
    expect(typeof child.child).toBe('function');
  });
});

describe('log level selection', () => {
  it('defaults to debug in development', () => {
    withEnv({ NODE_ENV: 'development', LOG_LEVEL: undefined });

    const { createLogger } = loadModule();

    expect(levelOf(createLogger('svc'))).toBe('debug');
  });

  it('defaults to info in production', () => {
    withEnv({ NODE_ENV: 'production', LOG_LEVEL: undefined });

    const { createLogger } = loadModule();

    expect(levelOf(createLogger('svc'))).toBe('info');
  });

  it('defaults to info in test, so test runs are not chatty', () => {
    // Regression guard: `test` used to be lumped in with `development`, which
    // both lowered the level to debug and started a pino-pretty worker thread
    // in every consumer's Jest run.
    withEnv({ NODE_ENV: 'test', LOG_LEVEL: undefined });

    const { createLogger } = loadModule();

    expect(levelOf(createLogger('svc'))).toBe('info');
  });

  it('lets LOG_LEVEL override the environment default', () => {
    withEnv({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });

    const { createLogger } = loadModule();

    expect(levelOf(createLogger('svc'))).toBe('warn');
  });
});

describe('log output', () => {
  it('writes one JSON record per call, carrying the level, message and service', () => {
    withEnv({ NODE_ENV: 'production', LOG_LEVEL: undefined });
    const { createLogger } = loadModule();

    const records = captureJsonLines(() => createLogger('api').info('payment created'));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 30, service: 'api', msg: 'payment created' });
  });

  it('emits the levels at or above the threshold and suppresses the ones below', () => {
    // NODE_ENV=production defaults the threshold to `info`.
    withEnv({ NODE_ENV: 'production', LOG_LEVEL: undefined });
    const { createLogger } = loadModule();
    const logger = createLogger('api');

    const records = captureJsonLines(() => {
      logger.fatal('fatal');
      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug');
      logger.trace('trace');
    });

    // pino levels: fatal 60, error 50, warn 40, info 30, debug 20, trace 10.
    expect(records.map((record) => record.level)).toEqual([60, 50, 40, 30]);
    expect(records.map((record) => record.msg)).toEqual(['fatal', 'error', 'warn', 'info']);
  });

  it('lowers the threshold to debug when LOG_LEVEL asks for it', () => {
    withEnv({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
    const { createLogger } = loadModule();
    const logger = createLogger('api');

    const records = captureJsonLines(() => {
      logger.debug('shown');
      logger.trace('still below the threshold');
    });

    expect(records.map((record) => record.msg)).toEqual(['shown']);
  });

  it('includes the child bindings in the emitted record', () => {
    withEnv({ NODE_ENV: 'production', LOG_LEVEL: undefined });
    const { createLogger } = loadModule();

    const records = captureJsonLines(() =>
      createLogger('api').child({ requestId: 'abc' }).info('handled'),
    );

    expect(records[0]).toMatchObject({ service: 'api', requestId: 'abc', msg: 'handled' });
  });
});
