/**
 * Injectable wall-clock port.
 *
 * `Date.now()` is a hidden, process-wide dependency: any kernel code that
 * calls it directly (duration budgets, memory TTL expiry, checkpoint
 * timestamps) becomes untestable without fake timers, and its behaviour
 * cannot be varied per-instance. {@link Clock} is the seam — a one-method
 * port that the kernel threads through its factories so tests can advance
 * time deterministically and consumers can supply a virtual clock.
 *
 * L1 leaf: this module imports nothing upward (ESLint-enforced). Keep it
 * dependency-free so every layer can consume it.
 *
 * @module
 */

/**
 * A source of the current epoch time in milliseconds.
 *
 * The single method mirrors `Date.now()` so {@link systemClock} is a
 * zero-overhead default. Inject a custom implementation to make
 * time-dependent logic (budgets, TTL, timestamps) deterministic under test.
 *
 * @example
 * ```ts
 * let t = 1_000;
 * const fakeClock: Clock = { now: () => t };
 * // advance virtual time without real waiting:
 * t += 5_000;
 * ```
 */
export interface Clock {
  /** Current time in epoch milliseconds. Contract mirrors `Date.now()`. */
  now(): number;
}

/**
 * Default {@link Clock} backed by the platform `Date.now()`. Used everywhere
 * a `clock` is not explicitly injected, so the default runtime behaviour is
 * byte-for-byte identical to the pre-injection code.
 */
export const systemClock: Clock = { now: () => Date.now() };
