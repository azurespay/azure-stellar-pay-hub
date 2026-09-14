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
