/**
 * Retry telemetry aggregator for the trace manager.
 *
 * Extracted from `trace-manager.ts` in round-3 cleanup. Receives `adapter_retry`
 * span events and span terminations; maintains three counters so
 * `getRetryMetrics()` on the trace manager can surface them to operators.
 *
 * Pure state machine — no I/O, no timers.
 *
 * @module
 */

import type { RetryMetrics } from './trace-manager-types.js';

/** State machine that counts adapter retries and their outcomes. */
export interface TraceRetryCollector {
  /** Record an `adapter_retry` span event for a given span id. */
  noteRetry(spanId: string): void;
  /**
   * Record the span's terminal status so we can attribute the retry outcome.
   * Called by `endSpan()`; no-op when the span never saw an adapter_retry.
   */
  noteSpanEnded(spanId: string, status: 'completed' | 'error'): void;
  /**
   * Forget a span id without recording an outcome — used during LRU eviction,
   * where the span is dropped from the trace before it could complete.
   * Preserves the prior behaviour of leaving the outcome counters untouched.
   */
  forget(spanId: string): void;
  /** Read the current aggregate counters. */
  snapshot(): RetryMetrics;
  /** Reset all counters and tracked span-ids (used by `dispose()`). */
  reset(): void;
}

export function createTraceRetryCollector(): TraceRetryCollector {
  let totalRetries = 0;
  let successAfterRetry = 0;
  let failedAfterRetries = 0;
  // Spans that had at least one adapter_retry event — consulted on endSpan
  // to count success/failure outcomes.
  const retryingSpanIds = new Set<string>();

  return {
    noteRetry(spanId: string): void {
      totalRetries++;
      retryingSpanIds.add(spanId);
    },
    noteSpanEnded(spanId: string, status: 'completed' | 'error'): void {
      if (!retryingSpanIds.has(spanId)) return;
      retryingSpanIds.delete(spanId);
      if (status === 'completed') {
        successAfterRetry++;
      } else {
        failedAfterRetries++;
      }
    },
    forget(spanId: string): void {
      retryingSpanIds.delete(spanId);
    },
    snapshot(): RetryMetrics {
      return {
        totalRetries,
        successAfterRetry,
        failedAfterRetries,
      };
    },
    reset(): void {
      totalRetries = 0;
      successAfterRetry = 0;
      failedAfterRetries = 0;
      retryingSpanIds.clear();
    },
  };
}
