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
import type { TraceExporter, Trace, Span, MetricsPort } from 'harness-one/observe';

/**
 * OBS-011: Mapping from harness-one cache-monitor metric names to
 * OpenTelemetry semantic-convention-friendly names. Documented here so both
 * the adapter and downstream dashboards share a single source of truth.
 *
 * | harness-one key | OTel semconv key  |
 * |-----------------|-------------------|
 * | hitRate         | cache.hit_ratio   |
 * | missRate        | cache.miss_ratio  |
 * | avgLatency      | cache.latency_ms  |
 *
 * Applied in `setSpanAttributes` when the span attribute name matches one of
 * the legacy keys. Primitive-valued only.
 */
const CACHE_ATTR_RENAME: Record<string, string> = {
  hitRate: 'cache.hit_ratio',
  missRate: 'cache.miss_ratio',
  avgLatency: 'cache.latency_ms',
};

/**
 * F18b: Minimal logger interface accepted by the OTel exporter.
 * When provided, parent-linking warnings and diagnostics are routed here
 * instead of falling back to `console.warn`.
 *
 * Wave-13 J-3: Adds optional `debug` so parent-fallback events can be
 * surfaced without spamming `warn`. Both methods are optional so existing
 * `warn`-only loggers continue to satisfy the type.
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
   * Wave-12 P1-9: Parent mapping is retained until LRU evicts. Increase this
   * value if deep trees lose hierarchy (symptom: repeated `Parent span '...'
   * not found` warnings for expected-alive parents).
   */
  readonly maxEvictedParents?: number;
  /**
   * @deprecated Wave-12 P1-9 — **no-op, kept for API/source compatibility.**
   *
   * Time-based expiry was removed because it races with child-span arrival:
   * a parent could expire while its child was being exported, orphaning the
   * subtree. Retention is now purely size-based (LRU on `maxEvictedParents`).
   * Supplying this option has no runtime effect; `maxEvictedParents` is the
   * only retention knob. Wave-13 J-1 reaffirmed the `@deprecated` tag so
   * downstream tsc / IDE tooling surfaces the deprecation at the call site.
   *
   * @see maxEvictedParents
   */
  readonly evictedParentsTtlMs?: number;
  /** Maximum number of active spans to retain before LRU eviction. Defaults to 10000. */
  readonly maxSpans?: number;
  /**
   * OBS-004: Callback invoked when a non-primitive attribute is dropped
   * during export. Receives the offending key and type. When unset, falls back
   * to `console.debug` for compatibility. Lets ops route dropped-attribute
   * signals into their metrics pipeline.
   */
  readonly onDroppedAttribute?: (info: { key: string; type: string; where: 'attribute' | 'event' }) => void;
  /**
   * F18b: Optional logger for diagnostic warnings (e.g., parent-linking
   * fallback). Falls back to `console.warn` when not provided.
   */
  readonly logger?: OTelExporterLogger;
  /**
   * Wave-12 P2-12: When `true`, non-primitive attributes (objects, arrays) are
   * `JSON.stringify()`-ed and attached to the span as string attributes rather
   * than being dropped. Functions, symbols, and circular references remain
   * dropped (JSON.stringify would throw on the latter). Defaults to `false` so
   * the historical "drop non-primitives" behaviour is preserved — enabling it
   * widens the payload surface and should be opt-in.
   */
  readonly stringifyComplexAttributes?: boolean;
  /**
   * Wave-13 J-3: Optional metrics port. When supplied, the exporter emits:
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

/** OBS-004: Runtime counter exposed by the exporter for dropped attributes. */
export interface OTelDroppedAttributeMetrics {
  readonly droppedAttributes: number;
  readonly droppedEventAttributes: number;
}

/**
 * Wave-13 J-2: Named return type for {@link createOTelExporter}. Extracted
 * from an anonymous intersection so downstream consumers can type-reference
 * the exporter, and future additive methods (e.g. parent-fallback counters)
 * can be declared on a single surface.
 */
export interface OTelTraceExporter extends TraceExporter {
  /** OBS-004: inspect dropped-attribute counters. */
  readonly getDroppedAttributeMetrics: () => OTelDroppedAttributeMetrics;
}

/**
 * Create a TraceExporter that maps harness-one spans to OpenTelemetry spans.
 *
 * Requires an OTel SDK to be configured (e.g., @opentelemetry/sdk-trace-node).
 * This adapter bridges harness-one spans into the OTel API.
 */
export function createOTelExporter(config?: OTelExporterConfig): OTelTraceExporter {
  const serviceName = config?.serviceName ?? 'harness-one';
  const tracer = config?.tracer ?? otelTrace.getTracer(serviceName);
  const maxEvictedParents = config?.maxEvictedParents ?? 1000;
  // Wave-12 P1-9: `evictedParentsTtlMs` intentionally ignored. The previous
  // TTL-based sweep raced with in-flight children and could orphan subtrees.
  // Size-based LRU on `maxEvictedParents` is now the only retention policy.
  const onDroppedAttribute = config?.onDroppedAttribute;
  const logger = config?.logger;
  // Wave-12 P2-12: opt-in JSON-stringify fallback for non-primitive attributes.
  const stringifyComplexAttributes = config?.stringifyComplexAttributes ?? false;
  // Wave-13 J-3: lazy metric handle — only materialised when a metrics port
  // was supplied, so the common no-metric path stays allocation-free.
  const parentFallbackCounter = config?.metrics?.counter(
    'harness.otel.parent_fallback',
    {
      description:
        'Number of child spans whose parent was found in the evictedParents LRU rather than the live spanMap.',
    },
  );

  // OBS-004: Track dropped-attribute counts for operator visibility.
  let droppedAttributes = 0;
  let droppedEventAttributes = 0;

  // Track created OTel spans so children can reference parents
  const spanMap = new Map<string, OTelSpan>();
  // Track parent relationships for eviction: childId -> parentId
  const spanParentMap = new Map<string, string>();
  // Track last access time per span for LRU eviction
  const spanAccessTime = new Map<string, number>();
  // Lightweight fallback for evicted parents: spanId -> OTel span
  // Prevents children from being orphaned when their parent was evicted from spanMap.
  const evictedParents = new Map<string, OTelSpan>();
  // Access timestamps for LRU eviction of evictedParents
  const evictedParentsAccessTime = new Map<string, number>();

  function touchSpan(spanId: string): void {
    // Delete-then-reinsert to maintain Map insertion order as LRU order.
    // The first entries in the Map are always the least recently used.
    spanAccessTime.delete(spanId);
    spanAccessTime.set(spanId, Date.now());
  }

  /**
   * Wave-12 P1-9: Look up an evicted parent span. Previously this performed a
   * lazy TTL check that could expire a parent mid-export, orphaning the child
   * subtree. Retention is now purely size-based (LRU), so lookup is a simple
   * Map access.
   */
  function getEvictedParent(spanId: string): OTelSpan | undefined {
    return evictedParents.get(spanId);
  }

  function evictSpans(count: number): void {
    // O(count) eviction using Map insertion order as LRU order.
    // With the delete-then-reinsert pattern in touchSpan(), the first entries
    // in spanAccessTime are always the least recently used.
    let evicted = 0;
    for (const [id] of spanAccessTime) {
      if (evicted >= count) break;
      if (!spanMap.has(id)) {
        spanAccessTime.delete(id);
        continue;
      }

      // Save to evictedParents before removing
      const otelSpan = spanMap.get(id);
      if (otelSpan) {
        evictedParents.set(id, otelSpan);
        evictedParentsAccessTime.delete(id);
        evictedParentsAccessTime.set(id, Date.now());
        // Lazy purge: only purge if over limit
        if (evictedParents.size > maxEvictedParents) {
          // Evict oldest 10% from evictedParents using Map insertion order
          const epEvictCount = Math.ceil(maxEvictedParents * 0.1);
          let removed = 0;
          for (const [epId] of evictedParentsAccessTime) {
            if (removed >= epEvictCount) break;
            evictedParents.delete(epId);
            evictedParentsAccessTime.delete(epId);
            // Clean up orphaned parent references pointing to this evicted parent
            for (const [childId, parentId] of spanParentMap) {
              if (parentId === epId) spanParentMap.delete(childId);
            }
            removed++;
          }
        }
      }

      spanMap.delete(id);
      spanParentMap.delete(id);
      spanAccessTime.delete(id);
      evicted++;
    }
  }

  function setSpanAttributes(otelSpan: OTelSpan, attrs: Record<string, unknown>): void {
    for (const [rawKey, value] of Object.entries(attrs)) {
      // OBS-011: translate legacy cache-monitor names to OTel semconv keys.
      const key = CACHE_ATTR_RENAME[rawKey] ?? rawKey;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        otelSpan.setAttribute(key, value);
      } else if (value !== undefined && value !== null) {
        // Wave-12 P2-12: optional JSON-stringify fallback. Only attempted for
        // object-shaped values — functions/symbols still cannot be represented
        // as string attributes without silently producing "[object Object]"
        // or similar, so we continue to drop them. A failing JSON.stringify
        // (circular refs, throwing getters) falls through to the drop path.
        if (stringifyComplexAttributes && typeof value === 'object') {
          try {
            otelSpan.setAttribute(key, JSON.stringify(value));
            continue;
          } catch {
            // fall through to drop path below
          }
        }
        // OBS-004: track and surface dropped non-primitive attributes rather
        // than silently discarding them. Fall back to console.debug so
        // existing tests / deployments still see the signal.
        droppedAttributes++;
        if (onDroppedAttribute) {
          onDroppedAttribute({ key, type: typeof value, where: 'attribute' });
        } else if (typeof console !== 'undefined') {
          console.debug(`Dropping non-primitive attribute '${key}' of type '${typeof value}'`);
        }
      }
    }
  }

  // CQ-002: Per-trace OTel root span, lazily created on first span of a
  // harness trace. `exportSpan` links root-less harness spans to this root
  // so OTel visualization shows a single hierarchy. `exportTrace` upgrades
  // the root (attrs + end with real endTime) instead of creating a new one.
  const traceRootMap = new Map<string, OTelSpan>();
  const traceRootCreated = new Set<string>();

  /**
   * Lazily start the OTel root span for a harness trace. Idempotent — returns
   * the existing root if one is already registered.
   *
   * CQ-001: Passes `startTime: new Date(startTime)` so the OTel span reflects
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
      // CQ-002: upgrade the existing root (if any) with trace attributes and
      // end it at the real endTime; only create a fresh root when no span of
      // this trace has arrived yet (e.g., empty trace).
      const root = traceRootMap.get(harnessTrace.id)
        ?? ensureTraceRoot(harnessTrace.id, harnessTrace.name, harnessTrace.startTime);

      root.setAttribute('harness.trace.id', harnessTrace.id);
      root.setAttribute('harness.trace.status', harnessTrace.status);
      root.setAttribute('harness.span.count', harnessTrace.spans.length);

      setSpanAttributes(root, Object.fromEntries(
        Object.entries(harnessTrace.metadata).map(([k, v]) => [`harness.meta.${k}`, v]),
      ));

      if (harnessTrace.status === 'error') {
        root.setStatus({ code: SpanStatusCode.ERROR });
      } else if (harnessTrace.status === 'completed') {
        root.setStatus({ code: SpanStatusCode.OK });
      }

      // CQ-001: end the OTel trace span at the real harness endTime.
      root.end(harnessTrace.endTime ? new Date(harnessTrace.endTime) : undefined);
      traceRootMap.delete(harnessTrace.id);
      traceRootCreated.delete(harnessTrace.id);

      // Clean up child spans for this trace
      for (const s of harnessTrace.spans) {
        spanMap.delete(s.id);
        spanParentMap.delete(s.id);
        spanAccessTime.delete(s.id);
      }
    },

    async exportSpan(harnessSpan: Span): Promise<void> {
      // Check spanMap first, then fall back to evictedParents for already-evicted spans.
      // Wave-13 J-3: split the lookup so we can observe when the fallback
      // cache actually resolved the parent. Previously this was silent —
      // operators had no signal that `maxEvictedParents` might be
      // undersized until child spans started appearing orphaned.
      let parentOTelSpan: OTelSpan | undefined;
      let parentFromEvictedCache = false;
      if (harnessSpan.parentId) {
        const live = spanMap.get(harnessSpan.parentId);
        if (live) {
          parentOTelSpan = live;
        } else {
          const fallback = getEvictedParent(harnessSpan.parentId);
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
      // The span still gets linked under the trace root below (CQ-002) so the
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

      // CQ-002: when no parent context is available (either the span has no
      // parentId OR its parentId was not found), root this span under the
      // per-trace OTel root so the resulting hierarchy is a single tree.
      if (!parentOTelSpan) {
        parentOTelSpan = ensureTraceRoot(
          harnessSpan.traceId,
          harnessSpan.traceId, // placeholder name — upgraded on exportTrace
          harnessSpan.startTime,
        );
      }

      // Update evictedParents access time when the parent was found there
      // Use delete-then-reinsert to maintain LRU order in the Map
      if (harnessSpan.parentId && evictedParents.has(harnessSpan.parentId) && parentOTelSpan) {
        evictedParentsAccessTime.delete(harnessSpan.parentId);
        evictedParentsAccessTime.set(harnessSpan.parentId, Date.now());
      }

      const parentContext = parentOTelSpan
        ? otelTrace.setSpan(otelContext.active(), parentOTelSpan)
        : undefined;

      const spanCallback = (otelSpan: OTelSpan): void => {
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
        if (spanMap.size > (config?.maxSpans ?? 10_000)) {
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
              } else {
                // OBS-004: track dropped event attributes too.
                droppedEventAttributes++;
                if (onDroppedAttribute) {
                  onDroppedAttribute({ key: k, type: typeof v, where: 'event' });
                }
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

        // CQ-001: end with real harness endTime rather than the current wall
        // clock, so downstream observability shows the correct duration.
        otelSpan.end(harnessSpan.endTime ? new Date(harnessSpan.endTime) : undefined);
      };

      // CQ-001: pass startTime so the OTel span reflects harness.startTime
      // rather than the moment export happens. When a parent context exists,
      // we must still pass options and context in order.
      const options = { startTime: new Date(harnessSpan.startTime) };
      if (parentContext) {
        tracer.startActiveSpan(harnessSpan.name, options, parentContext, spanCallback);
      } else {
        tracer.startActiveSpan(harnessSpan.name, options, spanCallback);
      }
    },

    async flush(): Promise<void> {
      // Snapshot current spans before clearing
      const snapshot = new Map(spanMap);

      // Clear maps atomically
      spanMap.clear();
      spanParentMap.clear();
      spanAccessTime.clear();

      // Migrate snapshot to evictedParents for child linking
      for (const [id, span] of snapshot) {
        evictedParents.set(id, span);
        evictedParentsAccessTime.delete(id);
        evictedParentsAccessTime.set(id, Date.now());
      }

      // Wave-12 P1-9: purge-by-TTL removed — the race with in-flight child
      // exports caused orphaned subtrees. Size-based LRU is the only retention
      // policy.
      if (evictedParents.size > maxEvictedParents) {
        const excess = evictedParents.size - maxEvictedParents;
        let removed = 0;
        for (const [epId] of evictedParentsAccessTime) {
          if (removed >= excess) break;
          evictedParents.delete(epId);
          evictedParentsAccessTime.delete(epId);
          removed++;
        }
      }
    },

    /** OBS-004: inspect dropped-attribute counters. */
    getDroppedAttributeMetrics(): OTelDroppedAttributeMetrics {
      return { droppedAttributes, droppedEventAttributes };
    },
  };
}
