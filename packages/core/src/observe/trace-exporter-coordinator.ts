/**
 * Export coordinator for the trace manager.
 *
 * Extracted from `trace-manager.ts` in round-3 cleanup. Owns everything the
 * trace-manager previously had to juggle inline about exporter lifecycle:
 *
 *   - lazy `initialize()` per exporter (shared in-flight promise on concurrent
 *     first export),
 *   - `isHealthy()` / `shouldExport()` / `shouldSampleTrace()` gates,
 *   - per-export promise tracking so `flush()` / `dispose()` can wait,
 *   - a bounded `flush()` with per-exporter deadlines,
 *   - a bounded `shutdown()` with per-exporter deadlines,
 *   - `reportExportError` fallthrough to logger / callback without writing
 *     stderr from the library.
 *
 * Pure dependency — the coordinator holds state (pending promises, init cache)
 * but never touches span/trace data. The trace-manager feeds it frozen
 * snapshots and sampling verdicts.
 *
 * @module
 */

import { createLazyAsync, type LazyAsync } from '../infra/lazy-async.js';
import type { Span, Trace, TraceExporter } from './types.js';

/** Shape injected from the trace-manager — just the logger it already has. */
export interface CoordinatorLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface TraceExporterCoordinatorConfig {
  readonly exporters: readonly TraceExporter[];
  readonly logger?: CoordinatorLogger;
  readonly onExportError?: (error: unknown) => void;
  /**
   * Maximum wall time (milliseconds) that flush-phases and shutdown spend
   * waiting for in-flight exports to settle before abandoning them. `0`
   * disables the cap (legacy wait-forever behaviour). Validation happens in
   * the trace-manager factory, so the coordinator trusts the value.
   */
  readonly flushTimeoutMs: number;
}

/** Public surface of the export coordinator. */
export interface TraceExporterCoordinator {
  /** Dispatch a span snapshot to every healthy exporter. */
  exportSpan(span: Span): void;
  /** Dispatch a trace snapshot to every healthy exporter, honouring sampling. */
  exportTrace(trace: Trace, sampled: boolean): void;
  /**
   * Eagerly initialize every exporter, tracking the init promises so a
   * concurrent `flushAll()` observes the in-flight init. Mirrors the inline
   * behaviour of the old `initialize()` method on the trace-manager.
   */
  initializeAll(): Promise<void>;
  /**
   * Await pending exports (with timeout), then call `flush()` on every
   * exporter with a per-exporter deadline. Mirrors the old inline behaviour:
   * exporter failures are reported to `onExportError` / logger but never
   * re-thrown (flush is best-effort).
   */
  flushAll(): Promise<void>;
  /**
   * Await pending exports (with timeout), call `flush()` on each exporter,
   * then `shutdown()` each exporter bounded by `EXPORTER_SHUTDOWN_TIMEOUT_MS`.
   */
  shutdownAll(): Promise<void>;
  /** Report an error through the configured sink; never rethrows. */
  reportExportError(err: unknown): void;
  /** Drop internal init-cache so the process can exit cleanly. */
  reset(): void;
}

/** Wall-clock cap on any single exporter's `shutdown()` call. */
const EXPORTER_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Invoke a possibly-sync-throwing lifecycle method and always get a rejected
 * promise back instead of a synchronous throw. `Promise.resolve(fn())` evaluates
 * `fn()` eagerly, so a sync throw bypasses the resulting promise entirely; this
 * helper moves the call inside the promise chain so sync throws become
 * rejections that `Promise.allSettled` / `.catch()` can see.
 */
function invokeAsync<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(fn);
}

export function createTraceExporterCoordinator(
  config: Readonly<TraceExporterCoordinatorConfig>,
): TraceExporterCoordinator {
  const { exporters, logger, onExportError, flushTimeoutMs } = config;

  /**
   * Track which exporters have had initialize() called. Each one runs through
   * `createLazyAsync` so concurrent first-exports share the same promise and
   * a rejection clears the cache so later exports can retry.
   */
  const initLazies = new Map<TraceExporter, LazyAsync<void>>();

  /** Pending in-flight export promises — drained on flush/shutdown. */
  const pendingExports = new Set<Promise<unknown>>();

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
        reportExportError(err, 'exporter initialize failed', exporter.name);
      });
  }

  function reportExportError(
    err: unknown,
    summary = 'trace export error',
    exporterName?: string,
  ): void {
    // Preserve the original asymmetric contract: when `onExportError` throws
    // we let the throw propagate upstream so `trackExport`'s outer catch
    // surfaces it via `logger.warn('export cleanup caught rejection')`. The
    // logger fallback is only used when NO onExportError is configured.
    if (onExportError) {
      onExportError(err);
      return;
    }
    if (logger) {
      try {
        logger.warn(`[harness-one] ${summary}`, {
          error: err,
          ...(exporterName !== undefined ? { exporter: exporterName } : {}),
        });
      } catch {
        /* logger failure non-fatal */
      }
    }
    // No console fallback — library code must not write to stderr.
  }

  function trackExport(p: Promise<unknown>): void {
    pendingExports.add(p);
    // `.finally()` alone can leak when the underlying promise rejects and a
    // handler in finally throws — swallow the rejection first so the delete
    // callback is guaranteed to run. Route swallowed rejections to the
    // injected logger so ops can see tracker-cleanup failures.
    p.catch((err: unknown) => {
      if (logger) {
        try {
          logger.warn('[harness-one] export cleanup caught rejection', {
            error: err,
          });
        } catch {
          /* logger itself threw — nothing more we can do */
        }
      }
    }).finally(() => pendingExports.delete(p));
  }

  function exportSpan(span: Span): void {
    for (const exporter of exporters) {
      if (exporter.isHealthy && !exporter.isHealthy()) continue;
      const p = ensureInitialized(exporter)
        .then(() => exporter.exportSpan(span))
        .catch((err) => reportExportError(err));
      trackExport(p);
    }
  }

  function exportTrace(trace: Trace, sampled: boolean): void {
    for (const exporter of exporters) {
      if (exporter.isHealthy && !exporter.isHealthy()) continue;
      if (exporter.shouldExport && !exporter.shouldExport(trace)) continue;
      // Per-exporter `shouldExport` hooks take precedence above.
      if (!exporter.shouldExport && !sampled) continue;
      // Tail-based sampling veto. Evaluated AFTER head-based decisions so
      // callers can "rescue" a head-dropped trace only by relaxing head
      // sampling — not by using a tail hook (that would defeat memory bounds).
      if (exporter.shouldSampleTrace) {
        let keep = true;
        try {
          keep = exporter.shouldSampleTrace(trace) !== false;
        } catch (err) {
          // A throwing tail hook is treated as an export failure: route to
          // the usual error sink and drop the export.
          reportExportError(err);
          continue;
        }
        if (!keep) continue;
      }
      const p = ensureInitialized(exporter)
        .then(() => exporter.exportTrace(trace))
        .catch((err) => reportExportError(err));
      trackExport(p);
    }
  }

  /**
   * Invoke `exporter.flush()` with a per-exporter deadline so a single slow
   * exporter can no longer block the aggregate flush beyond
   * `perExporterTimeoutMs`. A `0` timeout disables the cap.
   */
  function flushExporterBounded(
    exporter: TraceExporter,
    perExporterTimeoutMs: number,
  ): Promise<void> {
    if (perExporterTimeoutMs <= 0) {
      return invokeAsync(() => exporter.flush()).then(() => undefined);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), perExporterTimeoutMs);
    });
    return Promise.race([
      invokeAsync(() => exporter.flush()).then(() => 'ok' as const),
      timeoutPromise,
    ])
      .then((outcome) => {
        if (outcome === 'timeout') {
          const msg = `[harness-one/trace-manager] exporter "${exporter.name}" flush() timed out after ${perExporterTimeoutMs}ms`;
          if (logger) {
            try {
              logger.warn(msg, {
                exporter: exporter.name,
                perExporterTimeoutMs,
              });
            } catch {
              /* logger failure non-fatal */
            }
          }
        }
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
  }

  /**
   * Wait for every in-flight export to settle, bounded by `flushTimeoutMs`.
   * On timeout, abandon the remainder (the promises remain tracked but are no
   * longer awaited) and log a warn.
   */
  async function waitForPendingWithTimeout(
    phase: 'flush' | 'dispose',
  ): Promise<void> {
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
        try {
          logger.warn(msg, { phase, abandoned, flushTimeoutMs });
        } catch {
          /* logger failure non-fatal */
        }
      } else if (onExportError) {
        try {
          onExportError(new Error(msg));
        } catch {
          /* sink failure non-fatal */
        }
      }
      // Intentional: no console.warn fallback.
    }
  }

  async function initializeAll(): Promise<void> {
    // Use allSettled so one slow exporter doesn't block the others; every
    // init promise is tracked so a concurrent flushAll() observes them.
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
        reportExportError(
          r.reason,
          'exporter initialize failed',
          exporter?.name ?? 'unknown',
        );
      }
    }
  }

  async function flushAll(): Promise<void> {
    // Ensure every lazy-init promise is tracked BEFORE we settle, so flush
    // waits for in-flight exporter initialize() calls too.
    for (const e of exporters) {
      if (!e.initialize) continue;
      const initPromise = ensureInitialized(e);
      if (!pendingExports.has(initPromise)) {
        trackExport(initPromise);
      }
    }
    await waitForPendingWithTimeout('flush');

    // Promise.allSettled + per-exporter deadline so the slowest exporter
    // cannot block flush(). Timed-out exporters are logged but NOT re-thrown.
    const perExporterTimeout =
      flushTimeoutMs > 0 && exporters.length > 0
        ? Math.max(1, Math.floor(flushTimeoutMs / exporters.length))
        : 0;
    const flushResults = await Promise.allSettled(
      exporters.map((e) => flushExporterBounded(e, perExporterTimeout)),
    );
    for (const r of flushResults) {
      if (r.status === 'rejected') reportExportError(r.reason);
    }
  }

  async function shutdownAll(): Promise<void> {
    await waitForPendingWithTimeout('dispose');
    // Flush every exporter — allSettled so one failure doesn't block others.
    // `invokeAsync` ensures a sync throw from `flush()` becomes a rejection
    // instead of unwinding past `Promise.allSettled` during map evaluation.
    const flushResults = await Promise.allSettled(
      exporters.map((e) => invokeAsync(() => e.flush())),
    );
    for (const r of flushResults) {
      if (r.status === 'rejected') reportExportError(r.reason);
    }
    // Call `shutdown()` on each exporter with a bounded per-exporter timeout.
    for (const e of exporters) {
      const shutdownHook = e.shutdown;
      if (!shutdownHook) continue;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve('timeout'),
          EXPORTER_SHUTDOWN_TIMEOUT_MS,
        );
      });
      try {
        const outcome = await Promise.race([
          invokeAsync(() => shutdownHook.call(e))
            .then(() => 'ok' as const)
            .catch((err: unknown) => {
              reportExportError(err);
              return 'error' as const;
            }),
          timeoutPromise,
        ]);
        if (outcome === 'timeout') {
          reportExportError(
            new Error(
              `exporter "${e.name}" shutdown timed out after ${EXPORTER_SHUTDOWN_TIMEOUT_MS}ms`,
            ),
          );
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }
    reset();
  }

  function reset(): void {
    initLazies.clear();
  }

  return {
    exportSpan,
    exportTrace,
    initializeAll,
    flushAll,
    shutdownAll,
    reportExportError(err) {
      reportExportError(err);
    },
    reset,
  };
}
