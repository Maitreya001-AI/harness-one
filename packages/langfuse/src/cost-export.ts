/**
 * Export-health plumbing for the Langfuse cost tracker.
 *
 * Wave-16 M2 extraction. Owns:
 *
 *   - the `handleExportError` fan-out (onExportError → logger.error →
 *     safeWarn fallback),
 *   - the `pendingFlushes` set that `recordUsage` feeds after every
 *     `client.flushAsync()` call,
 *   - the bounded `dispose()` drain.
 *
 * The tracker reaches into this handle only through the returned
 * primitives; no closure state leaks in either direction.
 *
 * @module
 * @internal
 */

import type { Logger } from 'harness-one/observe';
import { safeWarn } from 'harness-one/observe';

export type ExportOp = 'flush' | 'record';

export interface ExportHealthConfig {
  readonly onExportError?: (
    err: unknown,
    context: { op: ExportOp; details?: unknown },
  ) => void;
  readonly logger?: Logger;
}

export interface ExportHealth {
  /** Route an error through the configured sink; never throws. */
  handleExportError(err: unknown, op: ExportOp, details?: unknown): void;
  /**
   * Register a promise returned by `client.flushAsync()` so `dispose()` can
   * wait for it. The returned promise is the same promise you passed in —
   * the helper just hooks up tracking.
   */
  trackFlush<T>(p: Promise<T>): Promise<T>;
  /** Count of `flush` operations that landed in `handleExportError`. */
  getFlushErrors(): number;
  /** Reset counters (called from tracker `reset()`). */
  reset(): void;
  /**
   * Wait up to `timeoutMs` for every tracked flush to settle. Rejections
   * are already routed through `handleExportError` (via `trackFlush`), so
   * this helper does not surface them. Safe to call multiple times.
   */
  dispose(timeoutMs: number): Promise<void>;
}

export function createExportHealth(config: ExportHealthConfig): ExportHealth {
  const { onExportError, logger } = config;
  const pendingFlushes = new Set<Promise<unknown>>();
  let flushErrors = 0;

  function handleExportError(err: unknown, op: ExportOp, details?: unknown): void {
    if (op === 'flush') flushErrors++;
    if (onExportError) {
      try {
        onExportError(err, { op, details });
      } catch {
        // Never let a user callback break the record path.
      }
      return;
    }
    if (logger) {
      logger.error('[harness-one/langfuse] export error', {
        op,
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        ...(details !== undefined ? { details } : {}),
      });
      return;
    }
    // Wave-5F T13: route final fallback through safeWarn (redaction-enabled).
    safeWarn(undefined, `[harness-one/langfuse] ${op} error`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  function trackFlush<T>(p: Promise<T>): Promise<T> {
    // Match the pre-split fire-and-forget shape exactly: rejections are
    // routed through `handleExportError` and swallowed so the tracked
    // promise resolves rather than leaking as an unhandled rejection.
    // Returning `tracked` (not the original `p`) preserves the previous
    // behaviour where the caller just `add`s + `finally`s.
    const tracked = p.catch((err: unknown) => {
      try {
        handleExportError(err, 'flush');
      } catch {
        // Defensive: never let a user logger break the pending-flush machinery.
      }
    });
    pendingFlushes.add(tracked);
    tracked.finally(() => {
      pendingFlushes.delete(tracked);
    });
    return tracked as Promise<T>;
  }

  async function dispose(timeoutMs: number): Promise<void> {
    if (pendingFlushes.size === 0) return;
    const snapshot = Array.from(pendingFlushes);
    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timerHandle = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    try {
      await Promise.race([
        Promise.allSettled(snapshot).then(() => undefined),
        timeout,
      ]);
    } finally {
      if (timerHandle !== undefined) clearTimeout(timerHandle);
    }
  }

  return {
    handleExportError,
    trackFlush,
    getFlushErrors: () => flushErrors,
    reset(): void {
      flushErrors = 0;
    },
    dispose,
  };
}
