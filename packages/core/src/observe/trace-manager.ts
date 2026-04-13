/**
 * Trace and span management for observability.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import { asSpanId, asTraceId } from '../_internal/ids.js';
import type { SpanId, TraceId } from '../core/types.js';
import {
  createRedactor,
  sanitizeAttributes,
  type RedactConfig,
  type Redactor,
} from '../_internal/redact.js';
import { createLazyAsync, type LazyAsync } from '../_internal/lazy-async.js';
import type { Trace, Span, SpanEvent, SpanEventSeverity, TraceExporter } from './types.js';

/** Retry telemetry aggregates exposed via `getRetryMetrics()`. */
export interface RetryMetrics {
  /** Total retry attempts observed across all spans. */
  readonly totalRetries: number;
  /** Retries that were followed by a successful span completion. */
  readonly successAfterRetry: number;
  /** Retries that ultimately failed (span ended with error status). */
  readonly failedAfterRetries: number;
}

/** Manager for creating and tracking traces and spans. */
export interface TraceManager {
  /**
   * Start a new trace. Returns the trace ID.
   *
   * SEC-016: The `metadata` argument is treated as USER metadata — it is
   * redacted (if configured) and surfaced on `trace.metadata` as well as
   * `trace.userMetadata`. System-authored metadata is emitted via
   * `setTraceSystemMetadata()` and kept on `trace.systemMetadata`.
   */
  startTrace(name: string, metadata?: Record<string, unknown>): TraceId;
  /** Start a new span within a trace. Returns the span ID. */
  startSpan(traceId: string, name: string, parentId?: string): SpanId;
  /** Add an event to a span. */
  addSpanEvent(spanId: string, event: Omit<SpanEvent, 'timestamp'>): void;
  /** Set attributes on a span. */
  setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void;
  /**
   * SEC-016: Attach library-controlled metadata to a trace. Keys written here
   * land on `trace.systemMetadata` and are never redacted. `shouldExport()`
   * sampling hooks MUST read only `systemMetadata` so users can't manipulate
   * sampling decisions by injecting metadata keys.
   */
  setTraceSystemMetadata(traceId: string, metadata: Record<string, unknown>): void;
  /** End a span. */
  endSpan(spanId: string, status?: 'completed' | 'error'): void;
  /** End a trace. */
  endTrace(traceId: string, status?: 'completed' | 'error'): void;
  /** Get a trace by ID. */
  getTrace(traceId: string): Trace | undefined;
  /**
   * Get spans that are still running (not yet ended). Useful for leak detection.
   *
   * @param olderThanMs - When provided, only return spans that have been running
   *   for longer than this duration (in milliseconds), comparing startTime to
   *   Date.now(). This helps detect leaked/stale spans.
   */
  getActiveSpans(olderThanMs?: number): Array<{ id: string; traceId: string; name: string; startTime: number }>;
  /** Flush all exporters. */
  flush(): Promise<void>;
  /**
   * Eagerly invoke `initialize()` on every exporter that declares one.
   * Lazy initialization also happens automatically on first export; calling
   * `initialize()` explicitly is useful for fail-fast startup where connection
   * problems should surface immediately.
   */
  initialize(): Promise<void>;
  /**
   * Update the global sampling rate (0-1). Takes effect for traces ended
   * after the call. A per-exporter `shouldExport(trace)` hook, when present,
   * takes precedence over this global rate.
   */
  setSamplingRate(rate: number): void;
  /**
   * OBS-005: Observed retry telemetry aggregated from span events. Retries
   * are detected by events named `adapter_retry` emitted via `addSpanEvent()`
   * or by attributes on spans indicating retry outcome.
   */
  getRetryMetrics(): RetryMetrics;
  /** Dispose: flush all exporters, shut them down, and clear internal state. */
  dispose(): Promise<void>;
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
  onExportError?: (error: unknown) => void;
  /**
   * Optional structured logger for trace-manager internal warnings. When set,
   * export errors without an onExportError callback route through this logger
   * instead of `console.warn`. Lets ops silence or redirect warnings at runtime.
   */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * Global sampling rate (0-1). When set and no per-exporter `shouldExport`
   * hook is provided, each trace is sampled on `endTrace()`. Runtime-adjustable
   * via the returned manager's `setSamplingRate()` method.
   */
  defaultSamplingRate?: number;
  /**
   * SEC-007: Secret redaction applied to all USER-SUPPLIED span attributes,
   * trace metadata, and span events at the ingestion boundary. Because
   * exporters (console, OTel, Langfuse) read `span.attributes` and
   * `trace.metadata` verbatim, scrubbing here guarantees downstream observers
   * never see unredacted secrets. Set to `{}` to enable default patterns.
   */
  redact?: RedactConfig;
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;
  const onExportError = config?.onExportError;
  const logger = config?.logger;
  let samplingRate = config?.defaultSamplingRate ?? 1;
  // SEC-007: Build redactor once. `undefined` means pass-through.
  const redactor: Redactor | undefined = config?.redact
    ? createRedactor(config.redact)
    : undefined;

  if (maxTraces < 1) {
    throw new HarnessError('maxTraces must be >= 1', 'INVALID_CONFIG', 'Provide a positive maxTraces value');
  }
  if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1) {
    throw new HarnessError(
      'defaultSamplingRate must be a finite number in [0, 1]',
      'INVALID_CONFIG',
      'Provide a rate between 0 and 1 inclusive',
    );
  }

  /**
   * Lazy initialization — track which exporters have had initialize() called.
   * Exporters are initialized on first export attempt (span or trace) to keep
   * createTraceManager synchronous.
   *
   * A1-3 / LM-003: Uses `createLazyAsync` per-exporter so concurrent first
   * exports share the same in-flight init promise (stored synchronously
   * before the first await). On rejection the cache is cleared so a later
   * export retries instead of silently re-using the failed result.
   */
  const initLazies = new Map<TraceExporter, LazyAsync<void>>();

  function getInitLazy(exporter: TraceExporter): LazyAsync<void> {
    let lazy = initLazies.get(exporter);
    if (!lazy) {
      lazy = createLazyAsync(async () => {
        if (!exporter.initialize) return;
        await exporter.initialize();
      });
      initLazies.set(exporter, lazy);
    }
    return lazy;
  }

  function ensureInitialized(exporter: TraceExporter): Promise<void> {
    if (!exporter.initialize) return Promise.resolve();
    return getInitLazy(exporter)
      .get()
      .catch((err) => {
        // Initialization failure is reported but doesn't stop subsequent
        // attempts — the exporter's isHealthy() will gate future exports.
        // `createLazyAsync` already cleared the cached promise, so the next
        // call will retry from scratch.
        if (onExportError) onExportError(err);
        else if (logger) logger.warn('[harness-one] exporter initialize failed', { exporter: exporter.name, error: err });
        else console.warn('[harness-one] exporter initialize failed:', err);
      });
  }

  /**
   * ARCH-009: Reserved span-attribute prefixes. Keys outside this allow-list
   * AND outside the `user.*` namespace produce a one-time-per-key warning so
   * consumers can either:
   *   - rename the key to `user.foo` to opt out, or
   *   - request a new reserved prefix in a future release.
   *
   * This is intentionally permissive — non-prefixed keys are still accepted
   * verbatim. The only effect is the warning. Use a `Set` lookup so the
   * hot path stays O(1) per attribute.
   */
  const RESERVED_PREFIXES = [
    'system.', 'error.', 'cost.', 'user.', 'harness.', 'eviction.', 'chunk.',
  ] as const;
  const RESERVED_KEYS = new Set([
    'iteration', 'attempt', 'model', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'path', 'latencyMs', 'passed',
    'verdict', 'reason', 'events', 'parentId', 'errorCategory',
    'errorMessage', 'errorName', 'error', 'streaming', 'conversationLength',
    'adapter', 'toolCount', 'toolName', 'toolCallId', 'input', 'output',
    'usage', 'metadata', 'status', 'spanCount', 'message',
  ]);
  const warnedAttrKeys = new Set<string>();

  function maybeWarnAttributeKey(key: string): void {
    if (warnedAttrKeys.has(key)) return;
    if (RESERVED_KEYS.has(key)) return;
    for (const prefix of RESERVED_PREFIXES) {
      if (key.startsWith(prefix)) return;
    }
    warnedAttrKeys.add(key);
    const msg = `[harness-one/trace-manager] span attribute key "${key}" does not match a reserved prefix (system.*, error.*, cost.*, user.*, harness.*). Consider prefixing with "user." to silence this warning.`;
    if (logger) {
      try { logger.warn(msg, { key }); } catch { /* logger threw — ignore */ }
    }
    // Intentionally silent fallback: the warning is advisory, not fatal.
  }

  function reportExportError(err: unknown): void {
    if (onExportError) onExportError(err);
    else if (logger) logger.warn('[harness-one] trace export error', { error: err });
    else console.warn('[harness-one] trace export error:', err);
  }

  /**
   * Pending in-flight export promises. Tracked so flush() / dispose() can wait
   * for outstanding span/trace exports to settle — otherwise callers observe
   * a gap between endSpan() returning and the exporter receiving the span.
   */
  const pendingExports = new Set<Promise<unknown>>();

  function trackExport(p: Promise<unknown>): void {
    pendingExports.add(p);
    // PERF-016: `.finally()` alone can leak when the underlying promise
    // rejects and a handler in finally throws — swallow the rejection first
    // so the delete callback is guaranteed to run.
    //
    // CQ-036 (Wave 4b): route swallowed rejections to the injected logger
    // so ops can see tracker-cleanup failures. Falls back to silent swallow
    // only when no logger is configured — spurious stderr from a library is
    // worse than a loud but unnoticed warning in a fleet without logging.
    p.catch((err: unknown) => {
      if (logger) {
        try {
          logger.warn('[harness-one] export cleanup caught rejection', { error: err });
        } catch {
          // Logger itself threw — nothing more we can do without recursing.
        }
      }
      // Intentional silent fallback when no logger is injected.
    }).finally(() => pendingExports.delete(p));
  }

  function exportSpanTo(exporter: TraceExporter, span: Span): void {
    if (exporter.isHealthy && !exporter.isHealthy()) return;
    const p = ensureInitialized(exporter)
      .then(() => exporter.exportSpan(span))
      .catch(reportExportError);
    trackExport(p);
  }

  function exportTraceTo(exporter: TraceExporter, trace: Trace, sampleRate: number): void {
    if (exporter.isHealthy && !exporter.isHealthy()) return;
    if (exporter.shouldExport && !exporter.shouldExport(trace)) return;
    // LM-011 (Wave 4b): global sampling decision uses the rate captured at
    // trace-start, NOT the live `samplingRate` closure variable. Mid-flight
    // `setSamplingRate()` calls must not change the verdict for traces that
    // have already begun — otherwise ops can silently drop traces the
    // application has already decided to keep.
    if (!exporter.shouldExport && sampleRate < 1 && Math.random() >= sampleRate) return;
    const p = ensureInitialized(exporter)
      .then(() => exporter.exportTrace(trace))
      .catch(reportExportError);
    trackExport(p);
  }

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
    /** SEC-016: user-supplied metadata (redacted when configured). */
    userMetadata: Record<string, unknown>;
    /** SEC-016: library-authored metadata used by shouldExport hooks. */
    systemMetadata: Record<string, unknown>;
    spanIds: string[];
    status: 'running' | 'completed' | 'error';
    /**
     * LM-011 (Wave 4b): sampling rate captured at trace-start. Read by
     * `exportTraceTo()` when the trace ends so a runtime `setSamplingRate()`
     * call does NOT change the sampling verdict for already-in-flight traces.
     * Gives per-trace sampling determinism — a trace started at rate=1.0 is
     * guaranteed to export even if sampling was lowered before it ended.
     */
    samplingRateSnapshot: number;
    /**
     * PERF-029: doubly-linked-list pointers that implement the LRU order.
     * `prev`/`next` link into `lruHead` / `lruTail` so `appendTraceOrder()`
     * (link-at-tail) and `shiftTraceOrder()` (unlink-head) are both O(1).
     * Previously we kept a parallel string[] + Map<string, number> index and
     * rebuilt the index on every head-shift — O(n) per eviction.
     */
    lruPrev: MutableTrace | null;
    lruNext: MutableTrace | null;
    /**
     * PERF-029: membership flag. True when the node is currently linked into
     * the LRU list (not yet evicted/ended). Avoids walking the list to decide
     * whether a `removeTraceOrder(id)` call has work to do.
     */
    inLru: boolean;
  }

  const traces = new Map<string, MutableTrace>();
  const spans = new Map<string, MutableSpan>();
  // PERF-029: doubly-linked-list LRU. `lruHead` is the oldest entry (evict
  // first). `lruTail` is the most recently added. Traversal is never needed —
  // all mutations happen in O(1) via the per-trace prev/next pointers.
  let lruHead: MutableTrace | null = null;
  let lruTail: MutableTrace | null = null;
  let lruSize = 0;
  let nextId = 1;
  let isEvicting = false; // Re-entrance guard for eviction (Fix 3)
  /**
   * LM-016: Dead trace IDs — returned by `startTrace()` when every configured
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

  // OBS-005: retry telemetry aggregated from span events named `adapter_retry`.
  let retryTotalRetries = 0;
  let retrySuccessAfterRetry = 0;
  let retryFailedAfterRetries = 0;
  // Spans that had at least one adapter_retry event — consulted on endSpan
  // to count success/failure outcomes.
  const retryingSpanIds = new Set<string>();

  function genId(): string {
    return `id-${nextId++}-${Date.now().toString(36)}`;
  }

  /**
   * PERF-029: Link `trace` at the tail of the LRU list in O(1).
   */
  function appendTraceOrder(trace: MutableTrace): void {
    if (trace.inLru) return;
    trace.lruPrev = lruTail;
    trace.lruNext = null;
    if (lruTail) {
      lruTail.lruNext = trace;
    } else {
      lruHead = trace;
    }
    lruTail = trace;
    trace.inLru = true;
    lruSize++;
  }

  /**
   * PERF-029: Unlink `trace` from the LRU list in O(1) regardless of position.
   * Replaces the old swap-remove on a parallel array + index rebuild.
   */
  function removeTraceOrder(trace: MutableTrace): void {
    if (!trace.inLru) return;
    const prev = trace.lruPrev;
    const next = trace.lruNext;
    if (prev) prev.lruNext = next;
    else lruHead = next;
    if (next) next.lruPrev = prev;
    else lruTail = prev;
    trace.lruPrev = null;
    trace.lruNext = null;
    trace.inLru = false;
    lruSize--;
  }

  /**
   * PERF-029: Unlink and return the oldest LRU entry in O(1). Previously this
   * shifted the first id off a string[] and rebuilt the indexing Map for every
   * remaining entry — O(n) per eviction.
   */
  function shiftTraceOrder(): MutableTrace | undefined {
    const head = lruHead;
    if (!head) return undefined;
    removeTraceOrder(head);
    return head;
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
    // Re-entrance guard: prevent recursive eviction calls (Fix 3)
    if (isEvicting) return [];
    isEvicting = true;

    const allEvictedSpanIds: string[] = [];

    try {
      // First, evict ended traces that are no longer in the LRU list.
      // These have already been exported and are safe to remove.
      if (traces.size > maxTraces) {
        for (const [id, trace] of traces) {
          if (traces.size <= maxTraces) break;
          if (trace.status !== 'running') {
            // Finalize any still-running spans before removal (Fix 1)
            allEvictedSpanIds.push(...finalizeSpansForEviction(trace));
            for (const spanId of trace.spanIds) {
              spans.delete(spanId);
              retryingSpanIds.delete(spanId);
            }
            traces.delete(id);
          }
        }
      }
      // Then, evict oldest running traces from the LRU order if still over capacity.
      // PERF-029: shiftTraceOrder is O(1) — linked-list unlink-head.
      while (traces.size > maxTraces && lruSize > 0) {
        const oldest = shiftTraceOrder();
        if (!oldest) break;
        // Finalize any still-running spans before removal (Fix 1)
        allEvictedSpanIds.push(...finalizeSpansForEviction(oldest));
        for (const spanId of oldest.spanIds) {
          spans.delete(spanId);
          retryingSpanIds.delete(spanId);
        }
        traces.delete(oldest.id);
      }
    } finally {
      isEvicting = false;
    }

    return allEvictedSpanIds;
  }

  function toReadonlyTrace(mt: MutableTrace): Trace {
    const traceSpans: Span[] = mt.spanIds.map(sid => {
      const s = spans.get(sid);
      if (!s) return null;
      return { ...s, events: [...s.events] } as Span;
    }).filter((s): s is Span => s !== null);

    // SEC-016: `metadata` is the BACKWARD-COMPATIBLE view — callers that read
    // `trace.metadata` still see user metadata. New code consults
    // `userMetadata` / `systemMetadata` directly via the readonly alias.
    const combinedMetadata = { ...mt.userMetadata };
    // When system metadata is present, make it available under a well-known
    // namespaced key so legacy observers that only read `.metadata` still see
    // it. Namespaced to avoid collisions with user keys.
    if (Object.keys(mt.systemMetadata).length > 0) {
      (combinedMetadata as Record<string, unknown>)['__system__'] = { ...mt.systemMetadata };
    }

    const result: Trace & {
      readonly userMetadata?: Record<string, unknown>;
      readonly systemMetadata?: Record<string, unknown>;
    } = {
      id: mt.id,
      name: mt.name,
      startTime: mt.startTime,
      ...(mt.endTime !== undefined && { endTime: mt.endTime }),
      metadata: combinedMetadata,
      userMetadata: { ...mt.userMetadata },
      systemMetadata: { ...mt.systemMetadata },
      spans: traceSpans,
      status: mt.status,
    };
    return result;
  }

  return {
    startTrace(name: string, metadata?: Record<string, unknown>): TraceId {
      // LM-016: If the caller has configured ≥1 exporter AND every exporter
      // declares an `isHealthy()` hook AND every one of those hooks returns
      // false, there is no point admitting this trace to the map — no
      // exporter will consume it and the entry would sit as a zombie until
      // LRU eviction. Return a dead-trace handle instead (evict-at-birth).
      // All later operations on this id are silent no-ops.
      const allExportersUnhealthy =
        exporters.length > 0 &&
        exporters.every(
          (e) => typeof e.isHealthy === 'function' && !e.isHealthy(),
        );
      if (allExportersUnhealthy) {
        const deadId = `${DEAD_TRACE_PREFIX}${genId()}`;
        deadTraceIds.add(deadId);
        return asTraceId(deadId);
      }

      const id = genId();
      // SEC-007 + SEC-016: user metadata is scrubbed at ingestion so exporters
      // (console, OTel, Langfuse) never observe secrets.
      const userMeta = metadata
        ? (redactor ? sanitizeAttributes(metadata, redactor) : { ...metadata })
        : {};
      const mutable: MutableTrace = {
        id,
        name,
        startTime: Date.now(),
        userMetadata: userMeta,
        systemMetadata: {},
        spanIds: [],
        status: 'running',
        // LM-011 (Wave 4b): snapshot current sampling rate at trace-start.
        samplingRateSnapshot: samplingRate,
        lruPrev: null,
        lruNext: null,
        inLru: false,
      };
      traces.set(id, mutable);
      appendTraceOrder(mutable);
      // LM-007: Actively evict even if exporters are fully healthy — otherwise
      // `maxTraces` is only ever reached after a trace ends, letting the map
      // grow when N concurrent running traces exceed capacity. With active
      // eviction the oldest still-running trace is finalized early so memory
      // tracks `maxTraces` even under bursty load or hung exporters.
      evictIfNeeded();
      return asTraceId(id);
    },

    startSpan(traceId: string, name: string, parentId?: string): SpanId {
      // LM-016: Dead trace handle — return a dead span id that every later
      // operation treats as a no-op. Mirrors startTrace's evict-at-birth
      // semantics so callers don't need special-casing.
      if (deadTraceIds.has(traceId)) {
        const deadSpanId = `${DEAD_SPAN_PREFIX}${genId()}`;
        deadSpanIds.add(deadSpanId);
        return asSpanId(deadSpanId);
      }
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          'TRACE_NOT_FOUND',
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
            'SPAN_NOT_FOUND',
            'Start the parent span before creating child spans',
          );
        }
      }
      const id = genId();
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
      // LM-016: dead span — no-op
      if (deadSpanIds.has(spanId)) return;
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          'SPAN_NOT_FOUND',
          'Start a span before adding events',
        );
      }
      // SEC-007: scrub event attributes before storing. Event names are plain
      // strings and are not redacted. Preserves optional severity.
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

      // OBS-005: track adapter_retry events for aggregate telemetry.
      if (event.name === 'adapter_retry') {
        retryTotalRetries++;
        retryingSpanIds.add(spanId);
      }
    },

    setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void {
      // LM-016: dead span — no-op
      if (deadSpanIds.has(spanId)) return;
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          'SPAN_NOT_FOUND',
          'Start a span before setting attributes',
        );
      }
      // ARCH-009: lint-style warning for non-reserved keys. One warning per
      // distinct key per tracker — surfaces drift early without spamming.
      // Skipped when no logger is configured (avoids stderr noise).
      if (logger) {
        for (const k of Object.keys(attributes)) maybeWarnAttributeKey(k);
      }
      // SEC-007: scrub attributes at ingestion — downstream exporters read
      // span.attributes verbatim, so redacting here guarantees no leak.
      const safeAttrs = redactor ? sanitizeAttributes(attributes, redactor) : attributes;
      Object.assign(span.attributes, safeAttrs);
    },

    setTraceSystemMetadata(traceId: string, metadata: Record<string, unknown>): void {
      // LM-016: dead trace — no-op
      if (deadTraceIds.has(traceId)) return;
      const trace = traces.get(traceId);
      if (!trace) {
        throw new HarnessError(
          `Trace not found: ${traceId}`,
          'TRACE_NOT_FOUND',
          'Start a trace before setting system metadata',
        );
      }
      // SEC-016: systemMetadata is library-authored and NOT redacted. Caller
      // owns correctness. Do still drop prototype-polluting keys via redactor
      // if one is configured (shape-only safety, no secret scrubbing).
      for (const [k, v] of Object.entries(metadata)) {
        if (redactor && redactor.isPollutingKey(k)) continue;
        trace.systemMetadata[k] = v;
      }
    },

    endSpan(spanId: string, status?: 'completed' | 'error'): void {
      // LM-016: dead span — no-op (and forget the id so the set doesn't grow).
      if (deadSpanIds.has(spanId)) {
        deadSpanIds.delete(spanId);
        return;
      }
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          'SPAN_NOT_FOUND',
          'Start a span before ending it',
        );
      }
      span.endTime = Date.now();
      const finalStatus = status ?? 'completed';
      span.status = finalStatus;

      // OBS-005: attribute retry outcome now that the span is complete.
      if (retryingSpanIds.has(spanId)) {
        retryingSpanIds.delete(spanId);
        if (finalStatus === 'completed') {
          retrySuccessAfterRetry++;
        } else {
          retryFailedAfterRetries++;
        }
      }

      // PERF-021 / 023 / 033 / 035: Build one frozen readonly snapshot and
      // reuse it across every exporter. Previously we deep-cloned the span
      // (`{ ...span, events: [...span.events] }`) once per exporter — with
      // N exporters this was N times the allocation for the same payload.
      //
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
      for (const exporter of exporters) {
        exportSpanTo(exporter, snapshot);
      }
    },

    endTrace(traceId: string, status?: 'completed' | 'error'): void {
      // LM-016: dead trace — no-op (and forget the id so the set doesn't grow).
      if (deadTraceIds.has(traceId)) {
        deadTraceIds.delete(traceId);
        return;
      }
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

      // PERF-029: O(1) linked-list unlink; previously O(n) index rebuild.
      removeTraceOrder(trace);

      // Export — respects isHealthy(), shouldExport(), lazy initialize(), and samplingRate.
      // LM-011 (Wave 4b): pass the rate captured at trace-start so concurrent
      // `setSamplingRate()` calls can't flip the decision.
      const readonlyTrace = toReadonlyTrace(trace);
      const rateAtStart = trace.samplingRateSnapshot;
      for (const exporter of exporters) {
        exportTraceTo(exporter, readonlyTrace, rateAtStart);
      }
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
          // Fix 2: When olderThanMs is provided, only include spans running
          // longer than the specified duration (stale span detection).
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
      // span may have been fired microseconds ago and we don't want flush() to
      // race past it.
      // PERF-028: `Promise.allSettled(pendingExports)` accepts any iterable,
      // so we pass the Set directly instead of materialising a fresh array on
      // every loop turn. Loop because a settled export's `finally` hook runs
      // asynchronously and new exports can race in while we awaited.
      while (pendingExports.size > 0) {
        await Promise.allSettled(pendingExports);
      }
      await Promise.all(exporters.map(e => e.flush()));
    },

    async initialize(): Promise<void> {
      await Promise.all(exporters.map(e => ensureInitialized(e)));
    },

    setSamplingRate(rate: number): void {
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new HarnessError(
          'samplingRate must be a finite number in [0, 1]',
          'INVALID_CONFIG',
          'Provide a rate between 0 and 1 inclusive',
        );
      }
      samplingRate = rate;
    },

    getRetryMetrics(): RetryMetrics {
      return {
        totalRetries: retryTotalRetries,
        successAfterRetry: retrySuccessAfterRetry,
        failedAfterRetries: retryFailedAfterRetries,
      };
    },

    async dispose(): Promise<void> {
      // LM-001: Settle outstanding in-flight export promises before asking
      // exporters to flush — otherwise a span fired milliseconds ago may still
      // be in the exporter's queue when we clear internal state.
      // PERF-028: pass the Set directly to `Promise.allSettled` instead of
      // allocating `Array.from(pendingExports)` per turn.
      while (pendingExports.size > 0) {
        await Promise.allSettled(pendingExports);
      }
      // Flush every exporter — use allSettled so one failure doesn't block others.
      const flushResults = await Promise.allSettled(exporters.map(e => e.flush()));
      for (const result of flushResults) {
        if (result.status === 'rejected') {
          if (onExportError) {
            onExportError(result.reason);
          } else {
            console.warn('[harness-one] trace export error:', result.reason);
          }
        }
      }
      // LM-001 / LM-015: Call `shutdown()` on each exporter with a bounded
      // per-exporter timeout. A hanging exporter used to block the whole
      // dispose sequence; racing against a 5s cap keeps the DAG responsive.
      const EXPORTER_SHUTDOWN_TIMEOUT_MS = 5_000;
      for (const e of exporters) {
        if (!e.shutdown) continue;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(() => resolve('timeout'), EXPORTER_SHUTDOWN_TIMEOUT_MS);
        });
        try {
          const outcome = await Promise.race([
            Promise.resolve(e.shutdown())
              .then(() => 'ok' as const)
              .catch((err: unknown) => {
                if (onExportError) onExportError(err);
                else console.warn('[harness-one] trace export error:', err);
                return 'error' as const;
              }),
            timeoutPromise,
          ]);
          if (outcome === 'timeout') {
            const err = new Error(
              `exporter "${e.name}" shutdown timed out after ${EXPORTER_SHUTDOWN_TIMEOUT_MS}ms`,
            );
            if (onExportError) onExportError(err);
            else console.warn('[harness-one] trace export error:', err);
          }
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
      // Clear internal maps so the process can exit cleanly.
      traces.clear();
      spans.clear();
      // PERF-029: reset the linked-list LRU state.
      lruHead = null;
      lruTail = null;
      lruSize = 0;
      retryingSpanIds.clear();
      deadTraceIds.clear();
      deadSpanIds.clear();
      initLazies.clear();
      retryTotalRetries = 0;
      retrySuccessAfterRetry = 0;
      retryFailedAfterRetries = 0;
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
export function createConsoleExporter(config?: { verbose?: boolean; output?: (line: string) => void }): TraceExporter {
  const verbose = config?.verbose ?? false;
  // eslint-disable-next-line no-console
  const output = config?.output ?? console.log;
  return {
    name: 'console',
    async exportTrace(trace: Trace): Promise<void> {
      if (verbose) {
        output(`[trace] ${JSON.stringify(trace, null, 2)}`);
      } else {
        output(`[trace] ${trace.name} (${trace.status}) ${trace.spans.length} spans`);
      }
    },
    async exportSpan(span: Span): Promise<void> {
      if (verbose) {
        output(`[span] ${JSON.stringify(span, null, 2)}`);
      } else {
        output(`[span] ${span.name} (${span.status})`);
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
