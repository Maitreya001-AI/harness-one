/**
 * Unified exponential backoff with jitter.
 *
 * Consolidates duplicated backoff/jitter patterns across adapter-caller,
 * self-healing, and agent-pool. All delay computation flows through
 * `computeBackoffMs` so timing is consistent, testable, and centralized.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';

/** Hard ceiling for `maxMs` (10 minutes). Values above this are rejected. */
export const BACKOFF_MAX_MS_CEILING = 600_000;
/** Hard ceiling for `baseMs` (5 minutes). Values above this are rejected. */
export const BACKOFF_BASE_MS_CEILING = 300_000;
/** Default absolute jitter cap (30 seconds). */
export const BACKOFF_DEFAULT_ABS_JITTER_CAP_MS = 30_000;

/** Configuration for a single backoff computation. */
export interface BackoffConfig {
  /** Base delay in milliseconds (default: 1000). Must be in `[0, 300_000]`. */
  readonly baseMs?: number;
  /** Maximum capped delay in milliseconds (default: 10_000). Must be in `[0, 600_000]`. */
  readonly maxMs?: number;
  /** Jitter fraction in [0, 1] added to the base delay (default: 0.5). */
  readonly jitterFraction?: number;
  /**
   * Optional random source for deterministic testing.
   * Returns a value in [0, 1). Default: Math.random.
   */
  readonly random?: () => number;
  /**
   * Wave-13 A-2: Optional absolute cap on the additive jitter component.
   *
   * When provided, the final returned delay is clamped to
   * `min(exponential + maxAbsoluteJitterMs, maxMs)`. This prevents jitter
   * from pushing the total delay close to `maxMs` when the exponential
   * component is already near the cap — useful for retry paths where
   * bounded worst-case tail latency matters more than uniform spread.
   *
   * Default: unset (legacy proportional-jitter behavior, bounded only by
   * `maxMs`).
   */
  readonly maxAbsoluteJitterMs?: number;
}

/**
 * Compute the backoff delay for a given attempt number (0-indexed).
 *
 * Formula: `min(baseMs * 2^attempt, maxMs) * (1 - jitterFraction + random() * jitterFraction)`
 *
 * When `maxAbsoluteJitterMs` is supplied, the final value is additionally
 * clamped to `min(exponential + maxAbsoluteJitterMs, maxMs)`.
 *
 * @param attempt - Zero-based attempt index (0 = first retry).
 * @param config - Optional tuning parameters.
 * @returns Delay in milliseconds.
 * @throws {HarnessError} with code `CORE_INVALID_CONFIG` when any of the
 *   following hold:
 *   - `maxMs > 600_000` (10 minute ceiling)
 *   - `baseMs > 300_000` (5 minute ceiling)
 *   - `jitterFraction` is not in `[0, 1]`
 *   - `baseMs < 0` or `maxMs < 0`
 *   - `maxAbsoluteJitterMs < 0`
 *
 * @example Basic usage (proportional jitter, default behavior)
 * ```ts
 * const delay = computeBackoffMs(attempt, { baseMs: 500, maxMs: 30_000 });
 * ```
 *
 * @example Wave-13 A-2 — absolute jitter cap
 * ```ts
 * // Guarantees total delay never exceeds `exponential + 5s`, even when
 * // `maxMs` is generous. Useful for user-facing retries.
 * const delay = computeBackoffMs(attempt, {
 *   baseMs: 1_000,
 *   maxMs: 60_000,
 *   jitterFraction: 0.5,
 *   maxAbsoluteJitterMs: 5_000,
 * });
 * ```
 */
export function computeBackoffMs(attempt: number, config?: BackoffConfig): number {
  const baseMs = config?.baseMs ?? 1000;
  const maxMs = config?.maxMs ?? 10_000;
  const jitterFraction = config?.jitterFraction ?? 0.5;
  const random = config?.random ?? Math.random;
  const maxAbsoluteJitterMs = config?.maxAbsoluteJitterMs;

  // Wave-13 A-3: Validate configuration ceilings.
  if (!Number.isFinite(maxMs) || maxMs < 0 || maxMs > BACKOFF_MAX_MS_CEILING) {
    throw new HarnessError(
      `computeBackoffMs: maxMs must be in [0, ${BACKOFF_MAX_MS_CEILING}] (got ${maxMs})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      `Cap retry delays to at most ${BACKOFF_MAX_MS_CEILING}ms (10 minutes) to avoid starving the caller`,
    );
  }
  if (!Number.isFinite(baseMs) || baseMs < 0 || baseMs > BACKOFF_BASE_MS_CEILING) {
    throw new HarnessError(
      `computeBackoffMs: baseMs must be in [0, ${BACKOFF_BASE_MS_CEILING}] (got ${baseMs})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      `Keep baseMs under ${BACKOFF_BASE_MS_CEILING}ms (5 minutes); larger values usually indicate a misconfigured retry loop`,
    );
  }
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction > 1) {
    throw new HarnessError(
      `computeBackoffMs: jitterFraction must be in [0, 1] (got ${jitterFraction})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'jitterFraction represents the fraction of the exponential delay that is randomised; clamp it to [0, 1]',
    );
  }
  if (
    maxAbsoluteJitterMs !== undefined &&
    (!Number.isFinite(maxAbsoluteJitterMs) || maxAbsoluteJitterMs < 0)
  ) {
    throw new HarnessError(
      `computeBackoffMs: maxAbsoluteJitterMs must be a non-negative finite number (got ${maxAbsoluteJitterMs})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'maxAbsoluteJitterMs caps additive jitter above the exponential floor; pass a non-negative value or omit the field',
    );
  }

  const safeAttempt = Math.max(0, attempt);
  const exponential = Math.min(baseMs * Math.pow(2, safeAttempt), maxMs);
  const jittered = exponential * (1 - jitterFraction + random() * jitterFraction);

  // Wave-13 A-2: When an absolute jitter cap is supplied, clamp the final
  // value to `min(exponential + cap, maxMs)`. We anchor the clamp at
  // `exponential * (1 - jitterFraction)` (the minimum of the proportional
  // jitter band) so the lower bound is preserved while the upper bound
  // shrinks. In practice this just means: never exceed exponential + cap.
  let result: number;
  if (maxAbsoluteJitterMs !== undefined) {
    const floor = exponential * (1 - jitterFraction);
    const ceiling = Math.min(exponential + maxAbsoluteJitterMs, maxMs);
    // jittered lies in [floor, exponential]; clamp high end to ceiling.
    const bounded = Math.min(Math.max(jittered, floor), ceiling);
    result = bounded;
  } else {
    result = jittered;
  }
  return Math.floor(result);
}

/**
 * Compute a random additive jitter in `[0, baseMs * fraction)`.
 *
 * Useful for spreading timers (idle timeouts, GC intervals) to avoid
 * thundering-herd effects without the exponential scaling of
 * {@link computeBackoffMs}.
 *
 * @param baseMs - The base delay to jitter around.
 * @param fraction - Maximum jitter as a fraction of `baseMs` (default: 0.1 → 10%).
 * @param random - Optional random source for deterministic testing.
 * @returns Jitter offset in milliseconds (always >= 0).
 */
export function computeJitterMs(
  baseMs: number,
  fraction = 0.1,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * fraction * baseMs);
}
