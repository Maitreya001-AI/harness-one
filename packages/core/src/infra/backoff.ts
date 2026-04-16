/**
 * Unified exponential backoff with jitter.
 *
 * Consolidates duplicated backoff/jitter patterns across adapter-caller,
 * self-healing, and agent-pool. All delay computation flows through
 * `computeBackoffMs` so timing is consistent, testable, and centralized.
 *
 * @module
 */

/** Configuration for a single backoff computation. */
export interface BackoffConfig {
  /** Base delay in milliseconds (default: 1000). */
  readonly baseMs?: number;
  /** Maximum capped delay in milliseconds (default: 10_000). */
  readonly maxMs?: number;
  /** Jitter fraction in [0, 1) added to the base delay (default: 0.5). */
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
 */
export function computeBackoffMs(attempt: number, config?: BackoffConfig): number {
  const baseMs = config?.baseMs ?? 1000;
  const maxMs = config?.maxMs ?? 10_000;
  const jitterFraction = config?.jitterFraction ?? 0.5;
  const random = config?.random ?? Math.random;

  const safeAttempt = Math.max(0, attempt);
  const exponential = Math.min(baseMs * Math.pow(2, safeAttempt), maxMs);
  const jitter = exponential * (1 - jitterFraction + random() * jitterFraction);
  return Math.floor(jitter);
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
