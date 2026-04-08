/**
 * Circuit-breaker fallback adapter.
 *
 * Wraps multiple adapters, switching to the next when consecutive
 * failures exceed a threshold.
 *
 * @module
 */

import type { AgentAdapter, ChatParams, ChatResponse, StreamChunk } from './types.js';

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
      try {
        const result = await getAdapter().chat(params);
        handleSuccess();
        return result;
      } catch (err) {
        handleFailure();
        if (currentIndex < adapters.length - 1 || failureCount === 0) {
          // Retry with (possibly new) adapter
          return getAdapter().chat(params);
        }
        throw err;
      }
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      // Streaming doesn't auto-retry -- just use current adapter
      yield* getAdapter().stream!(params);
    },
  };
}
