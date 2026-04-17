/**
 * Trace and span management for observability.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { asSpanId, asTraceId, prefixedSecureId } from '../infra/ids.js';
import type { SpanId, TraceId } from '../core/types.js';
import {
  createRedactor,
  sanitizeAttributes,
  type RedactConfig,
  type Redactor,
} from '../infra/redact.js';
import type { MetricsPort } from './metrics-port.js';
import { TraceLruList } from './trace-lru-list.js';
import { createSpanAttributeKeyWarner } from './span-attribute-keys.js';
import { createTraceSampler } from './trace-sampler.js';
import { createTraceRetryCollector } from './trace-retry-collector.js';
import { createTraceExporterCoordinator } from './trace-exporter-coordinator.js';
import { toReadonlyTrace as buildReadonlyTrace } from './trace-view.js';
import type { Trace, Span, SpanEvent, SpanEventSeverity, TraceExporter } from './types.js';
import type { RetryMetrics, TraceManager } from './trace-manager-types.js';
export type { RetryMetrics, TraceManager } from './trace-manager-types.js';

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
  /**
   * Optional structured logger for trace-manager internal warnings. When set,
   * export errors without an onExportError callback route through this logger
   * instead of `console.warn`. Lets ops silence or redirect warnings at runtime.
   * Accepts an optional `debug` method for low-severity signals
   * (dead-trace attempts, LRU 80% warnings).
   */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Global sampling rate (0-1). When set and no per-exporter `shouldExport`
   * hook is provided, each trace is sampled on `endTrace()`. Runtime-adjustable
   * via the returned manager's `setSamplingRate()` method.
   */
  defaultSamplingRate?: number;
  /**
   * Maximum wall time (milliseconds) that `flush()` and `dispose()` will
   * spend waiting for pending in-flight export promises to settle before
   * abandoning them and returning. Defaults to `30_000` (30s).
   *
   * When the deadline elapses the library logs a warn via the injected
   * logger (or invokes `onExportError`) and resolves the outer promise; the
   * abandoned exports are no longer tracked but may still complete in the
   * background. Set to `0` to disable the timeout entirely (legacy
   * wait-forever behaviour).
   */
  flushTimeoutMs?: number;
  /**
   * Secret redaction applied to all USER-SUPPLIED span attributes, trace
   * metadata, and span events at the ingestion boundary. Because exporters
   * (console, OTel, Langfuse) read `span.attributes` and `trace.metadata`
   * verbatim, scrubbing here guarantees downstream observers never see
   * unredacted secrets.
   *
   * Secure-by-default: when omitted (`undefined`), the `DEFAULT_SECRET_PATTERN`
   * is active so common key names (api_key, authorization, password, token,
   * …) are scrubbed automatically. Pass a `RedactConfig` object to customize
   * (e.g. add extra keys / patterns or disable the default pattern while
   * keeping redaction active). Pass `false` to explicitly disable redaction
   * entirely — use only when exports are known to be safe (e.g. tests,
   * trusted internal sinks).
   */
  redact?: RedactConfig | false;
  /**
   * Opt-in strict mode for span creation against a dead/missing trace.
   * Default `false` returns a dead span id and increments a diagnostic
   * counter; `true` makes `startSpan()` throw `HarnessError(TRACE_NOT_FOUND)`
   * so callers can detect misuse immediately.
   */
  strictSpanCreation?: boolean;
  /**
   * Optional metrics sink for trace-manager internals. Emits counters for
   * dead-trace span creation attempts, trace LRU evictions, and span LRU
   * evictions. Defaults to no-op.
   */
  metrics?: MetricsPort;
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;
  const onExportError = config?.onExportError;
  const logger = config?.logger;
  const strictSpanCreation = config?.strictSpanCreation ?? false;
  // Resolve optional metric instruments once.
  const metricsPort = config?.metrics;
  const deadTraceSpanCounter = metricsPort?.counter('harness.trace.dead_span_attempts.total', {
    description: 'startSpan() calls that targeted a dead or missing trace',
  });
  const traceEvictionCounter = metricsPort?.counter('harness.trace.evictions.total', {
    description: 'Traces evicted from the LRU',
  });
  const spanEvictionCounter = metricsPort?.counter('harness.trace.span_evictions.total', {
    description: 'Spans evicted by trace LRU pressure',
  });
  // Default 30s flush deadline. `0` disables the cap.
  const flushTimeoutMs = config?.flushTimeoutMs ?? 30_000;
  if (!Number.isFinite(flushTimeoutMs) || flushTimeoutMs < 0) {
    throw new HarnessError(
      'flushTimeoutMs must be a finite, non-negative number (ms)',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use 0 to disable the cap or a positive millisecond value',
    );
  }
  // Build redactor once.
  //   - `redact === false`            => no redactor (explicit opt-out)
  //   - `redact === undefined`        => default redactor (secure-by-default)
  //   - `redact: RedactConfig` object => honor the config as-is
  const redactor: Redactor | undefined =
    config?.redact === false
      ? undefined
      : createRedactor(config?.redact ?? undefined);

  if (maxTraces < 1) {
    throw new HarnessError('maxTraces must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxTraces value');
  }

  // Sampling state + per-trace decision snapshot live in a dedicated sampler.
  const sampler = createTraceSampler(config?.defaultSamplingRate ?? 1);
  // Retry telemetry state machine.
  const retryCollector = createTraceRetryCollector();
  // Exporter dispatch + flush/shutdown orchestration.
  const exporterCoordinator = createTraceExporterCoordinator({
    exporters,
    flushTimeoutMs,
    ...(logger !== undefined && { logger }),
    ...(onExportError !== undefined && { onExportError }),
  });

  // Reserved span-attribute prefix warner (once per unique key).
  const maybeWarnAttributeKey = createSpanAttributeKeyWarner(logger);

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
    /** User-supplied metadata (redacted when configured). */
    userMetadata: Record<string, unknown>;
    /** Library-authored metadata used by shouldExport hooks. */
    systemMetadata: Record<string, unknown>;
    spanIds: string[];
    status: 'running' | 'completed' | 'error';
    /**
     * Sampling rate captured at trace-start. Read by `exportTraceTo()` when
     * the trace ends so a runtime `setSamplingRate()` call does NOT change
     * the sampling verdict for already-in-flight traces. Gives per-trace
     * sampling determinism — a trace started at rate=1.0 is guaranteed to
     * export even if sampling was lowered before it ended.
     */
    samplingRateSnapshot: number;
    /**
     * Sampling decision made at trace-start. When false, exporters skip this
     * trace at endTrace() time without re-evaluating the sampling rate. This
     * ensures changing the sampling rate after startTrace() does not affect
     * already-started traces.
     */
    sampled: boolean;
    /**
     * Embedded {@link LruNode} pointers. Owned and mutated by
     * {@link TraceLruList}; consumers must not touch them directly.
     */
    lruPrev: MutableTrace | null;
    lruNext: MutableTrace | null;
    inLru: boolean;
  }

  const traces = new Map<string, MutableTrace>();
  const spans = new Map<string, MutableSpan>();
  // Intrusive doubly-linked LRU extracted to `./trace-lru-list.ts`. Head is
  // the oldest entry (evict first); tail is the most recently added.
  //
  // List mutations run synchronously — there is no `await` between read and
  // write, so they are already atomic on the JS event loop. `isEvicting`
  // below guards eviction re-entrance. Any future change that introduces
  // `await` inside the list operations MUST add an async-lock.
  const lru = new TraceLruList<MutableTrace>();
  let isEvicting = false; // Re-entrance guard for eviction
  // One-shot warning state for the 80%-capacity signal.
  let spanHighWaterWarned = false;
  /**
   * Dead trace IDs — returned by `startTrace()` when every configured
   * exporter reports `isHealthy() === false`. The trace is NEVER admitted to
   * `traces`, so it cannot turn into a zombie entry that the LRU has to
   * evict later. `startSpan()`, `addSpanEvent()`, `endSpan()`, `endTrace()`
   * and friends recognise the prefix and silently no-op, preserving the
   * caller's contract (no throw, no-op handle).
   */
  const deadTraceIds = new Set<string>();
  const deadSpanIds = new Set<string>();
  const DEAD_TRACE_PREFIX = 'dead-';
  const DEAD_SPAN_PREFIX = 'dead-span-';

  // Use cryptographically secure IDs instead of predictable counter +
  // timestamp. Prevents trace/span ID enumeration in multi-tenant deployments.
  function genTraceId(): TraceId {
    return asTraceId(prefixedSecureId('tr'));
  }
  function genSpanId(): SpanId {
    return asSpanId(prefixedSecureId('sp'));
  }

  /**
   * Finalize any still-running spans for a trace before eviction.
   * Ends each running span with 'error' status and an eviction attribute.
   * Returns the list of evicted span IDs.
   */
  function finalizeSpansForEviction(trace: MutableTrace): string[] {
    const evictedSpanIds: string[] = [];
    for (const spanId of trace.spanIds) {
      const span = spans.get(spanId);
      if (span && span.status === 'running') {
        span.endTime = Date.now();
        span.status = 'error';
        span.attributes['eviction.reason'] = 'trace_evicted';
        evictedSpanIds.push(spanId);
      }
    }
    return evictedSpanIds;
  }

  function evictIfNeeded(): string[] {
    // Re-entrance guard: prevent recursive eviction calls. Callers that
    // arrive while eviction is running will observe the guard and skip. After
    // the primary eviction completes, the loop below re-checks once — catching
    // any traces added during the run.
    if (isEvicting) return [];
    isEvicting = true;

    const allEvictedSpanIds: string[] = [];

    try {
      // Loop at most twice: once for the primary eviction and once for
      // any traces admitted during the first pass.
      for (let pass = 0; pass < 2 && traces.size > maxTraces; pass++) {
        // First, evict ended traces that are no longer in the LRU list.
        for (const [id, trace] of traces) {
          if (traces.size <= maxTraces) break;
          if (trace.status !== 'running') {
            const evictedSpans = finalizeSpansForEviction(trace);
            allEvictedSpanIds.push(...evictedSpans);
            for (const spanId of trace.spanIds) {
              spans.delete(spanId);
              retryCollector.forget(spanId);
            }
            // Metric per evicted trace + span count.
            traceEvictionCounter?.add(1, { reason: 'ended' });
            if (trace.spanIds.length > 0) {
              spanEvictionCounter?.add(trace.spanIds.length, { reason: 'trace_evicted' });
            }
            traces.delete(id);
          }
        }
        // Then, evict oldest running traces from the LRU order.
        while (traces.size > maxTraces && lru.size > 0) {
          const oldest = lru.shiftOldest();
          if (!oldest) break;
          const evictedSpans = finalizeSpansForEviction(oldest);
          allEvictedSpanIds.push(...evictedSpans);
          for (const spanId of oldest.spanIds) {
            spans.delete(spanId);
            retryCollector.forget(spanId);
          }
          traceEvictionCounter?.add(1, { reason: 'lru' });
          if (oldest.spanIds.length > 0) {
            spanEvictionCounter?.add(oldest.spanIds.length, { reason: 'trace_evicted' });
          }
          traces.delete(oldest.id);
        }
      }
    } finally {
      isEvicting = false;
    }

    // Warn at 80% capacity so operators see pressure before eviction kicks
    // in. One-shot per crossing (not re-triggered until the size drops below
    // threshold).
    if (traces.size >= Math.floor(maxTraces * 0.8) && !spanHighWaterWarned) {
      spanHighWaterWarned = true;
      if (logger) {
        try {
          logger.warn('[harness-one/trace-manager] trace map above 80% capacity', {
            traces: traces.size,
            spans: spans.size,
            maxTraces,
          });
        } catch { /* non-fatal */ }
      }
    } else if (traces.size < Math.floor(maxTraces * 0.8) && spanHighWaterWarned) {
      spanHighWaterWarned = false;
    }

    return allEvictedSpanIds;
  }


  function toReadonlyTrace(mt: MutableTrace): Trace {
    return buildReadonlyTrace(mt, (id) => spans.get(id));
  }

  return {
    startTrace(name: string, metadata?: Record<string, unknown>): TraceId {
      // If the caller has configured ≥1 exporter AND every exporter declares
      // an `isHealthy()` hook AND every one of those hooks returns false,
      // there is no point admitting this trace to the map — no exporter will
      // consume it and the entry would sit as a zombie until LRU eviction.
      // Return a dead-trace handle instead (evict-at-birth). All later
      // operations on this id are silent no-ops.
      const allExportersUnhealthy =
        exporters.length > 0 &&
        exporters.every(
          (e) => typeof e.isHealthy === 'function' && !e.isHealthy(),
        );
      if (allExportersUnhealthy) {
        const deadId = asTraceId(`${DEAD_TRACE_PREFIX}${genTraceId()}`);
        deadTraceIds.add(deadId);
        return deadId;
      }

      const id = genTraceId();
      // User metadata is scrubbed at ingestion so exporters (console, OTel,
      // Langfuse) never observe secrets.
      const userMeta = metadata
        ? (redactor ? sanitizeAttributes(metadata, redactor) : { ...metadata })
        : {};
      // Make the sampling decision at trace-start so that changing the
      // sampling rate after startTrace() does not affect already-started
      // traces. Head verdict is snapshotted on the mutable trace record.
      const { rateSnapshot, sampled } = sampler.decide();
      const mutable: MutableTrace = {
        id,
        name,
        startTime: Date.now(),
        userMetadata: userMeta,
        systemMetadata: {},
        spanIds: [],
        status: 'running',
        // Snapshot current sampling rate at trace-start.
        samplingRateSnapshot: rateSnapshot,
        sampled,
        lruPrev: null,
        lruNext: null,
        inLru: false,
      };
      traces.set(id, mutable);
      lru.append(mutable);
      // Actively evict even if exporters are fully healthy — otherwise
      // `maxTraces` is only ever reached after a trace ends, letting the map
      // grow when N concurrent running traces exceed capacity. With active
      // eviction the oldest still-running trace is finalized early so memory
      // tracks `maxTraces` even under bursty load or hung exporters.
      evictIfNeeded();
      return asTraceId(id);
    },

    startSpan(traceId: string, name: string, parentId?: string): SpanId {
      // Dead trace handle — return a dead span id that every later operation
      // treats as a no-op. Mirrors startTrace's evict-at-birth semantics so
      // callers don't need special-casing.
      if (deadTraceIds.has(traceId)) {
        // Not a silent no-op. Either throw (strict) or emit an observable
        // counter + debug log (lenient default).
        if (strictSpanCreation) {
          throw new HarnessError(
            `Trace is dead (all exporters unhealthy at startTrace time): ${traceId}`,
            HarnessErrorCode.TRACE_NOT_FOUND,
            'Ensure at least one exporter reports isHealthy() === true before starting traces',
          );
        }
        deadTraceSpanCounter?.add(1, { reason: 'trace_dead' });
        if (logger) {
          try { (logger as { debug?: (m: string, meta?: Record<string, unknown>) => void }).debug?.('[harness-one/trace-manager] startSpan on dead trace', { traceId, name }); } catch { /* logger non-fatal */ }
        }
        const deadSpanId = asSpanId(`${DEAD_SPAN_PREFIX}${genSpanId()}`);
        deadSpanIds.add(deadSpanId);
        return deadSpanId;
      }
      const trace = traces.get(traceId);
      if (!trace) {
        // Missing-trace is observable even in strict=false path.
        deadTraceSpanCounter?.add(1, { reason: 'trace_missing' });
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          HarnessErrorCode.TRACE_NOT_FOUND,
          'Start a trace before creating spans',
        );
      }
      // Validate parentId exists as a span in this trace. Dead-span parent
      // ids are accepted silently — they reflect the same evict-at-birth
      // semantics as the trace itself.
      if (parentId !== undefined && !deadSpanIds.has(parentId)) {
        const parentSpan = spans.get(parentId);
        if (!parentSpan || parentSpan.traceId !== traceId) {
          throw new HarnessError(
            `Parent span not found: ${parentId} in trace ${traceId}`,
            HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
            'Start the parent span before creating child spans',
          );
        }
      }
      const id = genSpanId();
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
      return asSpanId(id);
    },

    addSpanEvent(spanId: string, event: Omit<SpanEvent, 'timestamp'>): void {
      // dead span — no-op
      if (deadSpanIds.has(spanId)) return;
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
          'Start a span before adding events',
        );
      }
      // Scrub event attributes before storing. Event names are plain strings
      // and are not redacted. Preserves optional severity.
      const safeAttrs = event.attributes
        ? (redactor ? sanitizeAttributes(event.attributes, redactor) : event.attributes)
        : undefined;
      const severity: SpanEventSeverity | undefined = event.severity;
      const storedEvent: SpanEvent = {
        name: event.name,
        timestamp: Date.now(),
        ...(safeAttrs !== undefined && { attributes: safeAttrs }),
        ...(severity !== undefined && { severity }),
      };
      span.events.push(storedEvent);

      // Track adapter_retry events for aggregate telemetry.
      if (event.name === 'adapter_retry') {
        retryCollector.noteRetry(spanId);
      }
    },

    setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void {
      // dead span — no-op
      if (deadSpanIds.has(spanId)) return;
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
          'Start a span before setting attributes',
        );
      }
      // Lint-style warning for non-reserved keys. One warning per distinct
      // key per tracker — surfaces drift early without spamming. Skipped when
      // no logger is configured (avoids stderr noise).
      if (logger) {
        for (const k of Object.keys(attributes)) maybeWarnAttributeKey(k);
      }
      // Scrub attributes at ingestion — downstream exporters read
      // span.attributes verbatim, so redacting here guarantees no leak.
      const safeAttrs = redactor ? sanitizeAttributes(attributes, redactor) : attributes;
      Object.assign(span.attributes, safeAttrs);
    },

    setTraceSystemMetadata(traceId: string, metadata: Record<string, unknown>): void {
      // dead trace — no-op
      if (deadTraceIds.has(traceId)) return;
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          HarnessErrorCode.TRACE_NOT_FOUND,
          'Start a trace before setting system metadata',
        );
      }
      // systemMetadata is library-authored and NOT redacted. Caller owns
      // correctness. Do still drop prototype-polluting keys via redactor if
      // one is configured (shape-only safety, no secret scrubbing).
      for (const [k, v] of Object.entries(metadata)) {
        if (redactor && redactor.isPollutingKey(k)) continue;
        trace.systemMetadata[k] = v;
      }
    },

    endSpan(spanId: string, status?: 'completed' | 'error'): void {
      // dead span — no-op (and forget the id so the set doesn't grow).
      if (deadSpanIds.has(spanId)) {
        deadSpanIds.delete(spanId);
        return;
      }
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
          'Start a span before ending it',
        );
      }
      span.endTime = Date.now();
      const finalStatus = status ?? 'completed';
      span.status = finalStatus;

      // Attribute retry outcome now that the span is complete.
      retryCollector.noteSpanEnded(spanId, finalStatus);

      // Build one frozen readonly snapshot and reuse it across every
      // exporter (avoids N allocations for the same payload with N exporters).
      // Freezing both the snapshot envelope AND the `events` array means
      // exporters cannot mutate the shared reference (or each other's view
      // of it). `attributes` is kept mutation-free by assigning a shallow
      // copy; freezing it outright would be a breaking change for exporters
      // that still expect a writable attribute bag.
      const snapshot: Span = Object.freeze({
        id: span.id,
        traceId: span.traceId,
        ...(span.parentId !== undefined && { parentId: span.parentId }),
        name: span.name,
        startTime: span.startTime,
        ...(span.endTime !== undefined && { endTime: span.endTime }),
        attributes: { ...span.attributes },
        events: Object.freeze(span.events.slice()) as readonly SpanEvent[],
        status: span.status,
      });
      exporterCoordinator.exportSpan(snapshot);
    },

    endTrace(traceId: string, status?: 'completed' | 'error'): void {
      // dead trace — no-op (and forget the id so the set doesn't grow).
      if (deadTraceIds.has(traceId)) {
        deadTraceIds.delete(traceId);
        return;
      }
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          HarnessErrorCode.TRACE_NOT_FOUND,
          'Start a trace before ending it',
        );
      }
      trace.endTime = Date.now();
      trace.status = status ?? 'completed';

      // O(1) linked-list unlink.
      lru.remove(trace);

      // Export — respects isHealthy(), shouldExport(), lazy initialize(), and sampling.
      // Pass the sampling decision made at trace-start so concurrent
      // `setSamplingRate()` calls can't flip the decision.
      exporterCoordinator.exportTrace(toReadonlyTrace(trace), trace.sampled);
    },

    getTrace(traceId: string): Trace | undefined {
      const trace = traces.get(traceId);
      if (!trace) return undefined;
      return toReadonlyTrace(trace);
    },

    getActiveSpans(olderThanMs?: number): Array<{ id: string; traceId: string; name: string; startTime: number }> {
      const active: Array<{ id: string; traceId: string; name: string; startTime: number }> = [];
      const now = Date.now();
      for (const span of spans.values()) {
        if (span.status === 'running') {
          // When olderThanMs is provided, only include spans running longer
          // than the specified duration (stale span detection).
          if (olderThanMs !== undefined && (now - span.startTime) < olderThanMs) {
            continue;
          }
          active.push({ id: span.id, traceId: span.traceId, name: span.name, startTime: span.startTime });
        }
      }
      return active;
    },

    async flush(): Promise<void> {
      // Settle pending in-flight exports before asking exporters to flush — a
      // span may have been fired microseconds ago and we don't want flush()
      // to race past it. `Promise.allSettled(pendingExports)` accepts any
      // iterable, so we pass the Set directly instead of materialising a
      // fresh array on every loop turn. Loop because a settled export's
      // Drain pending exports + run each exporter's flush() with per-exporter
      // deadlines. Delegated to the coordinator so the trace-manager core has
      // no timer/promise-tracking code of its own.
      await exporterCoordinator.flushAll();
    },

    async initialize(): Promise<void> {
      await exporterCoordinator.initializeAll();
    },

    setSamplingRate(rate: number): void {
      sampler.setRate(rate);
    },

    // Snapshot accessor (tests + introspection).
    getSamplingRate(): number {
      return sampler.getRate();
    },

    getRetryMetrics(): RetryMetrics {
      return retryCollector.snapshot();
    },

    async dispose(): Promise<void> {
      // Coordinator drains in-flight exports, flushes each exporter, then
      // calls `shutdown()` with per-exporter deadlines.
      await exporterCoordinator.shutdownAll();
      // Clear internal maps so the process can exit cleanly.
      traces.clear();
      spans.clear();
      lru.clear();
      deadTraceIds.clear();
      deadSpanIds.clear();
      retryCollector.reset();
    },
  };
}

export { createConsoleExporter, createNoOpExporter } from './trace-builtins.js';
