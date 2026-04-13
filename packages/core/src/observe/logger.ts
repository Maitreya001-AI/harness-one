/**
 * Structured logger for harness-one.
 *
 * Supports JSON and human-readable output, log levels,
 * and child loggers with inherited metadata.
 *
 * @module
 */

import {
  createRedactor,
  sanitizeAttributes,
  type RedactConfig,
  type Redactor,
} from '../_internal/redact.js';

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
  /**
   * SEC-001: Secret redaction. When set, every metadata object passed through
   * the logger is scrubbed before serialization (API keys, tokens, passwords,
   * cookies, etc.). Defaults to undefined (no redaction). Provide an empty
   * object `{}` to enable default-pattern redaction without extra keys.
   */
  readonly redact?: RedactConfig;
  /**
   * OBS-001: Correlation ID automatically injected into every log record
   * under the `correlationId` field. Useful for linking logs to a request or
   * trace. Propagates to child loggers via normal baseMeta merging.
   */
  readonly correlationId?: string;
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
  // eslint-disable-next-line no-console -- library fallback when no output provided
  const output = config?.output ?? console.log;
  // SEC-001: Build the redactor once at logger creation. `undefined` means
  // no redaction; pass `{}` to enable default pattern only.
  const redactor: Redactor | undefined = config?.redact
    ? createRedactor(config.redact)
    : undefined;
  const correlationId = config?.correlationId;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[minLevel];
  }

  function createLoggerWithMeta(baseMeta: Record<string, unknown>): Logger {
    function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
      if (!shouldLog(level)) return;
      // OBS-001: Inject correlationId (if configured) before redaction so it
      // survives as-is — unless the caller intentionally overrides it in meta.
      const merged: Record<string, unknown> = {
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...baseMeta,
        ...meta,
      };
      // SEC-001: Scrub sensitive keys FIRST. Runs before the replacer so keys
      // like `api_key` are replaced even if the value is a Date/Error/circular.
      const safeMerged = redactor ? sanitizeAttributes(merged, redactor) : merged;
      // Fix 10: Store as epoch millis, format only at output time
      const epochMs = Date.now();
      const timestamp = new Date(epochMs).toISOString();
      // Fix 9 + PERF-014: Use safe replacer for Error/Date/circular handling,
      // and pre-stringify once so JSON and text modes share work.
      const replacer = createSafeReplacer();
      if (json) {
        output(JSON.stringify({ level, message, timestamp, ...safeMerged }, replacer));
      } else {
        const metaKeys = Object.keys(safeMerged);
        const suffix = metaKeys.length > 0 ? ' ' + JSON.stringify(safeMerged, replacer) : '';
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
