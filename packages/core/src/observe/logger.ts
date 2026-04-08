/**
 * Structured logger for harness-one.
 *
 * Supports JSON and human-readable output, log levels,
 * and child loggers with inherited metadata.
 *
 * @module
 */

/** Supported log levels, ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logger interface. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Create a child logger that inherits and extends base metadata. */
  child(meta: Record<string, unknown>): Logger;
}

/** Configuration for the logger factory. */
export interface LoggerConfig {
  /** Minimum log level. Default: 'info'. */
  readonly level?: LogLevel;
  /** Output as JSON lines. Default: false. */
  readonly json?: boolean;
  /** Custom output function. Default: console.log. */
  readonly output?: (line: string) => void;
}

const LOG_LEVEL_VALUES: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Creates a structured logger.
 *
 * @example
 * ```ts
 * const logger = createLogger({ level: 'debug', json: true });
 * logger.info('server started', { port: 3000 });
 * const childLogger = logger.child({ requestId: 'abc' });
 * childLogger.debug('handling request');
 * ```
 */
export function createLogger(config?: LoggerConfig): Logger {
  const minLevel = config?.level ?? 'info';
  const json = config?.json ?? false;
  const output = config?.output ?? console.log;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[minLevel];
  }

  function createLoggerWithMeta(baseMeta: Record<string, unknown>): Logger {
    function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
      if (!shouldLog(level)) return;
      const merged = { ...baseMeta, ...meta };
      const timestamp = new Date().toISOString();
      if (json) {
        output(JSON.stringify({ level, message, timestamp, ...merged }));
      } else {
        const metaKeys = Object.keys(merged);
        const suffix = metaKeys.length > 0 ? ' ' + JSON.stringify(merged) : '';
        output(`[${timestamp}] ${level.toUpperCase()} ${message}${suffix}`);
      }
    }

    return {
      debug: (msg, meta) => log('debug', msg, meta),
      info: (msg, meta) => log('info', msg, meta),
      warn: (msg, meta) => log('warn', msg, meta),
      error: (msg, meta) => log('error', msg, meta),
      child: (meta) => createLoggerWithMeta({ ...baseMeta, ...meta }),
    };
  }

  return createLoggerWithMeta({});
}
