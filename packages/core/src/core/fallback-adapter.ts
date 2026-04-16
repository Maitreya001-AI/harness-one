/**
 * Circuit-breaker fallback adapter.
 *
 * Wraps multiple adapters, switching to the next when consecutive
 * failures exceed a threshold.
 *
 * @module
 */

import type { AgentAdapter, ChatParams, ChatResponse, StreamChunk } from './types.js';
import { HarnessError, HarnessErrorCode} from './errors.js';
import { createAsyncLock } from '../infra/async-lock.js';

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
  if (adapters.length === 0) {
    throw new HarnessError(
      'At least one adapter is required',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide at least one adapter in the adapters array',
    );
  }
  const maxFailures = config.maxFailures ?? 3;
  let currentIndex = 0;
  let failureCount = 0;
  // CQ-037 (Wave 4b): AsyncLock-backed mutex around the failure/switch flow.
  // The previous `pendingSwitch: Promise<void> | null` flag was racy: two
  // concurrent failures could both see `pendingSwitch === null`, both
  // increment `failureCount`, and both trigger a switch. Serialising the
  // "read counter -> conditionally advance index" critical section via
  // AsyncLock guarantees that only the first over-threshold caller advances
  // the index; the rest observe the already-reset counter and take no action.
  const switchLock = createAsyncLock();

  async function handleFailure(adapterBefore: number): Promise<void> {
    await switchLock.withLock(async () => {
      // CQ-037 (Wave 4b): "stale failure" check. If another concurrent failure
      // already advanced the current index while we were waiting on the lock,
      // our failure applies to a past adapter and must not count against the
      // new one. This preserves the "N concurrent failures trigger one switch"
      // invariant: only failures attributed to the adapter that was current
      // when the failure occurred may increment the counter.
      if (currentIndex !== adapterBefore) return;
      failureCount++;
      if (failureCount >= maxFailures && currentIndex < adapters.length - 1) {
        currentIndex = (currentIndex + 1) % adapters.length;
        failureCount = 0;
      }
    });
  }

  async function handleSuccess(): Promise<void> {
    await switchLock.withLock(async () => {
      failureCount = 0;
    });
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
          await handleSuccess();
          return result;
        } catch (err) {
          lastErr = err;
          await handleFailure(adapterBefore);
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
        HarnessErrorCode.CORE_FALLBACK_EXHAUSTED,
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
            HarnessErrorCode.CORE_STREAM_NOT_SUPPORTED,
            'Use an adapter that implements stream()',
          );
          if (adapters.length === 1) {
            throw noStreamErr;
          }
          lastErr = noStreamErr;
          await handleFailure(adapterBefore);
          const switched = currentIndex !== adapterBefore;
          if (switched) continue;
          if (currentIndex < adapters.length - 1) continue;
          throw noStreamErr;
        }
        try {
          yield* adapter.stream(params);
          await handleSuccess();
          return;
        } catch (err) {
          lastErr = err;
          await handleFailure(adapterBefore);
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
        HarnessErrorCode.CORE_FALLBACK_EXHAUSTED,
        'Increase maxFailures or provide additional adapters',
      );
    },
  };
}
