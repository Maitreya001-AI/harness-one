/**
 * Langfuse TraceExporter — trace export entry point for `@harness-one/langfuse`.
 *
 * @module
 */

import type { Langfuse } from 'langfuse';
import type { TraceExporter, Trace, Span, InstrumentationPort, MetricsPort } from 'harness-one/observe';
import type { Logger } from 'harness-one/observe';
import { safeWarn } from 'harness-one/observe';
import { createRedactor, sanitizeAttributes } from 'harness-one/redact';
import { HarnessError } from 'harness-one/core';

// ---------------------------------------------------------------------------
// Default sanitize for exported span attributes.
//
// `createLangfuseExporter` is secure-by-default: when the caller does not
// supply `config.sanitize`, the exporter redacts sensitive keys (API keys,
// tokens, passwords, cookies, …) and drops prototype-polluting keys before
// shipping attributes to Langfuse. The caller may override by passing any
// `sanitize(attrs) => attrs`, but there is NO opt-out — the exporter can
// only be given a different scrubber, never a disabled one.
//
// Implementation delegates to `harness-one/observe`'s public redact
// primitives, so this package no longer ships a second copy of the rules.
// ---------------------------------------------------------------------------

const defaultLangfuseRedactor = createRedactor({ useDefaultPattern: true });

function defaultLangfuseSanitize(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeAttributes(attrs, defaultLangfuseRedactor);
}

// ---------------------------------------------------------------------------
// TraceExporter
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse trace exporter. */
export interface LangfuseExporterConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
  /**
   * Sanitize span attributes before export (e.g., strip PII).
   *
   * When omitted, a built-in default sanitizer is
   * applied — it redacts keys matching the standard secret pattern
   * (`api_key`, `authorization`, `token`, `password`, `cookie`, …) and
   * drops prototype-polluting keys (`__proto__`, `constructor`, `prototype`).
   * Passing an explicit function fully replaces the default (no composition);
   * there is no opt-out, the exporter will always apply *some* sanitizer.
   */
  readonly sanitize?: (attributes: Record<string, unknown>) => Record<string, unknown>;
  /** Maximum number of trace entries to retain in the LRU map. Defaults to 1000. */
  readonly maxTraceMapSize?: number;
  /**
   * Optional instrumentation port used to tag the offending span
   * with an `exporter_error` event before an export failure is re-thrown.
   * Typically this is the same `TraceManager` that owns the span — it
   * structurally satisfies `InstrumentationPort` without extra wiring. When
   * omitted, the exporter still throws; it simply cannot annotate the span.
   */
  readonly instrumentation?: InstrumentationPort;
  /**
   * Optional metrics port for flush-batch failure counters.
   * When provided, the exporter emits
   * `harness.langfuse.flush_failures` (counter, incremented on each
   * `flush()` rejection). Defaults to no-op.
   */
  readonly metrics?: MetricsPort;
  /**
   * Optional logger. When supplied, flush failures are surfaced
   * via `logger.warn` in addition to the metric counter, so operators can see
   * batch failures without wiring a metrics backend.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error' | 'debug'>;
}

/**
 * Create a TraceExporter that sends traces and spans to Langfuse.
 *
 * - Traces map to Langfuse traces.
 * - Spans with LLM attributes (model, inputTokens) map to Langfuse generations.
 * - Other spans map to generic Langfuse spans.
 *
 * @example
 * ```ts
 * import { Langfuse } from 'langfuse';
 * import { createLangfuseExporter } from '@harness-one/langfuse';
 * import { createTraceManager } from 'harness-one/observe';
 *
 * const client = new Langfuse({
 *   publicKey: process.env.LANGFUSE_PUBLIC_KEY,
 *   secretKey: process.env.LANGFUSE_SECRET_KEY,
 * });
 * const exporter = createLangfuseExporter({ client });
 * const traces = createTraceManager({ exporters: [exporter] });
 * ```
 */
export function createLangfuseExporter(config: LangfuseExporterConfig): TraceExporter {
  const { client, instrumentation, metrics, logger } = config;

  // Track Langfuse trace objects so spans can attach to the correct parent.
  const MAX_TRACE_MAP_SIZE = config.maxTraceMapSize ?? 1000;
  const traceMap = new Map<string, ReturnType<typeof client.trace>>();
  const traceTimestamps = new Map<string, number>();

  // Lazy metric handles — only materialised if a metrics port was
  // supplied, so the no-op path stays allocation-free.
  const flushFailureCounter = metrics?.counter('harness.langfuse.flush_failures', {
    description: 'Count of Langfuse flush() rejections',
  });

  // Tag the currently-exporting span with an `exporter_error`
  // event before the error propagates. `addSpanEvent` in the core
  // TraceManager throws if the span is already ended; we catch so the
  // observability path never shadows the real export error.
  function tagSpanExportError(spanId: string, err: unknown): void {
    if (!instrumentation) return;
    const errorCode =
      err instanceof HarnessError ? err.code : 'unknown';
    try {
      instrumentation.addSpanEvent(spanId, {
        name: 'exporter_error',
        attributes: {
          exporter: 'langfuse',
          error_code: errorCode,
        },
      });
    } catch {
      // Deliberately swallow — if the span is ended / evicted / missing
      // we still need to re-throw the original export failure.
    }
  }

  function touchTrace(traceId: string): void {
    // Delete-then-reinsert to maintain insertion-order = access-order in the Map.
    // This lets us treat the first entry as the least-recently-used (LRU).
    traceTimestamps.delete(traceId);
    traceTimestamps.set(traceId, Date.now());
  }

  function evictOldestTraces(): void {
    // Single-entry LRU eviction: remove only the oldest entry (the first key
    // in the Map, which preserves insertion/access order thanks to touchTrace).
    // This avoids the previous O(n log n) batch eviction that caused 20ms+
    // event-loop pauses when the cache contained complex traces.
    while (traceMap.size > MAX_TRACE_MAP_SIZE) {
      const oldest = traceTimestamps.keys().next().value;
      if (oldest === undefined) break;
      traceTimestamps.delete(oldest);
      traceMap.delete(oldest);
    }
  }

  return {
    name: 'langfuse',

    async exportTrace(trace: Trace): Promise<void> {
      let lfTrace = traceMap.get(trace.id);
      const createdNow = !lfTrace;
      if (!lfTrace) {
        lfTrace = client.trace({
          id: trace.id,
          name: trace.name,
          // Only user-supplied metadata is forwarded to Langfuse. System
          // metadata is library-internal and stays off the wire.
          metadata: trace.userMetadata,
        });
        traceMap.set(trace.id, lfTrace);
        touchTrace(trace.id);
        evictOldestTraces();
      } else {
        touchTrace(trace.id);
      }

      // If update() throws after we cached the trace object, leave no
      // poisoned entry behind — subsequent spans would otherwise reuse a
      // partially-initialised handle until LRU eviction.
      try {
        lfTrace.update({
          metadata: {
            ...trace.userMetadata,
            status: trace.status,
            spanCount: trace.spans.length,
          },
        });
      } catch (err) {
        if (createdNow) {
          traceMap.delete(trace.id);
          traceTimestamps.delete(trace.id);
        }
        // Tag the *root* trace span (trace.id acts as spanId when
        // harness emits a trace-level diagnostic) before re-throw. Failure
        // paths inside trace export are rare but should be observable.
        tagSpanExportError(trace.id, err);
        throw err;
      }
    },

    async exportSpan(span: Span): Promise<void> {
      try {
      let lfTrace = traceMap.get(span.traceId);
      if (!lfTrace) {
        lfTrace = client.trace({ id: span.traceId, name: 'unknown' });
        traceMap.set(span.traceId, lfTrace);
        touchTrace(span.traceId);
        evictOldestTraces();
      } else {
        touchTrace(span.traceId);
      }

      // Secure-by-default sanitize. `config.sanitize` overrides, undefined
      // falls back to the built-in default redactor. There is no opt-out —
      // the exporter always applies some scrubber.
      const sanitize = config.sanitize ?? defaultLangfuseSanitize;
      const attrs = sanitize(span.attributes);

      // `events[].attributes` are sanitized with the same sanitizer as
      // sanitizer to each event's attribute record so secrets injected via
      // span.addEvent(name, { api_key: '...' }) are redacted in the same
      // way as span.attributes. Events without attributes are passed
      // through unchanged to preserve structural identity in snapshots.
      const sanitizedEvents = span.events.map((event) =>
        event.attributes === undefined
          ? event
          : { ...event, attributes: sanitize(event.attributes) },
      );

      // Prioritize explicit kind attribute. Fallback heuristics only apply when
      // harness.span.kind is not set, to avoid misclassifying non-LLM operations
      // that happen to have token counts or a model reference field.
      const isGeneration =
        attrs['harness.span.kind'] === 'generation' ||
        (attrs['harness.span.kind'] === undefined && (
          typeof attrs['model'] === 'string' ||
          (typeof attrs['inputTokens'] === 'number' && typeof attrs['outputTokens'] === 'number')
        ));

      if (isGeneration) {
        lfTrace.generation({
          name: span.name,
          startTime: new Date(span.startTime),
          ...(span.endTime !== undefined && { endTime: new Date(span.endTime) }),
          ...(attrs['model'] !== undefined && { model: attrs['model'] as string }),
          input: attrs['input'] as unknown,
          output: attrs['output'] as unknown,
          metadata: {
            ...attrs,
            events: sanitizedEvents,
            status: span.status,
          },
          usage: {
            ...(attrs['inputTokens'] !== undefined && { input: attrs['inputTokens'] as number }),
            ...(attrs['outputTokens'] !== undefined && { output: attrs['outputTokens'] as number }),
          },
        });
      } else {
        lfTrace.span({
          name: span.name,
          startTime: new Date(span.startTime),
          ...(span.endTime !== undefined && { endTime: new Date(span.endTime) }),
          metadata: {
            ...attrs,
            events: sanitizedEvents,
            status: span.status,
            ...(span.parentId !== undefined && { parentId: span.parentId }),
          },
        });
      }
      } catch (err) {
        // Annotate the offending span so downstream tools can
        // surface *which* span caused the export failure. We deliberately
        // tag before re-throwing so the trace-manager still sees the error.
        tagSpanExportError(span.id, err);
        throw err;
      }
    },

    /**
     * Flush any events buffered by the Langfuse client. Awaits
     * `client.flushAsync()` so callers reliably see drained state.
     * Rejections emit a counter + log.
     */
    async flush(): Promise<void> {
      try {
        // Await flushAsync so callers of `flush()` see drained state
        // rather than fire-and-forget.
        await client.flushAsync();
      } catch (err) {
        // Surface flush failures via metric + optional log.
        flushFailureCounter?.add(1, { exporter: 'langfuse' });
        if (logger) {
          logger.warn('[harness-one/langfuse] flush failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    },

    /**
     * LM-015: Flush any buffered events **before** tearing down local state.
     * Without the pre-clear flush, an in-flight `flushAsync()` may still be
     * referencing `traceMap` entries we just cleared, producing confusing
     * warnings in production. A 5s Promise.race cap keeps shutdown bounded
     * even when the Langfuse endpoint is unreachable.
     */
    async shutdown(): Promise<void> {
      const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;
      try {
        await Promise.race([
          client.flushAsync(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        safeWarn(undefined, '[harness-one/langfuse] flushAsync during shutdown failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      traceMap.clear();
      traceTimestamps.clear();
    },
  };
}
