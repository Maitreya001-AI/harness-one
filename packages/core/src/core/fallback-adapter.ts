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

  function getAdapter(): AgentAdapter {
    return adapters[currentIndex];
  }

  function handleFailure(): void {
    failureCount++;
    if (failureCount >= maxFailures && currentIndex < adapters.length - 1) {
      currentIndex++;
      failureCount = 0;
    }
  }

  function handleSuccess(): void {
    failureCount = 0;
  }

  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      const adapterBefore = currentIndex;
      try {
        const result = await getAdapter().chat(params);
        handleSuccess();
        return result;
      } catch (err) {
        handleFailure();
        const switched = currentIndex !== adapterBefore;
        if (switched) {
          // We switched to a new adapter — retry with it
          return getAdapter().chat(params);
        }
        if (currentIndex < adapters.length - 1) {
          // Still under threshold but more adapters remain — retry same adapter
          return getAdapter().chat(params);
        }
        // Last adapter and didn't switch — no more options
        throw err;
      }
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const adapterBefore = currentIndex;
      try {
        const adapter = getAdapter();
        if (!adapter.stream) {
          throw new HarnessError(
            'Current adapter does not support streaming',
            'STREAM_NOT_SUPPORTED',
            'Use an adapter that implements stream()',
          );
        }
        yield* adapter.stream(params);
        handleSuccess();
      } catch (err) {
        handleFailure();
        const switched = currentIndex !== adapterBefore;
        if (switched) {
          // Switched to new adapter — retry with it
          const retryAdapter = getAdapter();
          if (!retryAdapter.stream) {
            throw err;
          }
          yield* retryAdapter.stream(params);
          handleSuccess();
        } else if (currentIndex < adapters.length - 1) {
          // Under threshold, more adapters remain — retry same adapter
          const retryAdapter = getAdapter();
          if (!retryAdapter.stream) {
            throw err;
          }
          yield* retryAdapter.stream(params);
          handleSuccess();
        } else {
          // Last adapter and didn't switch — no more options
          throw err;
        }
      }
    },
  };
}
