/**
 * Retry policy / resilience policy — pulls the three resilience primitives
 * the adapter caller needed (backoff sleep, circuit-breaker gate,
 * retryable-error classification) out of `adapter-caller.ts` so the caller
 * stops owning policy concerns.
 *
 * Each exported helper is pure with respect to the adapter path:
 *
 *   - {@link scheduleBackoff}: computes the delay, returns a promise that
 *     rejects on abort, preserves the `unref()` discipline, and tells the
 *     caller how long the sleep will (or did) last.
 *   - {@link isRetryableCategory}: O(1) membership check over the configured
 *     retryable error categories.
 *   - {@link checkCircuitOpen}: reads the breaker state and returns a
 *     ready-to-return `AdapterCallFail` when OPEN, else `undefined`.
 *
 * The policy object itself is a thin struct wired once by
 * `createAdapterCaller` and passed around as a dependency — makes the
 * adapter caller code read as "ask the policy, then dispatch" instead of
 * 40 LOC of backoff timer housekeeping inline.
 *
 * Wave-15 clarified that {@link RetryPolicy} IS the composed
 * "circuit-breaker + retry" primitive; {@link ResiliencePolicy} is an
 * alias documenting that intent so future extensions (bulkhead, fallback,
 * rate-limiter) have a clear landing spot.
 *
 * Composition contract:
 *   1. `checkCircuitOpen()` gates the retry decision. When OPEN the caller
 *      fast-fails without consulting `scheduleBackoff()`.
 *   2. For a retryable error in CLOSED state, the caller uses
 *      `scheduleBackoff()` to sleep before the next attempt.
 *   3. `recordSuccess()` / `recordFailure()` feed the breaker's state machine.
 *
 * @module
 */

import { AbortedError, HarnessErrorCode } from './errors.js';
import type { AgentEvent } from './events.js';
import { computeBackoffMs, ADAPTER_RETRY_JITTER_FRACTION } from '../infra/backoff.js';
import { type CircuitBreaker, CircuitOpenError } from '../infra/circuit-breaker.js';

/**
 * Config describing retry policy. Shape mirrors the retry-related subset of
 * `AdapterCallerConfig` so it is cheap to construct inside
 * `createAdapterCaller`.
 */
export interface RetryPolicyConfig {
  readonly maxAdapterRetries: number;
  readonly baseRetryDelayMs: number;
  readonly retryableErrors: readonly string[];
  readonly signal: AbortSignal;
  readonly circuitBreaker?: CircuitBreaker;
}

/** Retry policy primitives surfaced to the adapter caller. */
export interface RetryPolicy {
  /** True iff `category` is in the configured retryable set. */
  isRetryableCategory(category: HarnessErrorCode): boolean;
  /**
   * Schedule a backoff sleep keyed on the 0-based `attempt` index. Returns
   * both the computed `delay` (so callers can log/observe it) and a `promise`
   * that resolves when the sleep completes or rejects with `AbortedError`
   * when `config.signal` fires during the wait.
   *
   * The timer is `unref()`-ed so pending sleeps never keep the process alive
   * past a completed run — matches the contract in `adapter-caller.ts`.
   */
  scheduleBackoff(attempt: number): { delay: number; promise: Promise<void> };
  /**
   * Consult the circuit breaker. Returns a ready-to-return fail shape when
   * the breaker is OPEN, or `undefined` when the caller may proceed.
   *
   * Keeping the shape opaque here (as `CircuitOpenPayload`) lets
   * `adapter-caller.ts` merge it into either `AdapterCallFail` branch
   * (streaming / chat) without duplicating the attempt / totalBackoffMs
   * / totalDurationMs accounting.
   */
  checkCircuitOpen(): CircuitOpenPayload | undefined;
  /** Record a successful adapter turn so the breaker can close. */
  recordSuccess(): void;
  /** Record a terminal failure so the breaker can trip to OPEN. */
  recordFailure(): void;
  /** Upper bound of retry attempts. Mirrors `maxAdapterRetries`. */
  readonly maxRetries: number;
}

/**
 * Wave-15 alias for {@link RetryPolicy}. The shape is identical — the alias
 * documents that the policy composes "circuit-breaker gate + retry loop"
 * rather than purely "retry the call", so future additions (bulkhead,
 * rate-limit, fallback) can land here without renaming the main interface.
 */
export type ResiliencePolicy = RetryPolicy;

/** Minimal shape returned by {@link RetryPolicy.checkCircuitOpen}. */
export interface CircuitOpenPayload {
  readonly error: CircuitOpenError;
  readonly errorCategory: HarnessErrorCode.ADAPTER_CIRCUIT_OPEN;
}

/**
 * The adapter caller buffers a terminal stream error while deciding whether
 * to retry. Exported so the caller's type signature stays tight.
 */
export type BufferedStreamError = Extract<AgentEvent, { type: 'error' }>;

/**
 * Build a {@link RetryPolicy} from the retry-related subset of
 * {@link import('./adapter-caller.js').AdapterCallerConfig}.
 *
 * Pure construction — no observable side effect until the caller uses a
 * returned helper.
 */
export function createRetryPolicy(config: Readonly<RetryPolicyConfig>): RetryPolicy {
  // O(1) membership instead of linear `retryableErrors.includes()` per retry
  // decision; the caller previously inlined this Set.
  const retryableErrorSet = new Set<string>(config.retryableErrors);

  function scheduleBackoff(
    attempt: number,
  ): { delay: number; promise: Promise<void> } {
    const delay = computeBackoffMs(attempt, {
      baseMs: config.baseRetryDelayMs,
      jitterFraction: ADAPTER_RETRY_JITTER_FRACTION,
    });

    const promise = new Promise<void>((resolve, reject) => {
      if (config.signal.aborted) {
        reject(new AbortedError());
        return;
      }

      let settled = false;
      // Hoist the timer handle so the abort listener can reference it BEFORE
      // the timer is armed. Registering the listener AFTER `setTimeout`
      // returns leaves a micro-race where a synchronously-fired abort between
      // the two statements would not cancel the timer.
      // eslint-disable-next-line prefer-const -- late-bound; onAbort closes over it before assignment
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => {
        if (!settled) {
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          // Listener auto-removed by { once: true } — no removeEventListener needed
          reject(new AbortedError());
        }
      };

      // Register abort listener BEFORE arming the timer.
      config.signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          config.signal.removeEventListener('abort', onAbort);
          resolve();
        }
      }, delay);

      // Ensure timer doesn't keep the process alive
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    });
    return { delay, promise };
  }

  function isRetryableCategory(category: HarnessErrorCode): boolean {
    return retryableErrorSet.has(category);
  }

  function checkCircuitOpen(): CircuitOpenPayload | undefined {
    if (!config.circuitBreaker) return undefined;
    if (config.circuitBreaker.state() !== 'open') return undefined;
    return {
      error: new CircuitOpenError(),
      errorCategory: HarnessErrorCode.ADAPTER_CIRCUIT_OPEN,
    };
  }

  function recordSuccess(): void {
    config.circuitBreaker?.recordSuccess();
  }

  function recordFailure(): void {
    config.circuitBreaker?.recordFailure();
  }

  return {
    isRetryableCategory,
    scheduleBackoff,
    checkCircuitOpen,
    recordSuccess,
    recordFailure,
    maxRetries: config.maxAdapterRetries,
  };
}
