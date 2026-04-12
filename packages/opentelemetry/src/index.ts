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
  /**
   * Maximum number of evicted parent span contexts to retain for child linking.
   * When a parent span is evicted from the LRU cache but a child arrives later,
   * this fallback map provides the minimal context needed to link them correctly.
   * Defaults to 1000.
   */
  readonly maxEvictedParents?: number;
  /**
   * Time-to-live in milliseconds for entries in the evicted parents fallback map.
   * After this duration, evicted parent entries are considered stale and will be
   * removed on the next read or insertion. Defaults to 300000 (5 minutes).
   */
  readonly evictedParentsTtlMs?: number;
  /** Maximum number of active spans to retain before LRU eviction. Defaults to 10000. */
  readonly maxSpans?: number;
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
  const maxEvictedParents = config?.maxEvictedParents ?? 1000;
  const evictedParentsTtlMs = config?.evictedParentsTtlMs ?? 300_000; // 5 minutes

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

  /** Remove evictedParents entries older than the configured TTL. */
  function purgeStaleEvictedParents(): void {
    // Only purge when map is large enough to warrant cleanup
    if (evictedParentsAccessTime.size <= maxEvictedParents) return;
    const now = Date.now();
    for (const [spanId, timestamp] of evictedParentsAccessTime) {
      if (now - timestamp > evictedParentsTtlMs) {
        evictedParents.delete(spanId);
        evictedParentsAccessTime.delete(spanId);
      } else {
        // Map is ordered by insertion time; entries after this are newer
        break;
      }
    }
  }

  /** Get an evicted parent span, returning undefined if the entry has expired. */
  function getEvictedParent(spanId: string): OTelSpan | undefined {
    const timestamp = evictedParentsAccessTime.get(spanId);
    if (timestamp === undefined) return undefined;
    if (Date.now() - timestamp > evictedParentsTtlMs) {
      // Entry has expired -- remove it lazily
      evictedParents.delete(spanId);
      evictedParentsAccessTime.delete(spanId);
      return undefined;
    }
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
      // Check spanMap first, then fall back to evictedParents for already-evicted spans
      const parentOTelSpan = harnessSpan.parentId
        ? (spanMap.get(harnessSpan.parentId) ?? getEvictedParent(harnessSpan.parentId))
        : undefined;

      // If parentId was specified but neither map has it, log a warning and create root span
      if (harnessSpan.parentId && !parentOTelSpan) {
        if (typeof console !== 'undefined') {
          console.warn(
            `[harness-one/opentelemetry] Parent span '${harnessSpan.parentId}' not found (evicted or never exported). ` +
            `Creating span '${harnessSpan.id}' as a root span.`,
          );
        }
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

      // Purge stale entries first (no-op if under threshold)
      purgeStaleEvictedParents();

      // Purge if still over limit using Map insertion order (oldest first)
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
  };
}
