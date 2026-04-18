/**
 * Safe logging primitive.
 *
 * Provides a lazily-constructed, redaction-enabled default `Logger` plus
 * `safeWarn`/`safeError` helpers that tolerate an optional user-supplied
 * logger. This eliminates the `logger ?? console.warn` boilerplate that
 * previously appeared across adapters and presets.
 *
 * @module
 */

import { createLogger, type Logger } from './logger.js';

let cachedDefaultLogger: Logger | undefined;

/**
 * Returns a process-wide, lazily-initialized `Logger` that always redacts
 * common secret keys (api_key, token, password, cookie, etc.) and writes to
 * `console.log`. Suitable as a fallback when the caller has no logger.
 */
export function createDefaultLogger(): Logger {
  if (cachedDefaultLogger === undefined) {
    // SEC-001: `redact: {}` enables the default secret pattern (useDefaultPattern
    // defaults to true in createRedactor). Keep level at the createLogger default
    // ('info') so warn/error are always emitted.
    // Wrap console.log in an arrow so the logger honors later re-assignments or
    // test spies on the global console, rather than capturing a stale reference
    // at singleton creation time.
    cachedDefaultLogger = createLogger({
      redact: {},
      // eslint-disable-next-line no-console -- intentional fallback sink
      output: (line) => console.log(line),
    });
  }
  return cachedDefaultLogger;
}

/**
 * Level-gate probe used by adapter hot paths before allocating warn-level
 * metadata. Returns `true` when the logger either exposes no probe
 * (historical behaviour — always log) or reports that warn is active.
 *
 * Centralised here so both `@harness-one/anthropic` and `@harness-one/openai`
 * share the same definition — earlier waves duplicated the probe inline.
 */
export function isWarnActive(
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
): boolean {
  if (!logger) return true;
  const probe = (logger as { isWarnEnabled?: () => boolean }).isWarnEnabled;
  return typeof probe === 'function' ? probe.call(logger) : true;
}

/**
 * Emits a warn-level record using the provided logger, falling back to the
 * redaction-enabled default logger when none is supplied.
 */
export function safeWarn(
  logger: Logger | undefined,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const target = logger ?? createDefaultLogger();
  target.warn(msg, meta);
}

/**
 * Emits an error-level record using the provided logger, falling back to the
 * redaction-enabled default logger when none is supplied.
 */
export function safeError(
  logger: Logger | undefined,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const target = logger ?? createDefaultLogger();
  target.error(msg, meta);
}
