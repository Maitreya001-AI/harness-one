// Install: npm install @opentelemetry/api @opentelemetry/sdk-trace-base
//
// This example shows how to implement harness-one's TraceExporter interface
// using the OpenTelemetry API. Harness-one traces and spans are mapped to OTel
// spans so they flow through your existing OTel pipeline (Jaeger, Zipkin, etc.).

import { trace as otelTrace, SpanStatusCode, context } from '@opentelemetry/api';
import type { TraceExporter, Trace, Span } from 'harness-one/observe';
import { createTraceManager } from 'harness-one/observe';

// ---------------------------------------------------------------------------
// The exporter — implements TraceExporter
// ---------------------------------------------------------------------------

/**
 * Create a TraceExporter that maps harness-one spans to OpenTelemetry spans.
 *
 * Prerequisites:
 *   You must configure an OTel SDK (e.g., @opentelemetry/sdk-trace-node) with
 *   an exporter (Jaeger, OTLP, etc.) before using this. This adapter only
 *   bridges harness-one spans into the OTel API — it does not configure the
 *   OTel pipeline itself.
 *
 * Usage:
 *   const exporter = createOTelExporter({ serviceName: 'my-agent' });
 *   const tm = createTraceManager({ exporters: [exporter] });
 */
export function createOTelExporter(config?: {
  serviceName?: string;
}): TraceExporter {
  const serviceName = config?.serviceName ?? 'harness-one';
  const tracer = otelTrace.getTracer(serviceName);

  return {
    name: 'opentelemetry',

    // ---------------------------------------------------------------------
    // exportTrace: create an OTel span representing the entire trace
    // ---------------------------------------------------------------------
    async exportTrace(harnessTrace: Trace): Promise<void> {
      // Create a root span for the trace with explicit timestamps
      tracer.startActiveSpan(harnessTrace.name, (otelSpan) => {
        otelSpan.setAttribute('harness.trace.id', harnessTrace.id);
        otelSpan.setAttribute('harness.trace.status', harnessTrace.status);
        otelSpan.setAttribute('harness.span.count', harnessTrace.spans.length);

        // Copy trace metadata as OTel attributes
        for (const [key, value] of Object.entries(harnessTrace.metadata)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            otelSpan.setAttribute(`harness.meta.${key}`, value);
          }
        }

        // Set status based on harness-one trace status
        if (harnessTrace.status === 'error') {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        } else if (harnessTrace.status === 'completed') {
          otelSpan.setStatus({ code: SpanStatusCode.OK });
        }

        otelSpan.end(harnessTrace.endTime ? new Date(harnessTrace.endTime) : undefined);
      });
    },

    // ---------------------------------------------------------------------
    // exportSpan: create an OTel span for each harness-one span
    // ---------------------------------------------------------------------
    async exportSpan(harnessSpan: Span): Promise<void> {
      tracer.startActiveSpan(harnessSpan.name, (otelSpan) => {
        // Map harness-one attributes to OTel attributes
        otelSpan.setAttribute('harness.span.id', harnessSpan.id);
        otelSpan.setAttribute('harness.trace.id', harnessSpan.traceId);
        if (harnessSpan.parentId) {
          otelSpan.setAttribute('harness.parent.id', harnessSpan.parentId);
        }

        for (const [key, value] of Object.entries(harnessSpan.attributes)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            otelSpan.setAttribute(key, value);
          }
        }

        // Map harness-one events to OTel events
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

        // Set span status
        if (harnessSpan.status === 'error') {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        } else if (harnessSpan.status === 'completed') {
          otelSpan.setStatus({ code: SpanStatusCode.OK });
        }

        otelSpan.end(harnessSpan.endTime ? new Date(harnessSpan.endTime) : undefined);
      });
    },

    // ---------------------------------------------------------------------
    // flush: the OTel SDK handles its own flushing, but we trigger it here
    // ---------------------------------------------------------------------
    async flush(): Promise<void> {
      // If you have a reference to the TracerProvider, call:
      //   await tracerProvider.forceFlush();
      // The OTel API itself has no flush method — this is a no-op unless you
      // capture the provider in a closure.
    },
  };
}

// ---------------------------------------------------------------------------
// Example: wire into a TraceManager
// ---------------------------------------------------------------------------

async function demo() {
  // Prerequisite: configure OTel SDK elsewhere in your app bootstrap, e.g.:
  //   import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
  //   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
  //   const provider = new NodeTracerProvider();
  //   provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
  //   provider.register();

  const exporter = createOTelExporter({ serviceName: 'my-agent' });
  const tm = createTraceManager({ exporters: [exporter] });

  const traceId = tm.startTrace('agent-run');
  const spanId = tm.startSpan(traceId, 'tool-execution');
  tm.addSpanEvent(spanId, { name: 'tool.start' });
  tm.setSpanAttributes(spanId, { tool: 'web_search', model: 'gpt-4o' });
  tm.addSpanEvent(spanId, { name: 'tool.complete' });
  tm.endSpan(spanId);
  tm.endTrace(traceId);

  await tm.flush();
}

demo().catch(console.error);
