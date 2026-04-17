/**
 * Trace and span management for observability.
 *
 * @module
 */

import { randomInt } from 'node:crypto';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { asSpanId, asTraceId, prefixedSecureId } from '../infra/ids.js';
import type { SpanId, TraceId } from '../core/types.js';
import {
  createRedactor,
  sanitizeAttributes,
  type RedactConfig,
  type Redactor,
} from '../infra/redact.js';
import { createLazyAsync, type LazyAsync } from '../infra/lazy-async.js';
import type { MetricsPort } from './metrics-port.js';
import { TraceLruList } from './trace-lru-list.js';
import { createSpanAttributeKeyWarner } from './span-attribute-keys.js';
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
  startSpan(traceId: TraceId | string, name: string, parentId?: string): SpanId;
  /** Add an event to a span. */
  addSpanEvent(spanId: SpanId | string, event: Omit<SpanEvent, 'timestamp'>): void;
  /** Set attributes on a span. */
  setSpanAttributes(spanId: SpanId | string, attributes: Record<string, unknown>): void;
  /**
   * P2-15: Snapshot accessor for the current global sampling rate. Primarily
   * useful in tests and for introspection tooling. Runtime adjustments go
   * through `setSamplingRate()`.
   */
  getSamplingRate(): number;
  /**
   * SEC-016: Attach library-controlled metadata to a trace. Keys written here
   * land on `trace.systemMetadata` and are never redacted. `shouldExport()`
   * sampling hooks MUST read only `systemMetadata` so users can't manipulate
   * sampling decisions by injecting metadata keys.
   */
  setTraceSystemMetadata(traceId: TraceId | string, metadata: Record<string, unknown>): void;
  /**
   * End a span.
   *
   * P1-25: **Span status must be set BEFORE calling `endSpan()`.** The status
   * passed to this call (or the default `'completed'`) is captured
   * synchronously, attached to the frozen snapshot handed to exporters, and
   * cannot be mutated after the fact. Callers that need to revise status
   * (e.g. a deferred async error-classification step) must do so before
   * invoking `endSpan()`, or start a new span for the revision.
   *
   * When `status` is omitted, `'completed'` is assumed. Pass `'error'`
   * explicitly for failure paths — in non-production builds
   * (`NODE_ENV !== 'production'`) a warning is logged if a caller appears
   * to mutate a span's effective status after end.
   */
  endSpan(spanId: SpanId | string, status?: 'completed' | 'error'): void;
  /** End a trace. */
  endTrace(traceId: TraceId | string, status?: 'completed' | 'error'): void;
  /** Get a trace by ID. */
  getTrace(traceId: TraceId | string): Trace | undefined;
  /**
   * Get spans that are still running (not yet ended). Useful for leak detection.
   *
   * @param olderThanMs - When provided, only return spans that have been running
   *   for longer than this duration (in milliseconds), comparing startTime to
   *   Date.now(). This helps detect leaked/stale spans.
   */
  getActiveSpans(olderThanMs?: number): Array<{ id: string; traceId: string; name: string; startTime: number }>;
  /**
   * Flush all exporters.
   *
   * P1-19: Bounded by the configured `flushTimeoutMs` (default 30_000). On
   * timeout, outstanding exports are abandoned (tracked promises remain but
   * are no longer awaited), a warn is logged, and the call resolves. This
   * prevents shutdown from hanging on a stuck exporter.
   */
  flush(): Promise<void>;
  /**
   * Eagerly invoke `initialize()` on every exporter that declares one.
   * Lazy initialization also happens automatically on first export; calling
   * `initialize()` explicitly is useful for fail-fast startup where connection
   * problems should surface immediately.
   */
  initialize(): Promise<void>;
  /**
   * Update the global sampling rate (0-1).
   *
   * P2-15: **Only affects traces started AFTER the call.** In-flight traces
   * keep the sampling decision captured at their original `startTrace()`
   * (stored on `trace.samplingRateSnapshot` / `trace.sampled`). This
   * guarantees per-trace determinism — a trace admitted at rate=1.0 will
   * always be exported even if the rate is later lowered to 0. A per-exporter
   * `shouldExport(trace)` hook, when present, takes precedence over this
   * global rate; a per-exporter `shouldSampleTrace(trace)` (tail hook) can
   * veto an export at `endTrace()` time.
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
   * Wave-13 C-5: accepts an optional `debug` method for low-severity signals
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
   * P1-19: Maximum wall time (milliseconds) that `flush()` and `dispose()`
   * will spend waiting for pending in-flight export promises to settle
   * before abandoning them and returning. Defaults to `30_000` (30s).
   *
   * When the deadline elapses the library logs a warn via the injected
   * logger (or invokes `onExportError`) and resolves the outer promise; the
   * abandoned exports are no longer tracked but may still complete in the
   * background. Set to `0` to disable the timeout entirely (legacy
   * wait-forever behaviour).
   */
  flushTimeoutMs?: number;
  /**
   * SEC-007: Secret redaction applied to all USER-SUPPLIED span attributes,
   * trace metadata, and span events at the ingestion boundary. Because
   * exporters (console, OTel, Langfuse) read `span.attributes` and
   * `trace.metadata` verbatim, scrubbing here guarantees downstream observers
   * never see unredacted secrets.
   *
   * Secure-by-default (T03): when omitted (`undefined`), the
   * `DEFAULT_SECRET_PATTERN` is active so common key names (api_key,
   * authorization, password, token, …) are scrubbed automatically. Pass a
   * `RedactConfig` object to customize (e.g. add extra keys / patterns or
   * disable the default pattern while keeping redaction active). Pass
   * `false` to explicitly disable redaction entirely — use only when exports
   * are known to be safe (e.g. tests, trusted internal sinks).
   */
  redact?: RedactConfig | false;
  /**
   * Wave-13 C-5: Opt-in strict mode for span creation against a dead/missing
   * trace. Default `false` preserves the historical no-silent-no-op behaviour
   * (returns a dead span id and increments a diagnostic counter). When set to
   * `true`, `startSpan()` throws `HarnessError(TRACE_NOT_FOUND)` so callers can
   * detect misuse immediately. This is additive and non-breaking.
   */
  strictSpanCreation?: boolean;
  /**
   * Wave-13 C-3 / C-10: Optional metrics sink for trace-manager internals.
   * Emits counters for dead-trace span creation attempts, trace LRU evictions,
   * and span LRU evictions. Defaults to no-op.
   */
  metrics?: MetricsPort;
}): TraceManager {
  const exporters = config?.exporters ?? [];
  const maxTraces = config?.maxTraces ?? 1000;
  const onExportError = config?.onExportError;
  const logger = config?.logger;
  const strictSpanCreation = config?.strictSpanCreation ?? false;
  // Wave-13 C-3 / C-10: resolve optional metric instruments once.
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
  let samplingRate = config?.defaultSamplingRate ?? 1;
  // P1-19: default 30s flush deadline. `0` disables the cap.
  const flushTimeoutMs = config?.flushTimeoutMs ?? 30_000;
  if (!Number.isFinite(flushTimeoutMs) || flushTimeoutMs < 0) {
    throw new HarnessError(
      'flushTimeoutMs must be a finite, non-negative number (ms)',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use 0 to disable the cap or a positive millisecond value',
    );
  }
  // SEC-007 / T03: Build redactor once.
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
  if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1) {
    throw new HarnessError(
      'defaultSamplingRate must be a finite number in [0, 1]',
      HarnessErrorCode.CORE_INVALID_CONFIG,
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
        else if (logger) {
          try { logger.warn('[harness-one] exporter initialize failed', { exporter: exporter.name, error: err }); } catch { /* logger failure non-fatal */ }
        }
        // No console.warn fallback — library code must not write to stderr.
      });
  }

  // ARCH-009: Reserved span-attribute prefix warner (once per unique key).
  const maybeWarnAttributeKey = createSpanAttributeKeyWarner(logger);

  function reportExportError(err: unknown): void {
    if (onExportError) onExportError(err);
    else if (logger) {
      try { logger.warn('[harness-one] trace export error', { error: err }); } catch { /* logger failure non-fatal */ }
    }
    // No console.warn fallback — library code must not write to stderr.
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

  function exportTraceTo(exporter: TraceExporter, trace: Trace, sampled: boolean): void {
    if (exporter.isHealthy && !exporter.isHealthy()) return;
    if (exporter.shouldExport && !exporter.shouldExport(trace)) return;
    // F12: The sampling decision is made at startTrace() time and stored on
    // the trace. Respect the stored decision rather than re-evaluating here.
    // Per-exporter shouldExport() hooks take precedence above.
    if (!exporter.shouldExport && !sampled) return;
    // P1-6: Tail-based sampling veto. Evaluated AFTER head-based decisions so
    // callers can "rescue" a head-dropped trace only by relaxing head
    // sampling — not by using a tail hook (that would defeat memory bounds).
    // Here we're already past the head gate so tail hook can only REMOVE
    // traces, matching the documented export-only contract.
    if (exporter.shouldSampleTrace) {
      let keep = true;
      try {
        keep = exporter.shouldSampleTrace(trace) !== false;
      } catch (err) {
        // A throwing tail hook is treated as an export failure: route to the
        // usual error sink and drop the export. Don't surface as "kept" so a
        // buggy sampler can't silently flood the exporter.
        reportExportError(err);
        return;
      }
      if (!keep) return;
    }
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
     * F12: Sampling decision made at trace-start. When false, exporters skip
     * this trace at endTrace() time without re-evaluating the sampling rate.
     * This ensures changing the sampling rate after startTrace() does not
     * affect already-started traces.
     */
    sampled: boolean;
    /**
     * PERF-029: embedded {@link LruNode} pointers. Owned and mutated by
     * {@link TraceLruList}; consumers must not touch them directly.
     */
    lruPrev: MutableTrace | null;
    lruNext: MutableTrace | null;
    inLru: boolean;
  }

  const traces = new Map<string, MutableTrace>();
  const spans = new Map<string, MutableSpan>();
  // PERF-029: intrusive doubly-linked LRU extracted to `./trace-lru-list.ts`.
  // Head is the oldest entry (evict first); tail is the most recently added.
  //
  // Wave-13 C-7: list mutations run synchronously — there is no `await`
  // between read and write, so they are already atomic on the JS event loop.
  // `isEvicting` below guards eviction re-entrance. Any future change that
  // introduces `await` inside the list operations MUST add an async-lock.
  const lru = new TraceLruList<MutableTrace>();
  let isEvicting = false; // Re-entrance guard for eviction (Fix 3)
  // Wave-13 C-10: one-shot warning state for the 80%-capacity signal.
  let spanHighWaterWarned = false;
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

  // SEC-002: Use cryptographically secure IDs instead of predictable
  // counter + timestamp. Prevents trace/span ID enumeration in multi-tenant
  // deployments.
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
    // Re-entrance guard: prevent recursive eviction calls (Fix 3).
    // Callers that arrive while eviction is running will observe the
    // guard and skip. After the primary eviction completes, the loop
    // below re-checks once — catching any traces added during the run.
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
              retryingSpanIds.delete(spanId);
            }
            // Wave-13 C-10: metric per evicted trace + span count.
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
            retryingSpanIds.delete(spanId);
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

    // Wave-13 C-10: warn at 80% capacity so operators see pressure before
    // eviction kicks in. One-shot per crossing (not re-triggered until the
    // size drops below threshold).
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

  /**
   * Wave-13 C-4: Invoke `exporter.flush()` with a per-exporter deadline so a
   * single slow exporter can no longer block the aggregate `flush()` beyond
   * `perExporterTimeoutMs`. A `0` timeout disables the cap for the legacy
   * wait-forever path.
   */
  function flushExporterBounded(
    exporter: TraceExporter,
    perExporterTimeoutMs: number,
  ): Promise<void> {
    if (perExporterTimeoutMs <= 0) {
      return Promise.resolve(exporter.flush()).then(() => undefined);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), perExporterTimeoutMs);
    });
    return Promise.race([
      Promise.resolve(exporter.flush()).then(() => 'ok' as const),
      timeoutPromise,
    ])
      .then((outcome) => {
        if (outcome === 'timeout') {
          const msg = `[harness-one/trace-manager] exporter "${exporter.name}" flush() timed out after ${perExporterTimeoutMs}ms`;
          if (logger) {
            try { logger.warn(msg, { exporter: exporter.name, perExporterTimeoutMs }); } catch { /* non-fatal */ }
          }
        }
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
  }

  /**
   * P1-19: Wait for every in-flight export to settle, bounded by
   * `flushTimeoutMs`. On timeout, abandon the remainder (the promises remain
   * tracked but are no longer awaited) and log a warn.
   *
   * `flushTimeoutMs === 0` disables the cap — callers explicitly opted into
   * wait-forever behaviour.
   */
  async function waitForPendingWithTimeout(phase: 'flush' | 'dispose'): Promise<void> {
    if (flushTimeoutMs === 0) {
      while (pendingExports.size > 0) {
        await Promise.allSettled(pendingExports);
      }
      return;
    }
    const deadline = Date.now() + flushTimeoutMs;
    while (pendingExports.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), remaining);
      });
      try {
        const outcome = await Promise.race([
          Promise.allSettled(pendingExports).then(() => 'settled' as const),
          timeoutPromise,
        ]);
        if (outcome === 'timeout') break;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }
    if (pendingExports.size > 0) {
      const abandoned = pendingExports.size;
      const msg = `[harness-one/trace-manager] ${phase} timed out after ${flushTimeoutMs}ms; abandoning ${abandoned} in-flight export(s)`;
      if (logger) {
        try { logger.warn(msg, { phase, abandoned, flushTimeoutMs }); } catch { /* logger failure non-fatal */ }
      } else if (onExportError) {
        try { onExportError(new Error(msg)); } catch { /* sink failure non-fatal */ }
      }
      // Intentional: no console.warn fallback (library code must not write to stderr).
    }
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
        const deadId = asTraceId(`${DEAD_TRACE_PREFIX}${genTraceId()}`);
        deadTraceIds.add(deadId);
        return deadId;
      }

      const id = genTraceId();
      // SEC-007 + SEC-016: user metadata is scrubbed at ingestion so exporters
      // (console, OTel, Langfuse) never observe secrets.
      const userMeta = metadata
        ? (redactor ? sanitizeAttributes(metadata, redactor) : { ...metadata })
        : {};
      // F12: Make the sampling decision at trace-start so that changing the
      // sampling rate after startTrace() does not affect already-started traces.
      const rateSnapshot = samplingRate;
      const sampled = rateSnapshot >= 1 || randomInt(0, 1 << 30) / (1 << 30) < rateSnapshot;
      const mutable: MutableTrace = {
        id,
        name,
        startTime: Date.now(),
        userMetadata: userMeta,
        systemMetadata: {},
        spanIds: [],
        status: 'running',
        // LM-011 (Wave 4b): snapshot current sampling rate at trace-start.
        samplingRateSnapshot: rateSnapshot,
        sampled,
        lruPrev: null,
        lruNext: null,
        inLru: false,
      };
      traces.set(id, mutable);
      lru.append(mutable);
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
        // Wave-13 C-5: no longer a silent no-op. Either throw (strict) or
        // emit an observable counter + debug log (lenient default).
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
        // Wave-13 C-5: missing-trace now observable even in strict=false path.
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
      // LM-016: dead span — no-op
      if (deadSpanIds.has(spanId)) return;
      const span = spans.get(spanId);
      if (!span) {
        throw new HarnessError(
          `Span not found: ${spanId}`,
          HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
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
          HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
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
          HarnessErrorCode.TRACE_NOT_FOUND,
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
          HarnessErrorCode.TRACE_SPAN_NOT_FOUND,
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
          HarnessErrorCode.TRACE_NOT_FOUND,
          'Start a trace before ending it',
        );
      }
      trace.endTime = Date.now();
      trace.status = status ?? 'completed';

      // PERF-029: O(1) linked-list unlink; previously O(n) index rebuild.
      lru.remove(trace);

      // Export — respects isHealthy(), shouldExport(), lazy initialize(), and sampling.
      // F12: pass the sampling decision made at trace-start so concurrent
      // `setSamplingRate()` calls can't flip the decision.
      const readonlyTrace = toReadonlyTrace(trace);
      for (const exporter of exporters) {
        exportTraceTo(exporter, readonlyTrace, trace.sampled);
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
      //
      // PERF-028: `Promise.allSettled(pendingExports)` accepts any iterable,
      // so we pass the Set directly instead of materialising a fresh array on
      // every loop turn. Loop because a settled export's `finally` hook runs
      // asynchronously and new exports can race in while we awaited.
      //
      // P1-19: wrap the whole settle-loop in a Promise.race with an abortable
      // timeout so a stuck exporter cannot hang shutdown. `flushTimeoutMs === 0`
      // disables the cap (legacy wait-forever behaviour).
      //
      // Wave-13 C-6: ensure every lazy-init promise is tracked by
      // pendingExports BEFORE we settle, so flush waits for in-flight
      // exporter initialize() calls too.
      for (const e of exporters) {
        if (!e.initialize) continue;
        const initPromise = ensureInitialized(e);
        if (!pendingExports.has(initPromise)) {
          trackExport(initPromise);
        }
      }
      await waitForPendingWithTimeout('flush');
      // Wave-13 C-4: Replace Promise.all with Promise.allSettled + per-exporter
      // deadline so the slowest exporter cannot block flush(). Timed-out
      // exporters are logged but NOT re-thrown — flush must remain best-effort.
      const perExporterTimeout = flushTimeoutMs > 0 && exporters.length > 0
        ? Math.max(1, Math.floor(flushTimeoutMs / exporters.length))
        : 0;
      const flushResults = await Promise.allSettled(
        exporters.map(e => flushExporterBounded(e, perExporterTimeout)),
      );
      for (let i = 0; i < flushResults.length; i++) {
        const r = flushResults[i];
        if (r.status === 'rejected') {
          reportExportError(r.reason);
        }
      }
    },

    async initialize(): Promise<void> {
      // Wave-13 C-4: use allSettled so one slow exporter doesn't block the
      // others, AND track every init promise in pendingExports so flush()
      // awaits them if called concurrently.
      const initPromises: Promise<void>[] = [];
      for (const e of exporters) {
        const p = ensureInitialized(e);
        trackExport(p);
        initPromises.push(p);
      }
      const results = await Promise.allSettled(initPromises);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          const exporter = exporters[i];
          const name = exporter?.name ?? 'unknown';
          if (logger) {
            try { logger.warn('[harness-one/trace-manager] exporter initialize failed', { exporter: name, error: r.reason }); } catch { /* non-fatal */ }
          } else if (onExportError) {
            try { onExportError(r.reason); } catch { /* non-fatal */ }
          }
        }
      }
    },

    setSamplingRate(rate: number): void {
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        throw new HarnessError(
          'samplingRate must be a finite number in [0, 1]',
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Provide a rate between 0 and 1 inclusive',
        );
      }
      samplingRate = rate;
    },

    // P2-15: snapshot accessor (tests + introspection).
    getSamplingRate(): number {
      return samplingRate;
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
      // P1-19: bounded by flushTimeoutMs so a hanging exporter cannot block
      // dispose forever.
      await waitForPendingWithTimeout('dispose');
      // Flush every exporter — use allSettled so one failure doesn't block others.
      const flushResults = await Promise.allSettled(exporters.map(e => e.flush()));
      for (const result of flushResults) {
        if (result.status === 'rejected') {
          reportExportError(result.reason);
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
                reportExportError(err);
                return 'error' as const;
              }),
            timeoutPromise,
          ]);
          if (outcome === 'timeout') {
            reportExportError(
              new Error(`exporter "${e.name}" shutdown timed out after ${EXPORTER_SHUTDOWN_TIMEOUT_MS}ms`),
            );
          }
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
      // Clear internal maps so the process can exit cleanly.
      traces.clear();
      spans.clear();
      // PERF-029: reset the linked-list LRU state.
      lru.clear();
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

export { createConsoleExporter, createNoOpExporter } from './trace-builtins.js';
