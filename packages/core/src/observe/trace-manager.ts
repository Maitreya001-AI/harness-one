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
  /** Get spans that are still running (not yet ended). Useful for leak detection. */
  getActiveSpans(): Array<{ id: string; traceId: string; name: string; startTime: number }>;
  /** Flush all exporters. */
  flush(): Promise<void>;
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
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;
  const onExportError = config?.onExportError;

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

  function genId(): string {
    return `id-${nextId++}-${Date.now().toString(36)}`;
  }

  function evictIfNeeded(): void {
    // First, evict ended traces that are no longer in traceOrder.
    // These have already been exported and are safe to remove.
    if (traces.size > maxTraces) {
      for (const [id, trace] of traces) {
        if (traces.size <= maxTraces) break;
        if (trace.status !== 'running') {
          for (const spanId of trace.spanIds) {
            spans.delete(spanId);
          }
          traces.delete(id);
        }
      }
    }
    // Then, evict oldest running traces from the LRU order if still over capacity.
    while (traces.size > maxTraces && traceOrder.length > 0) {
      const oldestId = traceOrder.shift()!;
      const trace = traces.get(oldestId);
      if (trace) {
        for (const spanId of trace.spanIds) {
          spans.delete(spanId);
        }
        traces.delete(oldestId);
      }
    }
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

      // Export
      for (const exporter of exporters) {
        exporter.exportSpan({ ...span, events: [...span.events] }).catch((err) => {
          if (onExportError) {
            onExportError(err);
          } else if (typeof console !== 'undefined') {
            console.warn('[harness-one] Trace exporter failed:', err instanceof Error ? err.message : err);
          }
        });
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

      // Export
      const readonlyTrace = toReadonlyTrace(trace);
      for (const exporter of exporters) {
        exporter.exportTrace(readonlyTrace).catch((err) => {
          if (onExportError) {
            onExportError(err);
          } else if (typeof console !== 'undefined') {
            console.warn('[harness-one] Trace exporter failed:', err instanceof Error ? err.message : err);
          }
        });
      }
    },

    getTrace(traceId: string): Trace | undefined {
      const trace = traces.get(traceId);
      if (!trace) return undefined;
      return toReadonlyTrace(trace);
    },

    getActiveSpans(): Array<{ id: string; traceId: string; name: string; startTime: number }> {
      const active: Array<{ id: string; traceId: string; name: string; startTime: number }> = [];
      for (const span of spans.values()) {
        if (span.status === 'running') {
          active.push({ id: span.id, traceId: span.traceId, name: span.name, startTime: span.startTime });
        }
      }
      return active;
    },

    async flush(): Promise<void> {
      await Promise.all(exporters.map(e => e.flush()));
    },

    async dispose(): Promise<void> {
      // 1. Flush all pending exports — use allSettled so one failure doesn't block others
      const flushResults = await Promise.allSettled(exporters.map(e => e.flush()));
      for (const result of flushResults) {
        if (result.status === 'rejected') {
          if (onExportError) {
            onExportError(result.reason);
          } else if (typeof console !== 'undefined') {
            const err = result.reason;
            console.warn('[harness-one] Exporter flush failed during dispose:', err instanceof Error ? err.message : err);
          }
        }
      }
      // 2. Call shutdown() on all exporters that support it — use allSettled so one failure doesn't block others
      const shutdownResults = await Promise.allSettled(exporters.map(e => e.shutdown ? e.shutdown() : Promise.resolve()));
      for (const result of shutdownResults) {
        if (result.status === 'rejected') {
          if (onExportError) {
            onExportError(result.reason);
          } else if (typeof console !== 'undefined') {
            const err = result.reason;
            console.warn('[harness-one] Exporter shutdown failed during dispose:', err instanceof Error ? err.message : err);
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
export function createConsoleExporter(config?: { verbose?: boolean }): TraceExporter {
  const verbose = config?.verbose ?? false;
  return {
    name: 'console',
    async exportTrace(trace: Trace): Promise<void> {
      if (verbose) {
        console.log('[trace]', JSON.stringify(trace, null, 2));
      } else {
        console.log(`[trace] ${trace.name} (${trace.status}) ${trace.spans.length} spans`);
      }
    },
    async exportSpan(span: Span): Promise<void> {
      if (verbose) {
        console.log('[span]', JSON.stringify(span, null, 2));
      } else {
        console.log(`[span] ${span.name} (${span.status})`);
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
