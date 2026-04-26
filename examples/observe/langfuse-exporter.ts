// Install: npm install langfuse
//
// This example shows how to implement harness-one's TraceExporter interface
// for Langfuse. Traces and spans from harness-one are automatically forwarded
// to Langfuse for visualization and analysis.

import { Langfuse } from 'langfuse';
import type { TraceExporter, Trace, Span } from 'harness-one/observe';
import { createTraceManager } from 'harness-one/observe';

// ---------------------------------------------------------------------------
// The exporter — implements TraceExporter
// ---------------------------------------------------------------------------

/**
 * Create a TraceExporter that sends traces and spans to Langfuse.
 *
 * Usage:
 *   const exporter = createLangfuseExporter({
 *     publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
 *     secretKey: process.env.LANGFUSE_SECRET_KEY!,
 *   });
 *   const tm = createTraceManager({ exporters: [exporter] });
 */
export function createLangfuseExporter(config: {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}): TraceExporter {
  const langfuse = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl ?? 'https://cloud.langfuse.com',
  });

  // Keep a mapping of harness-one trace IDs to Langfuse trace objects
  // so we can attach spans to the correct trace.
  const traceMap = new Map<string, ReturnType<typeof langfuse.trace>>();

  return {
    name: 'langfuse',

    // ---------------------------------------------------------------------
    // exportTrace: called when a harness-one trace ends
    // ---------------------------------------------------------------------
    async exportTrace(trace: Trace): Promise<void> {
      // Create or retrieve the Langfuse trace
      let lfTrace = traceMap.get(trace.id);
      if (!lfTrace) {
        lfTrace = langfuse.trace({
          id: trace.id,
          name: trace.name,
          // Only user-supplied metadata flows to external systems;
          // systemMetadata is library-authored and stays internal.
          metadata: trace.userMetadata,
        });
        traceMap.set(trace.id, lfTrace);
      }

      // Update the trace with final status
      lfTrace.update({
        metadata: {
          ...trace.userMetadata,
          status: trace.status,
          spanCount: trace.spans.length,
        },
      });
    },

    // ---------------------------------------------------------------------
    // exportSpan: called when a harness-one span ends
    // ---------------------------------------------------------------------
    async exportSpan(span: Span): Promise<void> {
      // Ensure the parent trace exists in Langfuse
      let lfTrace = traceMap.get(span.traceId);
      if (!lfTrace) {
        lfTrace = langfuse.trace({ id: span.traceId, name: 'unknown' });
        traceMap.set(span.traceId, lfTrace);
      }

      // Determine if this span represents an LLM call (generation) or a
      // generic span. We check for common LLM-related attributes.
      const attrs = span.attributes ?? {};
      const isGeneration =
        attrs['model'] !== undefined ||
        span.name.includes('llm') ||
        span.name.includes('chat');

      if (isGeneration) {
        // Map to a Langfuse "generation" — the first-class LLM call type
        lfTrace.generation({
          name: span.name,
          startTime: new Date(span.startTime),
          endTime: span.endTime ? new Date(span.endTime) : undefined,
          model: attrs['model'] as string | undefined,
          input: attrs['input'] as unknown,
          output: attrs['output'] as unknown,
          metadata: {
            ...attrs,
            events: span.events,
            status: span.status,
          },
          usage: {
            input: attrs['inputTokens'] as number | undefined,
            output: attrs['outputTokens'] as number | undefined,
          },
        });
      } else {
        // Map to a generic Langfuse span
        lfTrace.span({
          name: span.name,
          startTime: new Date(span.startTime),
          endTime: span.endTime ? new Date(span.endTime) : undefined,
          metadata: {
            ...span.attributes,
            events: span.events,
            status: span.status,
            parentId: span.parentId,
          },
        });
      }
    },

    // ---------------------------------------------------------------------
    // flush: ensure all buffered events are sent to Langfuse
    // ---------------------------------------------------------------------
    async flush(): Promise<void> {
      await langfuse.flushAsync();
      traceMap.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Example: wire the exporter into a TraceManager
// ---------------------------------------------------------------------------

async function demo() {
  const exporter = createLangfuseExporter({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
  });

  // Inject the exporter — harness-one calls exportTrace/exportSpan automatically
  const tm = createTraceManager({ exporters: [exporter] });

  const traceId = tm.startTrace('user-request', { userId: 'u123' });
  const spanId = tm.startSpan(traceId, 'llm-call');
  tm.setSpanAttributes(spanId, {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 150,
    outputTokens: 80,
  });
  tm.endSpan(spanId);
  tm.endTrace(traceId);

  // Flush ensures all events reach Langfuse before the process exits
  await tm.flush();
}

demo().catch(console.error);
