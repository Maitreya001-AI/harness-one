/**
 * Trace and span management for observability.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { Trace, Span, SpanEvent, TraceExporter } from './types.js';

/** Manager for creating and tracking traces and spans. */
export interface TraceManager {
  /** Start a new trace. Returns the trace ID. */
  startTrace(name: string, metadata?: Record<string, unknown>): string;
  /** Start a new span within a trace. Returns the span ID. */
  startSpan(traceId: string, name: string, parentId?: string): string;
  /** Add an event to a span. */
  addSpanEvent(spanId: string, event: Omit<SpanEvent, 'timestamp'>): void;
  /** Set attributes on a span. */
  setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void;
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
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;
  const onExportError = config?.onExportError;
  const logger = config?.logger;
  let samplingRate = config?.defaultSamplingRate ?? 1;

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
    p.finally(() => pendingExports.delete(p));
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
    metadata: Record<string, unknown>;
    spanIds: string[];
    status: 'running' | 'completed' | 'error';
  }

  const traces = new Map<string, MutableTrace>();
  const spans = new Map<string, MutableSpan>();
  const traceOrder: string[] = []; // For LRU eviction
  let nextId = 1;
  let isEvicting = false; // Re-entrance guard for eviction (Fix 3)

  function genId(): string {
    return `id-${nextId++}-${Date.now().toString(36)}`;
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
            }
            traces.delete(id);
          }
        }
      }
      // Then, evict oldest running traces from the LRU order if still over capacity.
      while (traces.size > maxTraces && traceOrder.length > 0) {
        const oldestId = traceOrder.shift() as string;
        const trace = traces.get(oldestId);
        if (trace) {
          // Finalize any still-running spans before removal (Fix 1)
          allEvictedSpanIds.push(...finalizeSpansForEviction(trace));
          for (const spanId of trace.spanIds) {
            spans.delete(spanId);
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

    return {
      id: mt.id,
      name: mt.name,
      startTime: mt.startTime,
      ...(mt.endTime !== undefined && { endTime: mt.endTime }),
      metadata: { ...mt.metadata },
      spans: traceSpans,
      status: mt.status,
    };
  }

  return {
    startTrace(name: string, metadata?: Record<string, unknown>): string {
      const id = genId();
      traces.set(id, {
        id,
        name,
        startTime: Date.now(),
        metadata: metadata ? { ...metadata } : {},
        spanIds: [],
        status: 'running',
      });
      traceOrder.push(id);
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
      span.events.push({ ...event, timestamp: Date.now() });
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
      Object.assign(span.attributes, attributes);
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
      span.status = status ?? 'completed';

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

      // Remove from traceOrder to prevent memory leak: ended traces that are
      // not evicted would otherwise leave stale IDs in the array forever.
      const orderIdx = traceOrder.indexOf(traceId);
      if (orderIdx >= 0) {
        traceOrder.splice(orderIdx, 1);
      }

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
