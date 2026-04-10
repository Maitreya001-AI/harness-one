/**
 * @harness-one/opentelemetry — OpenTelemetry trace exporter for harness-one.
 *
 * Maps harness-one traces and spans to OpenTelemetry spans with attributes,
 * events, and status codes.
 *
 * @module
 */

import type { Tracer, Span as OTelSpan } from '@opentelemetry/api';
import { trace as otelTrace, SpanStatusCode, context as otelContext } from '@opentelemetry/api';
import type { TraceExporter, Trace, Span } from 'harness-one/observe';

/** Configuration for the OpenTelemetry exporter. */
export interface OTelExporterConfig {
  /** Optional OTel Tracer instance. If not provided, uses the global tracer. */
  readonly tracer?: Tracer;
  /** Service name for the tracer (used when tracer is not provided). */
  readonly serviceName?: string;
}

/**
 * Create a TraceExporter that maps harness-one spans to OpenTelemetry spans.
 *
 * Requires an OTel SDK to be configured (e.g., @opentelemetry/sdk-trace-node).
 * This adapter bridges harness-one spans into the OTel API.
 */
export function createOTelExporter(config?: OTelExporterConfig): TraceExporter {
  const serviceName = config?.serviceName ?? 'harness-one';
  const tracer = config?.tracer ?? otelTrace.getTracer(serviceName);

  // Track created OTel spans so children can reference parents
  const spanMap = new Map<string, OTelSpan>();
  // Track parent relationships for eviction: childId -> parentId
  const spanParentMap = new Map<string, string>();
  // Track last access time per span for LRU eviction
  const spanAccessTime = new Map<string, number>();

  function touchSpan(spanId: string): void {
    spanAccessTime.set(spanId, Date.now());
  }

  function evictSpans(count: number): void {
    // Sort all spans by lastAccessTime ascending (oldest first) for LRU eviction
    const sortedEntries = [...spanAccessTime.entries()].sort((a, b) => a[1] - b[1]);
    let evicted = 0;
    for (const [id] of sortedEntries) {
      if (evicted >= count) break;
      if (!spanMap.has(id)) continue;
      spanMap.delete(id);
      spanParentMap.delete(id);
      spanAccessTime.delete(id);
      evicted++;
    }
  }

  function setSpanAttributes(otelSpan: OTelSpan, attrs: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        otelSpan.setAttribute(key, value);
      } else if (value !== undefined && value !== null) {
        // Log a debug-level warning for dropped non-primitive attributes
        if (typeof console !== 'undefined') {
          console.debug(`Dropping non-primitive attribute '${key}' of type '${typeof value}'`);
        }
      }
    }
  }

  return {
    name: 'opentelemetry',

    async exportTrace(harnessTrace: Trace): Promise<void> {
      tracer.startActiveSpan(harnessTrace.name, (otelSpan) => {
        otelSpan.setAttribute('harness.trace.id', harnessTrace.id);
        otelSpan.setAttribute('harness.trace.status', harnessTrace.status);
        otelSpan.setAttribute('harness.span.count', harnessTrace.spans.length);

        setSpanAttributes(otelSpan, Object.fromEntries(
          Object.entries(harnessTrace.metadata).map(([k, v]) => [`harness.meta.${k}`, v]),
        ));

        if (harnessTrace.status === 'error') {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        } else if (harnessTrace.status === 'completed') {
          otelSpan.setStatus({ code: SpanStatusCode.OK });
        }

        otelSpan.end(harnessTrace.endTime ? new Date(harnessTrace.endTime) : undefined);

        // Clean up child spans for this trace
        for (const s of harnessTrace.spans) {
          spanMap.delete(s.id);
          spanParentMap.delete(s.id);
          spanAccessTime.delete(s.id);
        }
      });
    },

    async exportSpan(harnessSpan: Span): Promise<void> {
      const parentOTelSpan = harnessSpan.parentId ? spanMap.get(harnessSpan.parentId) : undefined;

      // If parentId was specified but the parent span has been evicted, log a warning
      // and create the span as a root span (no parent context).
      if (harnessSpan.parentId && !parentOTelSpan) {
        if (typeof console !== 'undefined') {
          console.warn(
            `[harness-one/opentelemetry] Parent span '${harnessSpan.parentId}' not found (evicted or never exported). ` +
            `Creating span '${harnessSpan.id}' as a root span.`,
          );
        }
      }

      const parentContext = parentOTelSpan
        ? otelTrace.setSpan(otelContext.active(), parentOTelSpan)
        : undefined;

      const spanCallback = (otelSpan: OTelSpan) => {
        spanMap.set(harnessSpan.id, otelSpan);
        touchSpan(harnessSpan.id);
        if (harnessSpan.parentId) {
          spanParentMap.set(harnessSpan.id, harnessSpan.parentId);
          // Touch the parent span to mark it as recently accessed
          if (spanAccessTime.has(harnessSpan.parentId)) {
            touchSpan(harnessSpan.parentId);
          }
        }

        // Safety limit to prevent unbounded growth
        if (spanMap.size > 10_000) {
          evictSpans(1);
        }

        otelSpan.setAttribute('harness.span.id', harnessSpan.id);
        otelSpan.setAttribute('harness.trace.id', harnessSpan.traceId);
        if (harnessSpan.parentId) {
          otelSpan.setAttribute('harness.parent.id', harnessSpan.parentId);
        }

        setSpanAttributes(otelSpan, harnessSpan.attributes);

        for (const event of harnessSpan.events) {
          const attrs: Record<string, string | number | boolean> = {};
          if (event.attributes) {
            for (const [k, v] of Object.entries(event.attributes)) {
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                attrs[k] = v;
              }
            }
          }
          otelSpan.addEvent(event.name, attrs, new Date(event.timestamp));
        }

        if (harnessSpan.status === 'error') {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        } else if (harnessSpan.status === 'completed') {
          otelSpan.setStatus({ code: SpanStatusCode.OK });
        }

        otelSpan.end(harnessSpan.endTime ? new Date(harnessSpan.endTime) : undefined);
      };

      if (parentContext) {
        tracer.startActiveSpan(harnessSpan.name, {}, parentContext, spanCallback);
      } else {
        tracer.startActiveSpan(harnessSpan.name, spanCallback);
      }
    },

    async flush(): Promise<void> {
      spanMap.clear();
      spanParentMap.clear();
      spanAccessTime.clear();
    },
  };
}
