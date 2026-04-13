/**
 * Trace and span management for observability.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import {
  createRedactor,
  sanitizeAttributes,
  type RedactConfig,
  type Redactor,
} from '../_internal/redact.js';
import type { Trace, Span, SpanEvent, SpanEventSeverity, TraceExporter } from './types.js';

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
   * SEC-016: The `metadata` argument is treated as USER metadata — it is
   * redacted (if configured) and surfaced on `trace.metadata` as well as
   * `trace.userMetadata`. System-authored metadata is emitted via
   * `setTraceSystemMetadata()` and kept on `trace.systemMetadata`.
   */
  startTrace(name: string, metadata?: Record<string, unknown>): string;
  /** Start a new span within a trace. Returns the span ID. */
  startSpan(traceId: string, name: string, parentId?: string): string;
  /** Add an event to a span. */
  addSpanEvent(spanId: string, event: Omit<SpanEvent, 'timestamp'>): void;
  /** Set attributes on a span. */
  setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void;
  /**
   * SEC-016: Attach library-controlled metadata to a trace. Keys written here
   * land on `trace.systemMetadata` and are never redacted. `shouldExport()`
   * sampling hooks MUST read only `systemMetadata` so users can't manipulate
   * sampling decisions by injecting metadata keys.
   */
  setTraceSystemMetadata(traceId: string, metadata: Record<string, unknown>): void;
  /** End a span. */
  endSpan(spanId: string, status?: 'completed' | 'error'): void;
  /** End a trace. */
  endTrace(traceId: string, status?: 'completed' | 'error'): void;
  /** Get a trace by ID. */
  getTrace(traceId: string): Trace | undefined;
  /**
   * Get spans that are still running (not yet ended). Useful for leak detection.
   *
   * @param olderThanMs - When provided, only return spans that have been running
   *   for longer than this duration (in milliseconds), comparing startTime to
   *   Date.now(). This helps detect leaked/stale spans.
   */
  getActiveSpans(olderThanMs?: number): Array<{ id: string; traceId: string; name: string; startTime: number }>;
  /** Flush all exporters. */
  flush(): Promise<void>;
  /**
   * Eagerly invoke `initialize()` on every exporter that declares one.
   * Lazy initialization also happens automatically on first export; calling
   * `initialize()` explicitly is useful for fail-fast startup where connection
   * problems should surface immediately.
   */
  initialize(): Promise<void>;
  /**
   * Update the global sampling rate (0-1). Takes effect for traces ended
   * after the call. A per-exporter `shouldExport(trace)` hook, when present,
   * takes precedence over this global rate.
   */
  setSamplingRate(rate: number): void;
  /**
   * OBS-005: Observed retry telemetry aggregated from span events. Retries
   * are detected by events named `adapter_retry` emitted via `addSpanEvent()`
   * or by attributes on spans indicating retry outcome.
   */
  getRetryMetrics(): RetryMetrics;
  /** Dispose: flush all exporters, shut them down, and clear internal state. */
  dispose(): Promise<void>;
}

/**
 * Create a new TraceManager instance.
 *
 * @example
 * ```ts
 * const tm = createTraceManager();
 * const traceId = tm.startTrace('request');
 * const spanId = tm.startSpan(traceId, 'llm-call');
 * tm.endSpan(spanId);
 * tm.endTrace(traceId);
 * ```
 */
export function createTraceManager(config?: {
  exporters?: TraceExporter[];
  maxTraces?: number;
  onExportError?: (error: unknown) => void;
  /**
   * Optional structured logger for trace-manager internal warnings. When set,
   * export errors without an onExportError callback route through this logger
   * instead of `console.warn`. Lets ops silence or redirect warnings at runtime.
   */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * Global sampling rate (0-1). When set and no per-exporter `shouldExport`
   * hook is provided, each trace is sampled on `endTrace()`. Runtime-adjustable
   * via the returned manager's `setSamplingRate()` method.
   */
  defaultSamplingRate?: number;
  /**
   * SEC-007: Secret redaction applied to all USER-SUPPLIED span attributes,
   * trace metadata, and span events at the ingestion boundary. Because
   * exporters (console, OTel, Langfuse) read `span.attributes` and
   * `trace.metadata` verbatim, scrubbing here guarantees downstream observers
   * never see unredacted secrets. Set to `{}` to enable default patterns.
   */
  redact?: RedactConfig;
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;
  const onExportError = config?.onExportError;
  const logger = config?.logger;
  let samplingRate = config?.defaultSamplingRate ?? 1;
  // SEC-007: Build redactor once. `undefined` means pass-through.
  const redactor: Redactor | undefined = config?.redact
    ? createRedactor(config.redact)
    : undefined;

  if (maxTraces < 1) {
    throw new HarnessError('maxTraces must be >= 1', 'INVALID_CONFIG', 'Provide a positive maxTraces value');
  }
  if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1) {
    throw new HarnessError(
      'defaultSamplingRate must be a finite number in [0, 1]',
      'INVALID_CONFIG',
      'Provide a rate between 0 and 1 inclusive',
    );
  }

  /**
   * Lazy initialization — track which exporters have had initialize() called.
   * Exporters are initialized on first export attempt (span or trace) to keep
   * createTraceManager synchronous.
   */
  const initPromises = new Map<TraceExporter, Promise<void>>();

  function ensureInitialized(exporter: TraceExporter): Promise<void> {
    if (!exporter.initialize) return Promise.resolve();
    let p = initPromises.get(exporter);
    if (!p) {
      p = Promise.resolve(exporter.initialize()).catch((err) => {
        // Initialization failure is reported but doesn't stop subsequent
        // attempts — the exporter's isHealthy() will gate future exports.
        if (onExportError) onExportError(err);
        else if (logger) logger.warn('[harness-one] exporter initialize failed', { exporter: exporter.name, error: err });
        else console.warn('[harness-one] exporter initialize failed:', err);
      });
      initPromises.set(exporter, p);
    }
    return p;
  }

  function reportExportError(err: unknown): void {
    if (onExportError) onExportError(err);
    else if (logger) logger.warn('[harness-one] trace export error', { error: err });
    else console.warn('[harness-one] trace export error:', err);
  }

  /**
   * Pending in-flight export promises. Tracked so flush() / dispose() can wait
   * for outstanding span/trace exports to settle — otherwise callers observe
   * a gap between endSpan() returning and the exporter receiving the span.
   */
  const pendingExports = new Set<Promise<unknown>>();

  function trackExport(p: Promise<unknown>): void {
    pendingExports.add(p);
    // PERF-016: `.finally()` alone can leak when the underlying promise
    // rejects and a handler in finally throws — swallow the rejection first
    // so the delete callback is guaranteed to run.
    p.catch(() => {}).finally(() => pendingExports.delete(p));
  }

  function exportSpanTo(exporter: TraceExporter, span: Span): void {
    if (exporter.isHealthy && !exporter.isHealthy()) return;
    const p = ensureInitialized(exporter)
      .then(() => exporter.exportSpan(span))
      .catch(reportExportError);
    trackExport(p);
  }

  function exportTraceTo(exporter: TraceExporter, trace: Trace): void {
    if (exporter.isHealthy && !exporter.isHealthy()) return;
    if (exporter.shouldExport && !exporter.shouldExport(trace)) return;
    // Global sampling: when no per-exporter hook, apply defaultSamplingRate.
    if (!exporter.shouldExport && samplingRate < 1 && Math.random() >= samplingRate) return;
    const p = ensureInitialized(exporter)
      .then(() => exporter.exportTrace(trace))
      .catch(reportExportError);
    trackExport(p);
  }

  interface MutableSpan {
    id: string;
    traceId: string;
    parentId?: string;
    name: string;
    startTime: number;
    endTime?: number;
    attributes: Record<string, unknown>;
    events: SpanEvent[];
    status: 'running' | 'completed' | 'error';
  }

  interface MutableTrace {
    id: string;
    name: string;
    startTime: number;
    endTime?: number;
    /** SEC-016: user-supplied metadata (redacted when configured). */
    userMetadata: Record<string, unknown>;
    /** SEC-016: library-authored metadata used by shouldExport hooks. */
    systemMetadata: Record<string, unknown>;
    spanIds: string[];
    status: 'running' | 'completed' | 'error';
  }

  const traces = new Map<string, MutableTrace>();
  const spans = new Map<string, MutableSpan>();
  const traceOrder: string[] = []; // For LRU eviction
  // PERF-006: secondary index for O(1) removal from traceOrder in endTrace.
  // Keeps mapping traceId -> position in traceOrder. On removal we swap the
  // last element into the hole, updating the index for the moved entry.
  const traceOrderIndex = new Map<string, number>();
  let nextId = 1;
  let isEvicting = false; // Re-entrance guard for eviction (Fix 3)

  // OBS-005: retry telemetry aggregated from span events named `adapter_retry`.
  let retryTotalRetries = 0;
  let retrySuccessAfterRetry = 0;
  let retryFailedAfterRetries = 0;
  // Spans that had at least one adapter_retry event — consulted on endSpan
  // to count success/failure outcomes.
  const retryingSpanIds = new Set<string>();

  function genId(): string {
    return `id-${nextId++}-${Date.now().toString(36)}`;
  }

  /**
   * PERF-006: Append `id` to `traceOrder` and record its index in O(1).
   */
  function appendTraceOrder(id: string): void {
    traceOrderIndex.set(id, traceOrder.length);
    traceOrder.push(id);
  }

  /**
   * PERF-006: Remove `id` from `traceOrder` using a swap-remove so we avoid
   * the O(n) indexOf + splice that previously dominated endTrace on hot paths.
   */
  function removeTraceOrder(id: string): void {
    const idx = traceOrderIndex.get(id);
    if (idx === undefined) return;
    const last = traceOrder.length - 1;
    if (idx !== last) {
      const moved = traceOrder[last];
      traceOrder[idx] = moved;
      traceOrderIndex.set(moved, idx);
    }
    traceOrder.pop();
    traceOrderIndex.delete(id);
  }

  function shiftTraceOrder(): string | undefined {
    const first = traceOrder.shift();
    if (first === undefined) return undefined;
    traceOrderIndex.delete(first);
    // After shift, every remaining entry's index has decreased by one.
    for (let i = 0; i < traceOrder.length; i++) {
      traceOrderIndex.set(traceOrder[i], i);
    }
    return first;
  }

  /**
   * Finalize any still-running spans for a trace before eviction.
   * Ends each running span with 'error' status and an eviction attribute.
   * Returns the list of evicted span IDs.
   */
  function finalizeSpansForEviction(trace: MutableTrace): string[] {
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

  function evictIfNeeded(): string[] {
    // Re-entrance guard: prevent recursive eviction calls (Fix 3)
    if (isEvicting) return [];
    isEvicting = true;

    const allEvictedSpanIds: string[] = [];

    try {
      // First, evict ended traces that are no longer in traceOrder.
      // These have already been exported and are safe to remove.
      if (traces.size > maxTraces) {
        for (const [id, trace] of traces) {
          if (traces.size <= maxTraces) break;
          if (trace.status !== 'running') {
            // Finalize any still-running spans before removal (Fix 1)
            allEvictedSpanIds.push(...finalizeSpansForEviction(trace));
            for (const spanId of trace.spanIds) {
              spans.delete(spanId);
              retryingSpanIds.delete(spanId);
            }
            traces.delete(id);
          }
        }
      }
      // Then, evict oldest running traces from the LRU order if still over capacity.
      while (traces.size > maxTraces && traceOrder.length > 0) {
        const oldestId = shiftTraceOrder() as string;
        const trace = traces.get(oldestId);
        if (trace) {
          // Finalize any still-running spans before removal (Fix 1)
          allEvictedSpanIds.push(...finalizeSpansForEviction(trace));
          for (const spanId of trace.spanIds) {
            spans.delete(spanId);
            retryingSpanIds.delete(spanId);
          }
          traces.delete(oldestId);
        }
      }
    } finally {
      isEvicting = false;
    }

    return allEvictedSpanIds;
  }

  function toReadonlyTrace(mt: MutableTrace): Trace {
    const traceSpans: Span[] = mt.spanIds.map(sid => {
      const s = spans.get(sid);
      if (!s) return null;
      return { ...s, events: [...s.events] } as Span;
    }).filter((s): s is Span => s !== null);

    // SEC-016: `metadata` is the BACKWARD-COMPATIBLE view — callers that read
    // `trace.metadata` still see user metadata. New code consults
    // `userMetadata` / `systemMetadata` directly via the readonly alias.
    const combinedMetadata = { ...mt.userMetadata };
    // When system metadata is present, make it available under a well-known
    // namespaced key so legacy observers that only read `.metadata` still see
    // it. Namespaced to avoid collisions with user keys.
    if (Object.keys(mt.systemMetadata).length > 0) {
      (combinedMetadata as Record<string, unknown>)['__system__'] = { ...mt.systemMetadata };
    }

    const result: Trace & {
      readonly userMetadata?: Record<string, unknown>;
      readonly systemMetadata?: Record<string, unknown>;
    } = {
      id: mt.id,
      name: mt.name,
      startTime: mt.startTime,
      ...(mt.endTime !== undefined && { endTime: mt.endTime }),
      metadata: combinedMetadata,
      userMetadata: { ...mt.userMetadata },
      systemMetadata: { ...mt.systemMetadata },
      spans: traceSpans,
      status: mt.status,
    };
    return result;
  }

  return {
    startTrace(name: string, metadata?: Record<string, unknown>): string {
      const id = genId();
      // SEC-007 + SEC-016: user metadata is scrubbed at ingestion so exporters
      // (console, OTel, Langfuse) never observe secrets.
      const userMeta = metadata
        ? (redactor ? sanitizeAttributes(metadata, redactor) : { ...metadata })
        : {};
      traces.set(id, {
        id,
        name,
        startTime: Date.now(),
        userMetadata: userMeta,
        systemMetadata: {},
        spanIds: [],
        status: 'running',
      });
      appendTraceOrder(id);
      evictIfNeeded();
      return id;
    },

    startSpan(traceId: string, name: string, parentId?: string): string {
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          'TRACE_NOT_FOUND',
          'Start a trace before creating spans',
        );
      }
      // Validate parentId exists as a span in this trace
      if (parentId !== undefined) {
        const parentSpan = spans.get(parentId);
        if (!parentSpan || parentSpan.traceId !== traceId) {
          throw new HarnessError(
            `Parent span not found: ${parentId} in trace ${traceId}`,
            'SPAN_NOT_FOUND',
            'Start the parent span before creating child spans',
          );
        }
      }
      const id = genId();
      spans.set(id, {
        id,
        traceId,
        ...(parentId !== undefined && { parentId }),
        name,
        startTime: Date.now(),
        attributes: {},
        events: [],
        status: 'running',
      });
      trace.spanIds.push(id);
      return id;
    },

    addSpanEvent(spanId: string, event: Omit<SpanEvent, 'timestamp'>): void {
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          'SPAN_NOT_FOUND',
          'Start a span before adding events',
        );
      }
      // SEC-007: scrub event attributes before storing. Event names are plain
      // strings and are not redacted. Preserves optional severity.
      const safeAttrs = event.attributes
        ? (redactor ? sanitizeAttributes(event.attributes, redactor) : event.attributes)
        : undefined;
      const severity: SpanEventSeverity | undefined = event.severity;
      const storedEvent: SpanEvent = {
        name: event.name,
        timestamp: Date.now(),
        ...(safeAttrs !== undefined && { attributes: safeAttrs }),
        ...(severity !== undefined && { severity }),
      };
      span.events.push(storedEvent);

      // OBS-005: track adapter_retry events for aggregate telemetry.
      if (event.name === 'adapter_retry') {
        retryTotalRetries++;
        retryingSpanIds.add(spanId);
      }
    },

    setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void {
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          'SPAN_NOT_FOUND',
          'Start a span before setting attributes',
        );
      }
      // SEC-007: scrub attributes at ingestion — downstream exporters read
      // span.attributes verbatim, so redacting here guarantees no leak.
      const safeAttrs = redactor ? sanitizeAttributes(attributes, redactor) : attributes;
      Object.assign(span.attributes, safeAttrs);
    },

    setTraceSystemMetadata(traceId: string, metadata: Record<string, unknown>): void {
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          'TRACE_NOT_FOUND',
          'Start a trace before setting system metadata',
        );
      }
      // SEC-016: systemMetadata is library-authored and NOT redacted. Caller
      // owns correctness. Do still drop prototype-polluting keys via redactor
      // if one is configured (shape-only safety, no secret scrubbing).
      for (const [k, v] of Object.entries(metadata)) {
        if (redactor && redactor.isPollutingKey(k)) continue;
        trace.systemMetadata[k] = v;
      }
    },

    endSpan(spanId: string, status?: 'completed' | 'error'): void {
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          'SPAN_NOT_FOUND',
          'Start a span before ending it',
        );
      }
      span.endTime = Date.now();
      const finalStatus = status ?? 'completed';
      span.status = finalStatus;

      // OBS-005: attribute retry outcome now that the span is complete.
      if (retryingSpanIds.has(spanId)) {
        retryingSpanIds.delete(spanId);
        if (finalStatus === 'completed') {
          retrySuccessAfterRetry++;
        } else {
          retryFailedAfterRetries++;
        }
      }

      // Export — respects each exporter's isHealthy() hook and lazy initialize().
      const snapshot: Span = { ...span, events: [...span.events] };
      for (const exporter of exporters) {
        exportSpanTo(exporter, snapshot);
      }
    },

    endTrace(traceId: string, status?: 'completed' | 'error'): void {
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          'TRACE_NOT_FOUND',
          'Start a trace before ending it',
        );
      }
      trace.endTime = Date.now();
      trace.status = status ?? 'completed';

      // PERF-006: O(1) removal via swap-remove; previously O(n) indexOf+splice.
      removeTraceOrder(traceId);

      // Export — respects isHealthy(), shouldExport(), lazy initialize(), and samplingRate.
      const readonlyTrace = toReadonlyTrace(trace);
      for (const exporter of exporters) {
        exportTraceTo(exporter, readonlyTrace);
      }
    },

    getTrace(traceId: string): Trace | undefined {
      const trace = traces.get(traceId);
      if (!trace) return undefined;
      return toReadonlyTrace(trace);
    },

    getActiveSpans(olderThanMs?: number): Array<{ id: string; traceId: string; name: string; startTime: number }> {
      const active: Array<{ id: string; traceId: string; name: string; startTime: number }> = [];
      const now = Date.now();
      for (const span of spans.values()) {
        if (span.status === 'running') {
          // Fix 2: When olderThanMs is provided, only include spans running
          // longer than the specified duration (stale span detection).
          if (olderThanMs !== undefined && (now - span.startTime) < olderThanMs) {
            continue;
          }
          active.push({ id: span.id, traceId: span.traceId, name: span.name, startTime: span.startTime });
        }
      }
      return active;
    },

    async flush(): Promise<void> {
      // Settle pending in-flight exports before asking exporters to flush — a
      // span may have been fired microseconds ago and we don't want flush() to
      // race past it.
      while (pendingExports.size > 0) {
        await Promise.allSettled(Array.from(pendingExports));
      }
      await Promise.all(exporters.map(e => e.flush()));
    },

    async initialize(): Promise<void> {
      await Promise.all(exporters.map(e => ensureInitialized(e)));
    },

    setSamplingRate(rate: number): void {
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new HarnessError(
          'samplingRate must be a finite number in [0, 1]',
          'INVALID_CONFIG',
          'Provide a rate between 0 and 1 inclusive',
        );
      }
      samplingRate = rate;
    },

    getRetryMetrics(): RetryMetrics {
      return {
        totalRetries: retryTotalRetries,
        successAfterRetry: retrySuccessAfterRetry,
        failedAfterRetries: retryFailedAfterRetries,
      };
    },

    async dispose(): Promise<void> {
      // 1. Flush all pending exports — use allSettled so one failure doesn't block others
      const flushResults = await Promise.allSettled(exporters.map(e => e.flush()));
      for (const result of flushResults) {
        if (result.status === 'rejected') {
          if (onExportError) {
            onExportError(result.reason);
          } else {
            console.warn('[harness-one] trace export error:', result.reason);
          }
        }
      }
      // 2. Call shutdown() on all exporters that support it — use allSettled so one failure doesn't block others
      const shutdownResults = await Promise.allSettled(exporters.map(e => e.shutdown ? e.shutdown() : Promise.resolve()));
      for (const result of shutdownResults) {
        if (result.status === 'rejected') {
          if (onExportError) {
            onExportError(result.reason);
          } else {
            console.warn('[harness-one] trace export error:', result.reason);
          }
        }
      }
      // 3. Clear internal maps
      traces.clear();
      spans.clear();
      traceOrder.length = 0;
      traceOrderIndex.clear();
      retryingSpanIds.clear();
      retryTotalRetries = 0;
      retrySuccessAfterRetry = 0;
      retryFailedAfterRetries = 0;
    },
  };
}

/**
 * Create a console exporter for traces and spans.
 *
 * @example
 * ```ts
 * const exporter = createConsoleExporter({ verbose: true });
 * const tm = createTraceManager({ exporters: [exporter] });
 * ```
 */
export function createConsoleExporter(config?: { verbose?: boolean; output?: (line: string) => void }): TraceExporter {
  const verbose = config?.verbose ?? false;
  // eslint-disable-next-line no-console
  const output = config?.output ?? console.log;
  return {
    name: 'console',
    async exportTrace(trace: Trace): Promise<void> {
      if (verbose) {
        output(`[trace] ${JSON.stringify(trace, null, 2)}`);
      } else {
        output(`[trace] ${trace.name} (${trace.status}) ${trace.spans.length} spans`);
      }
    },
    async exportSpan(span: Span): Promise<void> {
      if (verbose) {
        output(`[span] ${JSON.stringify(span, null, 2)}`);
      } else {
        output(`[span] ${span.name} (${span.status})`);
      }
    },
    async flush(): Promise<void> {
      // Nothing to flush for console
    },
  };
}

/**
 * Create a no-op exporter (useful for testing).
 *
 * @example
 * ```ts
 * const exporter = createNoOpExporter();
 * ```
 */
export function createNoOpExporter(): TraceExporter {
  return {
    name: 'noop',
    async exportTrace(): Promise<void> {},
    async exportSpan(): Promise<void> {},
    async flush(): Promise<void> {},
  };
}
