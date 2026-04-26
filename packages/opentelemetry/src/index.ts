/**
 * The `@harness-one/opentelemetry` package — OpenTelemetry trace exporter for harness-one.
 *
 * Maps harness-one traces and spans to OpenTelemetry spans with attributes,
 * events, and status codes.
 *
 * Structure: the factory + public types live here; sub-concerns split
 * into siblings.
 *
 *   - `span-map.ts`    live-span + evicted-parent LRU bookkeeping
 *   - `attributes.ts`  semconv rename table, JSON-stringify fallback,
 *                      and dropped-attribute counters
 *
 * | harness-one key | OTel semconv key  |
 * |-----------------|-------------------|
 * | hitRate         | cache.hit_ratio   |
 * | missRate        | cache.miss_ratio  |
 * | avgLatency      | cache.latency_ms  |
 *
 * The rename table lives in `attributes.ts`.
 *
 * @module
 */

import type { Tracer, Span as OTelSpan } from '@opentelemetry/api';
import { trace as otelTrace, SpanStatusCode, context as otelContext } from '@opentelemetry/api';
import type { TraceExporter, Trace, Span, MetricsPort } from 'harness-one/observe';

import { createOTelSpanMap } from './span-map.js';
import { createAttributeSink } from './attributes.js';

/**
 * Minimal logger interface accepted by the OTel exporter. When provided,
 * parent-linking warnings and diagnostics are routed here instead of
 * falling back to `console.warn`.
 *
 * Supports an optional `debug` method so parent-fallback events can be
 * surfaced without spamming `warn`. The `debug` method is optional so
 * existing `warn`-only loggers continue to satisfy the type.
 */
export interface OTelExporterLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
  debug?: (message: string, context?: Record<string, unknown>) => void;
}

/** Configuration for the OpenTelemetry exporter. */
export interface OTelExporterConfig {
  /** Optional OTel Tracer instance. If not provided, uses the global tracer. */
  readonly tracer?: Tracer;
  /** Service name for the tracer (used when tracer is not provided). */
  readonly serviceName?: string;
  /**
   * Maximum number of evicted parent span contexts to retain for child linking.
   * When a parent span is evicted from the LRU cache but a child arrives later,
   * this fallback map provides the minimal context needed to link them correctly.
   * Defaults to 1000.
   *
   * Parent mapping is retained until LRU evicts. Increase this value if
   * deep trees lose hierarchy (symptom: repeated "Parent span '...' not
   * found" warnings for expected-alive parents).
   */
  readonly maxEvictedParents?: number;
  /** Maximum number of active spans to retain before LRU eviction. Defaults to 10000. */
  readonly maxSpans?: number;
  /**
   * Callback invoked when a non-primitive attribute is dropped during export.
   * Receives the offending key and type. When unset, falls back to
   * `console.debug` for compatibility. Lets ops route dropped-attribute
   * signals into their metrics pipeline.
   */
  readonly onDroppedAttribute?: (info: { key: string; type: string; where: 'attribute' | 'event' }) => void;
  /**
   * Optional logger for diagnostic warnings (e.g., parent-linking fallback).
   * Falls back to `console.warn` when not provided.
   */
  readonly logger?: OTelExporterLogger;
  /**
   * When `true`, non-primitive attributes (objects, arrays) are
   * `JSON.stringify()`-ed and attached to the span as string attributes rather
   * than being dropped. Functions, symbols, and circular references remain
   * dropped (JSON.stringify would throw on the latter). Defaults to `false` so
   * the historical "drop non-primitives" behaviour is preserved — enabling it
   * widens the payload surface and should be opt-in.
   */
  readonly stringifyComplexAttributes?: boolean;
  /**
   * Optional metrics port. When supplied, the exporter emits:
   *
   *  - `harness.otel.parent_fallback` (counter) — incremented each time a
   *    child span's parent was found in the `evictedParents` LRU cache
   *    rather than in the live `spanMap`. High rates indicate
   *    `maxEvictedParents` should be increased (deep trees) or that parent
   *    spans are ending too early relative to their children.
   *
   * Defaults to no-op when omitted.
   */
  readonly metrics?: MetricsPort;
}

/** Runtime counter exposed by the exporter for dropped attributes. */
export interface OTelDroppedAttributeMetrics {
  readonly droppedAttributes: number;
  readonly droppedEventAttributes: number;
}

/**
 * Named return type for {@link createOTelExporter}. Extracted from an
 * anonymous intersection so downstream consumers can type-reference
 * the exporter, and future additive methods (e.g. parent-fallback
 * counters) can be declared on a single surface.
 */
export interface OTelTraceExporter extends TraceExporter {
  /** Inspect dropped-attribute counters. */
  readonly getDroppedAttributeMetrics: () => OTelDroppedAttributeMetrics;
}

/**
 * Create a TraceExporter that maps harness-one spans to OpenTelemetry spans.
 *
 * Requires an OTel SDK to be configured (e.g. `@opentelemetry/sdk-trace-node`).
 * This adapter bridges harness-one spans into the OTel API.
 *
 * @example
 * ```ts
 * import { createOTelExporter } from '@harness-one/opentelemetry';
 * import { createTraceManager } from 'harness-one/observe';
 *
 * // Assume @opentelemetry/sdk-trace-node has been initialised elsewhere.
 * const exporter = createOTelExporter({ serviceName: 'my-agent' });
 * const traces = createTraceManager({ exporters: [exporter] });
 * ```
 */
export function createOTelExporter(config?: OTelExporterConfig): OTelTraceExporter {
  const serviceName = config?.serviceName ?? 'harness-one';
  const tracer = config?.tracer ?? otelTrace.getTracer(serviceName);
  const maxEvictedParents = config?.maxEvictedParents ?? 1000;
  const logger = config?.logger;
  const maxSpans = config?.maxSpans ?? 10_000;
  // Lazy metric handle — only materialised when a metrics port was
  // supplied, so the common no-metric path stays allocation-free.
  const parentFallbackCounter = config?.metrics?.counter(
    'harness.otel.parent_fallback',
    {
      description:
        'Number of child spans whose parent was found in the evictedParents LRU rather than the live spanMap.',
    },
  );

  // Bookkeeping lives in `span-map.ts`; attribute translation / drop
  // counters live in `attributes.ts`.
  const spans = createOTelSpanMap({ maxEvictedParents });
  const attributes = createAttributeSink({
    stringifyComplexAttributes: config?.stringifyComplexAttributes ?? false,
    ...(config?.onDroppedAttribute !== undefined && { onDroppedAttribute: config.onDroppedAttribute }),
  });

  // Per-trace OTel root span, lazily created on first span of a harness
  // trace. `exportSpan` links root-less harness spans to this root so OTel
  // visualization shows a single hierarchy. `exportTrace` upgrades the root
  // (attrs + end with real endTime) instead of creating a new one.
  const traceRootMap = new Map<string, OTelSpan>();
  const traceRootCreated = new Set<string>();

  /**
   * Lazily start the OTel root span for a harness trace. Idempotent — returns
   * the existing root if one is already registered.
   *
   * Passes `startTime: new Date(startTime)` so the OTel span reflects
   * harness-one's actual start timestamp rather than the export time.
   */
  function ensureTraceRoot(traceId: string, name: string, startTime: number): OTelSpan {
    const existing = traceRootMap.get(traceId);
    if (existing) return existing;
    let root!: OTelSpan;
    tracer.startActiveSpan(
      name,
      { startTime: new Date(startTime) },
      (otelSpan) => { root = otelSpan; },
    );
    traceRootMap.set(traceId, root);
    traceRootCreated.add(traceId);
    return root;
  }

  return {
    name: 'opentelemetry',

    async exportTrace(harnessTrace: Trace): Promise<void> {
      // Upgrade the existing root (if any) with trace attributes and end it
      // at the real endTime; only create a fresh root when no span of this
      // trace has arrived yet (e.g., empty trace).
      const root = traceRootMap.get(harnessTrace.id)
        ?? ensureTraceRoot(harnessTrace.id, harnessTrace.name, harnessTrace.startTime);

      root.setAttribute('harness.trace.id', harnessTrace.id);
      root.setAttribute('harness.trace.status', harnessTrace.status);
      root.setAttribute('harness.span.count', harnessTrace.spans.length);

      // User metadata exported under `harness.meta.*`; system metadata
      // (library-authored) under `harness.sys.*` so OTel observers can
      // tell them apart.
      attributes.applyAttributes(root, Object.fromEntries([
        ...Object.entries(harnessTrace.userMetadata ?? {}).map(
          ([k, v]) => [`harness.meta.${k}`, v] as const,
        ),
        ...Object.entries(harnessTrace.systemMetadata ?? {}).map(
          ([k, v]) => [`harness.sys.${k}`, v] as const,
        ),
      ]));

      if (harnessTrace.status === 'error') {
        root.setStatus({ code: SpanStatusCode.ERROR });
      } else if (harnessTrace.status === 'completed') {
        root.setStatus({ code: SpanStatusCode.OK });
      }

      // End the OTel trace span at the real harness endTime.
      root.end(harnessTrace.endTime ? new Date(harnessTrace.endTime) : undefined);
      traceRootMap.delete(harnessTrace.id);
      traceRootCreated.delete(harnessTrace.id);

      // Clean up child spans for this trace
      spans.deleteBatch(harnessTrace.spans.map((s) => s.id));
    },

    async exportSpan(harnessSpan: Span): Promise<void> {
      // Check spanMap first, then fall back to evictedParents for already-evicted spans.
      // Split the lookup so we can observe when the fallback cache
      // actually resolved the parent — operators need a signal that
      // `maxEvictedParents` might be undersized before child spans
      // start appearing orphaned.
      let parentOTelSpan: OTelSpan | undefined;
      let parentFromEvictedCache = false;
      if (harnessSpan.parentId) {
        const live = spans.getLive(harnessSpan.parentId);
        if (live) {
          parentOTelSpan = live;
        } else {
          const fallback = spans.getEvictedParent(harnessSpan.parentId);
          if (fallback) {
            parentOTelSpan = fallback;
            parentFromEvictedCache = true;
          }
        }
      }

      if (parentFromEvictedCache && harnessSpan.parentId) {
        parentFallbackCounter?.add(1, {
          exporter: 'opentelemetry',
          source: 'evicted_parents_cache',
        });
        logger?.debug?.('otel parent fallback', {
          parent_id: harnessSpan.parentId,
          source: 'evicted_parents_cache',
          child_id: harnessSpan.id,
        });
      }

      // If parentId was specified but neither map has it, log a warning.
      // The span still gets linked under the trace root below so the
      // hierarchy stays connected — we just couldn't resolve the direct parent.
      if (harnessSpan.parentId && !parentOTelSpan) {
        const warnMsg =
          `[harness-one/opentelemetry] Parent span '${harnessSpan.parentId}' not found (evicted or never exported). ` +
          `Falling back to the trace-root context for span '${harnessSpan.id}'.`;
        if (logger) {
          logger.warn(warnMsg, { parentId: harnessSpan.parentId, spanId: harnessSpan.id });
        } else if (typeof console !== 'undefined') {
          console.warn(warnMsg);
        }
      }

      // When no parent context is available (either the span has no parentId
      // OR its parentId was not found), root this span under the per-trace
      // OTel root so the resulting hierarchy is a single tree.
      if (!parentOTelSpan) {
        parentOTelSpan = ensureTraceRoot(
          harnessSpan.traceId,
          harnessSpan.traceId, // placeholder name — upgraded on exportTrace
          harnessSpan.startTime,
        );
      }

      // Touch the evicted-parent cache so a late child doesn't evict a parent
      // that is still actively resolving descendants.
      if (harnessSpan.parentId && spans.hasEvicted(harnessSpan.parentId)) {
        spans.touchEvicted(harnessSpan.parentId);
      }

      const parentContext = parentOTelSpan
        ? otelTrace.setSpan(otelContext.active(), parentOTelSpan)
        : undefined;

      const spanCallback = (otelSpan: OTelSpan): void => {
        spans.set(harnessSpan.id, otelSpan, harnessSpan.parentId);
        // Touch the parent span to mark it as recently accessed when still live.
        if (harnessSpan.parentId && spans.hasLive(harnessSpan.parentId)) {
          spans.touch(harnessSpan.parentId);
        }

        // Safety limit to prevent unbounded growth
        if (spans.liveSize() > maxSpans) {
          spans.evictLive(1);
        }

        otelSpan.setAttribute('harness.span.id', harnessSpan.id);
        otelSpan.setAttribute('harness.trace.id', harnessSpan.traceId);
        if (harnessSpan.parentId) {
          otelSpan.setAttribute('harness.parent.id', harnessSpan.parentId);
        }

        const spanAttrs = harnessSpan.attributes ?? {};
        attributes.applyAttributes(otelSpan, spanAttrs);
        const harnessErrorCode = spanAttrs['harness.error.code'];
        if (typeof harnessErrorCode === 'string') {
          otelSpan.setAttribute('exception.type', harnessErrorCode);
        }

        for (const event of (harnessSpan.events ?? [])) {
          const attrs = attributes.filterEventAttributes(event.attributes);
          otelSpan.addEvent(event.name, attrs, new Date(event.timestamp));
        }

        if (harnessSpan.status === 'error') {
          otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        } else if (harnessSpan.status === 'completed') {
          otelSpan.setStatus({ code: SpanStatusCode.OK });
        }

        // End with real harness endTime rather than the current wall clock,
        // so downstream observability shows the correct duration.
        otelSpan.end(harnessSpan.endTime ? new Date(harnessSpan.endTime) : undefined);
      };

      // Pass startTime so the OTel span reflects harness.startTime rather
      // than the moment export happens. When a parent context exists, we
      // must still pass options and context in order.
      const options = { startTime: new Date(harnessSpan.startTime) };
      if (parentContext) {
        tracer.startActiveSpan(harnessSpan.name, options, parentContext, spanCallback);
      } else {
        tracer.startActiveSpan(harnessSpan.name, options, spanCallback);
      }
    },

    async flush(): Promise<void> {
      // Bookkeeping lives in `span-map.ts`.
      spans.migrateLiveToEvicted();
    },

    /** Inspect dropped-attribute counters. */
    getDroppedAttributeMetrics(): OTelDroppedAttributeMetrics {
      return {
        droppedAttributes: attributes.getDroppedAttributes(),
        droppedEventAttributes: attributes.getDroppedEventAttributes(),
      };
    },
  };
}
