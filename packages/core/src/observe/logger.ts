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
 * Custom JSON replacer that handles Error objects, Date objects, and
 * circular references for safe serialization of meta objects.
 *
 * - Error objects are serialized as `{ name, message, stack }`.
 * - Date objects are serialized as ISO 8601 strings.
 * - Circular references are replaced with the string `"[Circular]"`.
 */
export function createSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

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
      // Fix 10: Store as epoch millis, format only at output time
      const epochMs = Date.now();
      // Fix 9: Use safe replacer for Error, Date, and circular reference handling
      const replacer = createSafeReplacer();
      const timestamp = new Date(epochMs).toISOString();
      if (json) {
        output(JSON.stringify({ level, message, timestamp, ...merged }, replacer));
      } else {
        const metaKeys = Object.keys(merged);
        const suffix = metaKeys.length > 0 ? ' ' + JSON.stringify(merged, replacer) : '';
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
