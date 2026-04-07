/**
 * @harness-one/opentelemetry — OpenTelemetry trace exporter for harness-one.
 *
 * Maps harness-one traces and spans to OpenTelemetry spans with attributes,
 * events, and status codes.
 *
 * @module
 */

import type { Tracer, Span as OTelSpan } from '@opentelemetry/api';
import { trace as otelTrace, SpanStatusCode } from '@opentelemetry/api';
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

  function setSpanAttributes(otelSpan: OTelSpan, attrs: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        otelSpan.setAttribute(key, value);
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
      });
    },

    async exportSpan(harnessSpan: Span): Promise<void> {
      tracer.startActiveSpan(harnessSpan.name, (otelSpan) => {
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
      });
    },

    async flush(): Promise<void> {
      // OTel SDK handles its own flushing via TracerProvider.forceFlush().
      // This is a no-op unless the user captures the provider.
    },
  };
}
