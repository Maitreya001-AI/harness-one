/**
 * Abortable timeout — unified Promise.race + AbortSignal + setTimeout helper.
 *
 * Consolidates the 4 duplicated patterns across adapter-caller, self-healing,
 * admission-controller, and output-parser into a single reusable primitive.
 * Guarantees cleanup of both the timer AND the abort listener on every
 * resolution path (success, timeout, abort, or caller-thrown error).
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';

/**
 * Run `fn` with an optional timeout and AbortSignal.
 *
 * - If `fn` resolves first, the timer is cleared and the result is returned.
 * - If the timeout fires first, `fn`'s result is ignored and a HarnessError
 *   with `CORE_TIMEOUT` is thrown.
 * - If `signal` is aborted, a HarnessError with `CORE_ABORTED` is thrown.
 * - On any path, both the timer and the abort listener are cleaned up in a
 *   `finally` block.
 *
 * @example
 * ```ts
 * const result = await withAbortableTimeout(
 *   () => fetch(url),
 *   { timeoutMs: 5000, signal: controller.signal },
 * );
 * ```
 */
export async function withAbortableTimeout<T>(
  fn: () => Promise<T>,
  options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /** Custom message for timeout errors. */
    readonly timeoutMessage?: string;
    /** Custom message for abort errors. */
    readonly abortMessage?: string;
  },
): Promise<T> {
  const timeoutMs = options?.timeoutMs;
  const signal = options?.signal;

  // Fast path: no timeout and no signal — just run.
  if (timeoutMs === undefined && !signal) {
    return fn();
  }

  // Pre-check: already aborted?
  if (signal?.aborted) {
    throw new HarnessError(
      options?.abortMessage ?? 'Operation aborted',
      HarnessErrorCode.CORE_ABORTED,
      'The AbortSignal was already aborted before the operation started',
    );
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const promises: Promise<T>[] = [fn()];

    if (timeoutMs !== undefined) {
      promises.push(
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new HarnessError(
                options?.timeoutMessage ?? `Operation timed out after ${timeoutMs}ms`,
                HarnessErrorCode.CORE_TIMEOUT,
                'Increase the timeout or optimize the operation',
              ),
            );
          }, timeoutMs);
        }),
      );
    }

    if (signal) {
      promises.push(
        new Promise<never>((_, reject) => {
          onAbort = () => {
            reject(
              new HarnessError(
                options?.abortMessage ?? 'Operation aborted',
                HarnessErrorCode.CORE_ABORTED,
                'The AbortSignal fired during the operation',
              ),
            );
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }

    return await Promise.race(promises);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && onAbort) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Non-fatal: polyfill or disposed signal may throw.
      }
    }
  }
}
