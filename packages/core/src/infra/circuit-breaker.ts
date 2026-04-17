/**
 * Circuit breaker — prevents cascading failures when an upstream service
 * (typically an LLM provider) is persistently failing.
 *
 * State machine:
 *   CLOSED  → errors accumulate; trips to OPEN after `failureThreshold` failures.
 *   OPEN    → fast-fail all calls; transitions to HALF_OPEN after `resetTimeoutMs`.
 *   HALF_OPEN → allows one probe call; success → CLOSED, failure → OPEN.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';

/** Circuit breaker states. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures before the circuit trips to OPEN.
   * Default: 5.
   */
  readonly failureThreshold?: number;
  /**
   * Time in ms to wait before transitioning from OPEN to HALF_OPEN.
   * Default: 30_000 (30 seconds).
   */
  readonly resetTimeoutMs?: number;
  /**
   * Optional callback invoked on state transitions. Useful for logging
   * or metrics without coupling to a specific logger.
   *
   * Wave-13 Obs-P0-3: callback now receives a `context` object carrying
   * the failure count and (when available) the failing error so operators
   * can correlate trips to upstream incidents without instrumenting the
   * caller. The context is `undefined` for transitions not driven by a
   * failure (e.g. lazy `open → half_open` on read).
   */
  readonly onStateChange?: (
    from: CircuitState,
    to: CircuitState,
    context?: CircuitStateChangeContext,
  ) => void;
}

/**
 * Context attached to {@link CircuitBreakerConfig.onStateChange} when the
 * transition is failure-driven. Wave-13 Obs-P0-3.
 */
export interface CircuitStateChangeContext {
  readonly consecutiveFailures: number;
  readonly lastFailureError?: Error;
  readonly lastFailureTimeMs?: number;
}

/** Public surface of the circuit breaker. */
export interface CircuitBreaker {
  /** Current state of the circuit. */
  readonly state: () => CircuitState;
  /**
   * Execute `fn` through the circuit breaker. Throws `CircuitOpenError`
   * when the circuit is OPEN. In HALF_OPEN, only one probe runs at a time.
   */
  readonly execute: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Record an external success (e.g. from a path that bypasses execute). */
  readonly recordSuccess: () => void;
  /** Record an external failure (e.g. from a path that bypasses execute). */
  readonly recordFailure: () => void;
  /** Force-reset to CLOSED state. Useful for manual intervention. */
  readonly reset: () => void;
}

/**
 * Error thrown when attempting to call through an open circuit.
 *
 * Wave-13 A-1: extends {@link HarnessError} with code
 * {@link HarnessErrorCode.ADAPTER_CIRCUIT_OPEN} so the circuit-breaker
 * failure participates in the canonical error taxonomy. Code paths that
 * key on `error.code` (retry policies, alerting heuristics) now classify
 * circuit-breaker rejections uniformly with other adapter errors.
 *
 * The class name is preserved for backwards compatibility with any test
 * that uses `instanceof CircuitOpenError`, and `instanceof HarnessError`
 * now also matches.
 */
export class CircuitOpenError extends HarnessError {
  constructor(message?: string) {
    super(
      message ?? 'Circuit breaker is OPEN — fast-failing to prevent cascade',
      HarnessErrorCode.ADAPTER_CIRCUIT_OPEN,
      'Wait for the breaker to enter HALF_OPEN; reduce upstream pressure or fix the root cause.',
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * Create a circuit breaker.
 *
 * @example
 * ```ts
 * const cb = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10_000 });
 * const result = await cb.execute(() => adapter.chat(params));
 * ```
 */
export function createCircuitBreaker(config?: CircuitBreakerConfig): CircuitBreaker {
  const failureThreshold = config?.failureThreshold ?? 5;
  const resetTimeoutMs = config?.resetTimeoutMs ?? 30_000;
  const onStateChange = config?.onStateChange;

  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new HarnessError(
      'failureThreshold must be a positive integer',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive integer for failureThreshold (e.g. 5)',
    );
  }
  if (!Number.isFinite(resetTimeoutMs) || resetTimeoutMs < 1) {
    throw new HarnessError(
      'resetTimeoutMs must be a positive number',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive number for resetTimeoutMs (e.g. 30000)',
    );
  }

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let lastFailureTime = 0;
  /** Wave-13 Obs-P0-3: captured so onStateChange can surface the root cause. */
  let lastFailureError: Error | undefined;
  /**
   * P0-5 (Wave-12): Promise-based single-slot mutex guarding the half-open
   * probe slot. Prior flag-based guard had a check/set interleaving window
   * where two probes could both observe `false`, both flip it to `true`, and
   * their success/failure paths could clobber `consecutiveFailures`.
   *
   * With a Promise slot, the claim is atomic (read-then-assign on the single
   * event-loop turn), and concurrent `execute()` calls that lose the race
   * see a non-null value and fast-fail via `CircuitOpenError`. The slot is
   * released in BOTH success and failure paths so the breaker can't wedge.
   */
  let halfOpenProbe: Promise<unknown> | null = null;

  function transition(next: CircuitState, context?: CircuitStateChangeContext): void {
    if (state === next) return;
    const prev = state;
    state = next;
    try { onStateChange?.(prev, next, context); } catch { /* intentionally swallowed — monitoring callbacks must not break state transitions */ }
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    lastFailureError = undefined;
    halfOpenProbe = null;
    if (state !== 'closed') transition('closed');
  }

  function recordFailure(err?: Error): void {
    consecutiveFailures++;
    lastFailureTime = Date.now();
    if (err !== undefined) lastFailureError = err;
    halfOpenProbe = null;
    if (state === 'half_open' || consecutiveFailures >= failureThreshold) {
      const context: CircuitStateChangeContext = {
        consecutiveFailures,
        lastFailureTimeMs: lastFailureTime,
        ...(lastFailureError !== undefined ? { lastFailureError } : {}),
      };
      transition('open', context);
    }
  }

  function shouldAttemptReset(): boolean {
    return state === 'open' && Date.now() - lastFailureTime >= resetTimeoutMs;
  }

  return {
    state: () => {
      // Lazily transition to half_open on read when the reset timeout has elapsed.
      if (shouldAttemptReset()) transition('half_open');
      return state;
    },

    async execute<T>(fn: () => Promise<T>): Promise<T> {
      // Check for lazy transition to half_open.
      if (shouldAttemptReset()) transition('half_open');

      if (state === 'open') {
        throw new CircuitOpenError();
      }

      // P0-5: Atomic claim of the half-open probe slot. Reading + writing
      // `halfOpenProbe` happens within a single synchronous tick so no two
      // callers can both observe a null slot and both claim it.
      let releaseProbe: (() => void) | null = null;
      if (state === 'half_open') {
        if (halfOpenProbe !== null) {
          // Another caller holds the probe — fast-fail without touching state.
          throw new CircuitOpenError('Circuit is HALF_OPEN — probe in flight');
        }
        // Install a sentinel promise so concurrent callers see the slot taken.
        // The sentinel is resolved on both success and failure paths below.
        halfOpenProbe = new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
      }

      try {
        const result = await fn();
        recordSuccess();
        return result;
      } catch (err) {
        recordFailure(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        // Ensure the sentinel is resolved so any Promise-awaiting callers
        // (if introduced later) unblock. recordSuccess/recordFailure already
        // cleared `halfOpenProbe`, so the release is purely for observers of
        // the sentinel itself.
        if (releaseProbe !== null) (releaseProbe as () => void)();
      }
    },

    recordSuccess,
    recordFailure,
    reset: () => {
      consecutiveFailures = 0;
      halfOpenProbe = null;
      transition('closed');
    },
  };
}
