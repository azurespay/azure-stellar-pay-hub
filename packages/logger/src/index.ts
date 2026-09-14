import pino, { type LoggerOptions } from 'pino';

/** Stable logger contract across pino versions. */
export interface Logger {
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Only an explicit `development` (or unset `NODE_ENV`) gets the human-readable
 * pretty transport. `NODE_ENV=test` deliberately does not: the transport starts
 * a pino-pretty worker thread, so treating test as development spun one up in
 * every consumer's Jest run for no benefit.
 */
const nodeEnv = process.env.NODE_ENV ?? 'development';
const isDevelopment = nodeEnv === 'development';

function buildOptions(name: string): LoggerOptions {
  return {
    name,
    level: process.env.LOG_LEVEL ?? (isDevelopment ? 'debug' : 'info'),
    base: { service: name },
    ...(isDevelopment
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

/**
 * Create a structured logger bound to a service/package name.
 * Human-readable output in development, JSON in production.
 */
export function createLogger(name: string): Logger {
  return pino(buildOptions(name)) as unknown as Logger;
}

/** Default root logger. */
export const logger: Logger = createLogger('stellar-pay');
