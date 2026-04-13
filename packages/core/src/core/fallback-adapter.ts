/**
 * Circuit-breaker fallback adapter.
 *
 * Wraps multiple adapters, switching to the next when consecutive
 * failures exceed a threshold.
 *
 * @module
 */

import type { AgentAdapter, ChatParams, ChatResponse, StreamChunk } from './types.js';
import { HarnessError } from './errors.js';

/** Configuration for the fallback adapter. */
export interface FallbackAdapterConfig {
  /** Ordered list of adapters to try. First is primary. */
  readonly adapters: readonly AgentAdapter[];
  /** Max consecutive failures before switching to next adapter. Default: 3. */
  readonly maxFailures?: number;
}

/**
 * Creates an adapter that automatically falls back to the next adapter
 * after a configurable number of consecutive failures.
 *
 * Traversal is implemented as a bounded loop (never recursive) so the call
 * stack is O(1) regardless of how many adapters are configured (CQ-004).
 *
 * @example
 * ```ts
 * const adapter = createFallbackAdapter({
 *   adapters: [primaryAdapter, fallbackAdapter],
 *   maxFailures: 3,
 * });
 * const response = await adapter.chat(params);
 * ```
 */
export function createFallbackAdapter(config: FallbackAdapterConfig): AgentAdapter {
  const adapters = [...config.adapters];
  const maxFailures = config.maxFailures ?? 3;
  let currentIndex = 0;
  let failureCount = 0;
  // Mutex for adapter switch: concurrent failures wait for any in-progress
  // switch to complete before proceeding, preventing race conditions where
  // two concurrent calls both increment failureCount and both trigger a switch.
  let pendingSwitch: Promise<void> | null = null;

  async function handleFailure(): Promise<void> {
    // If a switch is already in progress, wait for it to complete and return.
    // The in-progress switch will have already reset failureCount, so we
    // avoid double-switching.
    if (pendingSwitch) {
      await pendingSwitch;
      return;
    }
    failureCount++;
    if (failureCount >= maxFailures && currentIndex < adapters.length - 1) {
      // Use a deferred-resolve pattern:
      // 1. Set pendingSwitch BEFORE mutations so concurrent callers see it.
      // 2. Perform synchronous state mutations.
      // 3. Resolve the promise (so waiters can proceed).
      // 4. Yield once via `await`, giving concurrent callers a chance to run.
      // 5. Set pendingSwitch = null AFTER the await, so it's null for the
      //    next sequential caller but non-null while concurrent callers check.
      let resolvePending!: () => void;
      const switchPromise = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingSwitch = switchPromise;
      currentIndex = (currentIndex + 1) % adapters.length;
      failureCount = 0;
      resolvePending();
      await switchPromise;
      pendingSwitch = null;
    }
  }

  function handleSuccess(): void {
    failureCount = 0;
  }

  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      // CQ-004: Bounded loop — try each adapter at most once per chat() call.
      // We walk up to adapters.length attempts; on each failure we call
      // handleFailure() which may advance currentIndex. If currentIndex
      // doesn't advance and we're on the last adapter, we rethrow.
      let lastErr: unknown;
      for (let i = 0; i < adapters.length; i++) {
        const adapterBefore = currentIndex;
        try {
          const result = await adapters[currentIndex].chat(params);
          handleSuccess();
          return result;
        } catch (err) {
          lastErr = err;
          await handleFailure();
          const switched = currentIndex !== adapterBefore;
          if (switched) {
            // Index advanced — next iteration retries with the NEW adapter.
            continue;
          }
          if (currentIndex < adapters.length - 1) {
            // Still under threshold but more adapters remain — retry same adapter.
            continue;
          }
          // Last adapter and no switch — no more options.
          throw err;
        }
      }
      // Defensive: loop exited without returning or throwing (shouldn't happen
      // because either we return on success or throw on last adapter failure).
      throw lastErr ?? new HarnessError(
        'All fallback adapters exhausted',
        'FALLBACK_EXHAUSTED',
        'Increase maxFailures or provide additional adapters',
      );
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      // CQ-004: Bounded loop mirrors chat() — try each adapter at most once.
      let lastErr: unknown;
      for (let i = 0; i < adapters.length; i++) {
        const adapterBefore = currentIndex;
        const adapter = adapters[currentIndex];
        if (!adapter.stream) {
          // If adapter doesn't support streaming, treat as a failure so we
          // can advance to the next adapter (or throw if this is the only one).
          const noStreamErr = new HarnessError(
            'Current adapter does not support streaming',
            'STREAM_NOT_SUPPORTED',
            'Use an adapter that implements stream()',
          );
          if (adapters.length === 1) {
            throw noStreamErr;
          }
          lastErr = noStreamErr;
          await handleFailure();
          const switched = currentIndex !== adapterBefore;
          if (switched) continue;
          if (currentIndex < adapters.length - 1) continue;
          throw noStreamErr;
        }
        try {
          yield* adapter.stream(params);
          handleSuccess();
          return;
        } catch (err) {
          lastErr = err;
          await handleFailure();
          const switched = currentIndex !== adapterBefore;
          if (switched) {
            // Index advanced — next iteration retries with the NEW adapter.
            continue;
          }
          if (currentIndex < adapters.length - 1) {
            // Under threshold, more adapters remain — retry same adapter.
            continue;
          }
          // Last adapter and no switch — no more options.
          throw err;
        }
      }
      throw lastErr ?? new HarnessError(
        'All fallback adapters exhausted',
        'FALLBACK_EXHAUSTED',
        'Increase maxFailures or provide additional adapters',
      );
    },
  };
}
