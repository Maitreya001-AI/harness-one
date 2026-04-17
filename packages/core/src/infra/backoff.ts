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
const MAX_MS_CEILING = 600_000;
/** Hard ceiling for `baseMs` (5 minutes). Values above this are rejected. */
const BASE_MS_CEILING = 300_000;

/**
 * Named jitter-fraction constants. Historically these were scattered as
 * bare `0.25` / `0.1` literals across the retry policy and agent pool; the
 * named exports make the intent readable and centralize the audit surface.
 *
 * `ADAPTER_RETRY_JITTER_FRACTION` (0.25) — fraction of the exponential
 * delay that is randomised on each adapter retry. Tuned low enough to
 * keep the backoff predictable for capacity planning while high enough
 * to de-synchronise concurrent clients hitting the same rate limit.
 *
 * `AGENT_POOL_IDLE_JITTER_FRACTION` (0.1) — fraction of the idle timeout
 * used to spread agent-pool reclamation timers. Kept smaller than the
 * retry fraction because pool reclamation is internal to a single
 * process, not a cross-client coordination problem.
 */
export const ADAPTER_RETRY_JITTER_FRACTION = 0.25;
export const AGENT_POOL_IDLE_JITTER_FRACTION = 0.1;

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
}

/**
 * Compute the backoff delay for a given attempt number (0-indexed).
 *
 * Formula: `min(baseMs * 2^attempt, maxMs) * (1 - jitterFraction + random() * jitterFraction)`
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
 *
 * @example
 * ```ts
 * const delay = computeBackoffMs(attempt, { baseMs: 500, maxMs: 30_000 });
 * ```
 */
export function computeBackoffMs(attempt: number, config?: BackoffConfig): number {
  const baseMs = config?.baseMs ?? 1000;
  const maxMs = config?.maxMs ?? 10_000;
  const jitterFraction = config?.jitterFraction ?? 0.5;
  const random = config?.random ?? Math.random;

  if (!Number.isFinite(maxMs) || maxMs < 0 || maxMs > MAX_MS_CEILING) {
    throw new HarnessError(
      `computeBackoffMs: maxMs must be in [0, ${MAX_MS_CEILING}] (got ${maxMs})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      `Cap retry delays to at most ${MAX_MS_CEILING}ms (10 minutes) to avoid starving the caller`,
    );
  }
  if (!Number.isFinite(baseMs) || baseMs < 0 || baseMs > BASE_MS_CEILING) {
    throw new HarnessError(
      `computeBackoffMs: baseMs must be in [0, ${BASE_MS_CEILING}] (got ${baseMs})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      `Keep baseMs under ${BASE_MS_CEILING}ms (5 minutes); larger values usually indicate a misconfigured retry loop`,
    );
  }
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction > 1) {
    throw new HarnessError(
      `computeBackoffMs: jitterFraction must be in [0, 1] (got ${jitterFraction})`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'jitterFraction represents the fraction of the exponential delay that is randomised; clamp it to [0, 1]',
    );
  }

  const safeAttempt = Math.max(0, attempt);
  const exponential = Math.min(baseMs * Math.pow(2, safeAttempt), maxMs);
  const jittered = exponential * (1 - jitterFraction + random() * jitterFraction);
  return Math.floor(jittered);
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
