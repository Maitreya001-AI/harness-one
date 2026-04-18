/**
 * Public type surface for the trace manager — `TraceManager` contract plus
 * `RetryMetrics`. Split out of `trace-manager.ts` to keep the implementation
 * file focused on runtime behaviour.
 *
 * @module
 */

import type { SpanId, TraceId } from '../core/types.js';
import type { Trace, SpanEvent } from './types.js';

/** Retry telemetry aggregates exposed via `getRetryMetrics()`. */
export interface RetryMetrics {
  /** Total retry attempts observed across all spans. */
  readonly totalRetries: number;
  /** Retries that were followed by a successful span completion. */
  readonly successAfterRetry: number;
  /** Retries that ultimately failed (span ended with error status). */
  readonly failedAfterRetries: number;
}

/** Manager for creating and tracking traces and spans. */
export interface TraceManager {
  /**
   * Start a new trace. Returns the trace ID.
   *
   * The `metadata` argument is USER metadata — it is redacted (when
   * configured) and surfaced on `trace.userMetadata`. Library-authored
   * metadata flows through `setTraceSystemMetadata()` and lands on
   * `trace.systemMetadata` unredacted.
   */
  startTrace(name: string, metadata?: Record<string, unknown>): TraceId;
  /** Start a new span within a trace. Returns the span ID. */
  startSpan(traceId: TraceId | string, name: string, parentId?: string): SpanId;
  /** Add an event to a span. */
  addSpanEvent(spanId: SpanId | string, event: Omit<SpanEvent, 'timestamp'>): void;
  /** Set attributes on a span. */
  setSpanAttributes(spanId: SpanId | string, attributes: Record<string, unknown>): void;
  /**
   * Snapshot accessor for the current global sampling rate. Primarily useful
   * in tests and introspection tooling; runtime adjustments go through
   * `setSamplingRate()`.
   */
  getSamplingRate(): number;
  /**
   * Attach library-controlled metadata to a trace. Keys written here land on
   * `trace.systemMetadata` and are never redacted. `shouldExport()` sampling
   * hooks MUST read only `systemMetadata` so users can't manipulate sampling
   * decisions by injecting metadata keys.
   */
  setTraceSystemMetadata(traceId: TraceId | string, metadata: Record<string, unknown>): void;
  /**
   * End a span. Span status must be set BEFORE calling `endSpan()`; the
   * status captured at this call is frozen into the exported snapshot.
   *
   * When `status` is omitted, `'completed'` is assumed. Pass `'error'`
   * explicitly for failure paths — in non-production builds a warning is
   * logged if a caller appears to mutate a span's effective status after end.
   */
  endSpan(spanId: SpanId | string, status?: 'completed' | 'error'): void;
  /** End a trace. */
  endTrace(traceId: TraceId | string, status?: 'completed' | 'error'): void;
  /** Get a trace by ID. */
  getTrace(traceId: TraceId | string): Trace | undefined;
  /**
   * Get spans that are still running (not yet ended). Useful for leak
   * detection.
   *
   * @param olderThanMs - When provided, only return spans that have been
   *   running for longer than this duration (in milliseconds), comparing
   *   startTime to Date.now().
   */
  getActiveSpans(olderThanMs?: number): Array<{ id: string; traceId: string; name: string; startTime: number }>;
  /**
   * Flush all exporters. Bounded by the configured `flushTimeoutMs` (default
   * 30_000). On timeout, outstanding exports are abandoned (tracked promises
   * remain but are no longer awaited), a warn is logged, and the call
   * resolves.
   */
  flush(): Promise<void>;
  /**
   * Eagerly invoke `initialize()` on every exporter that declares one. Lazy
   * initialization also happens automatically on first export; calling
   * `initialize()` explicitly is useful for fail-fast startup.
   */
  initialize(): Promise<void>;
  /**
   * Update the global sampling rate (0-1). Only affects traces started
   * AFTER the call; in-flight traces keep the sampling decision captured at
   * their original `startTrace()` (stored on `trace.samplingRateSnapshot` /
   * `trace.sampled`). A per-exporter `shouldExport(trace)` hook takes
   * precedence over this global rate; a per-exporter `shouldSampleTrace`
   * (tail hook) can veto an export at `endTrace()` time.
   */
  setSamplingRate(rate: number): void;
  /**
   * Observed retry telemetry aggregated from span events. Retries are
   * detected by events named `adapter_retry` emitted via `addSpanEvent()` or
   * by attributes on spans indicating retry outcome.
   */
  getRetryMetrics(): RetryMetrics;
  /** Flush all exporters, shut them down, and clear internal state. */
  dispose(): Promise<void>;
}
