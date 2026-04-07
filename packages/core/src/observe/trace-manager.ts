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
  /** Flush all exporters. */
  flush(): Promise<void>;
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
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;

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
      endTime: mt.endTime,
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
      const id = genId();
      spans.set(id, {
        id,
        traceId,
        parentId,
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
        exporter.exportSpan({ ...span, events: [...span.events] }).catch(() => {});
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

      // Export
      const readonlyTrace = toReadonlyTrace(trace);
      for (const exporter of exporters) {
        exporter.exportTrace(readonlyTrace).catch(() => {});
      }
    },

    getTrace(traceId: string): Trace | undefined {
      const trace = traces.get(traceId);
      if (!trace) return undefined;
      return toReadonlyTrace(trace);
    },

    async flush(): Promise<void> {
      await Promise.all(exporters.map(e => e.flush()));
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
