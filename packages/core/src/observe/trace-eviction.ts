/**
 * Trace eviction policy — pulls the ended-trace sweep, LRU sweep, and
 * span-finalisation logic out of `trace-manager.ts` so the manager file
 * owns trace lifecycle and the eviction file owns eviction decisions.
 *
 * The policy is a thin object built via {@link createTraceEvictionPolicy};
 * it holds no state of its own beyond the
 * re-entrance guard (so concurrent `evictIfNeeded()` calls while one is
 * already running short-circuit) and the one-shot 80%-capacity warning
 * latch. All other state (the `traces` map, the `spans` map, the LRU list,
 * the retry collector) lives on the manager and is passed in as a
 * dependency bundle.
 *
 * Contract preserved 1:1 with the pre-extraction behaviour:
 *   - first pass evicts ended traces (`status !== 'running'`),
 *   - second pass evicts oldest running traces from the LRU,
 *   - runs at most twice — any trace admitted during the first pass gets
 *     one catch-up sweep, then eviction backs off to the next caller,
 *   - returns the list of every span id that was evicted across both
 *     passes (callers use this to forward span teardown to exporters).
 *
 * @module
 */

import type { Logger } from '../infra/logger.js';
import type { MetricCounter } from '../core/metrics-port.js';

/**
 * Minimal shape of the trace records the eviction policy mutates. The real
 * trace-manager module defines its fuller `MutableTrace` but only these
 * fields are read here.
 */
export interface EvictableTrace {
  readonly id: string;
  readonly status: 'running' | 'completed' | 'error';
  readonly spanIds: readonly string[];
}

/**
 * Minimal shape of the span records the eviction policy mutates. Span
 * finalisation flips status to `'error'`, stamps `endTime`, and marks
 * `attributes['eviction.reason']` before the caller's tear-down runs.
 */
export interface EvictableSpan {
  endTime?: number;
  status: 'running' | 'completed' | 'error';
  readonly attributes: Record<string, unknown>;
}

/** Minimal LRU surface used by the eviction policy. */
export interface EvictableLruList<T> {
  readonly size: number;
  shiftOldest(): T | undefined;
}

/** Dependency bundle injected by the trace manager. */
export interface TraceEvictionDeps<TTrace extends EvictableTrace> {
  /** Active traces keyed by trace id. Eviction calls `.delete()`. */
  readonly traces: { readonly size: number; values(): IterableIterator<TTrace>; delete(id: string): boolean };
  /** Active spans keyed by span id. Eviction calls `.get()` / `.delete()`. */
  readonly spans: {
    get(id: string): EvictableSpan | undefined;
    delete(id: string): boolean;
  };
  /** Intrusive LRU for running traces. */
  readonly lru: EvictableLruList<TTrace>;
  /** Retry telemetry keyed on span id. Eviction clears the span entry. */
  readonly retryCollector: { forget(spanId: string): void };
  /** Hard ceiling on concurrent traces; eviction runs while `traces.size > max`. */
  readonly maxTraces: number;
  /** Optional counters; each is a no-op when undefined. */
  readonly traceEvictionCounter?: MetricCounter;
  readonly spanEvictionCounter?: MetricCounter;
  /** Optional logger for the 80%-capacity signal. */
  readonly logger?: Pick<Logger, 'warn'>;
}

/** Policy facade returned by {@link createTraceEvictionPolicy}. */
export interface TraceEvictionPolicy {
  /**
   * Discard traces until `traces.size <= maxTraces`. Returns every span id
   * that was evicted so the caller can tear down observers. Re-entrant calls
   * while an outer sweep is in flight short-circuit to an empty array.
   */
  evictIfNeeded(): string[];
  /**
   * Stateless helper exposed for symmetry — useful for callers that want to
   * finalise in-flight spans without running the full eviction sweep.
   * Flips every running span of `trace` to `'error'` status, stamps
   * `endTime`, and tags `attributes['eviction.reason'] = 'trace_evicted'`.
   * Returns the list of span ids that were mutated.
   */
  finalizeSpansForEviction(trace: EvictableTrace): string[];
  /**
   * Discard one trace as part of eviction: finalise its spans, drop them
   * from the span map, forget retry telemetry, emit counters, and remove
   * the trace itself from the traces map. Exposed so the manager can reuse
   * the same cleanup path for explicit discard flows.
   */
  discardTraceForEviction(trace: EvictableTrace, reason: 'ended' | 'lru'): string[];
}

/**
 * Build a {@link TraceEvictionPolicy}. The returned object closes over the
 * passed deps — no lifecycle of its own, no dispose(). The high-water
 * 80%-capacity warning latch is held inside the closure.
 */
export function createTraceEvictionPolicy<TTrace extends EvictableTrace>(
  deps: TraceEvictionDeps<TTrace>,
): TraceEvictionPolicy {
  const {
    traces,
    spans,
    lru,
    retryCollector,
    maxTraces,
    traceEvictionCounter,
    spanEvictionCounter,
    logger,
  } = deps;

  // Re-entrance guard. Prevents recursive evictIfNeeded() invocations (which
  // today do not exist but would be easy to introduce) from compounding
  // work. The two-pass loop below also catches any trace admitted during
  // the primary sweep.
  let isEvicting = false;
  // One-shot latch for the 80%-capacity warning — re-arms when the size
  // drops back below the threshold.
  let spanHighWaterWarned = false;

  function finalizeSpansForEviction(trace: EvictableTrace): string[] {
    const evictedSpanIds: string[] = [];
    for (const spanId of trace.spanIds) {
      const span = spans.get(spanId);
      if (span && span.status === 'running') {
        span.endTime = Date.now();
        span.status = 'error';
        span.attributes['eviction.reason'] = 'trace_evicted';
        evictedSpanIds.push(spanId);
      }
    }
    return evictedSpanIds;
  }

  function discardTraceForEviction(trace: EvictableTrace, reason: 'ended' | 'lru'): string[] {
    const evictedSpans = finalizeSpansForEviction(trace);
    for (const spanId of trace.spanIds) {
      spans.delete(spanId);
      retryCollector.forget(spanId);
    }
    traceEvictionCounter?.add(1, { reason });
    if (trace.spanIds.length > 0) {
      spanEvictionCounter?.add(trace.spanIds.length, { reason: 'trace_evicted' });
    }
    traces.delete(trace.id);
    return evictedSpans;
  }

  function evictIfNeeded(): string[] {
    if (isEvicting) return [];
    isEvicting = true;

    const allEvictedSpanIds: string[] = [];

    try {
      for (let pass = 0; pass < 2 && traces.size > maxTraces; pass++) {
        // First, evict ended traces regardless of LRU position.
        for (const trace of traces.values()) {
          if (traces.size <= maxTraces) break;
          if (trace.status !== 'running') {
            allEvictedSpanIds.push(...discardTraceForEviction(trace, 'ended'));
          }
        }
        // Then evict the oldest running traces from the LRU.
        while (traces.size > maxTraces && lru.size > 0) {
          const oldest = lru.shiftOldest();
          if (!oldest) break;
          allEvictedSpanIds.push(...discardTraceForEviction(oldest, 'lru'));
        }
      }
    } finally {
      isEvicting = false;
    }

    // 80% high-water warning — latched so noisy pools don't spam the log.
    if (traces.size >= Math.floor(maxTraces * 0.8) && !spanHighWaterWarned) {
      spanHighWaterWarned = true;
      if (logger) {
        try {
          logger.warn('[harness-one/trace-manager] trace map above 80% capacity', {
            traces: traces.size,
            maxTraces,
          });
        } catch {
          /* log-path failure is non-fatal */
        }
      }
    } else if (traces.size < Math.floor(maxTraces * 0.8) && spanHighWaterWarned) {
      spanHighWaterWarned = false;
    }

    return allEvictedSpanIds;
  }

  return { evictIfNeeded, finalizeSpansForEviction, discardTraceForEviction };
}
