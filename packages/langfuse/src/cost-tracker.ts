/**
 * Langfuse CostTracker — cost-tracking entry point for
 * `@harness-one/langfuse`.
 *
 * @module
 */

import type { Langfuse } from 'langfuse';
import type { CostTracker, ModelPricing, Logger } from 'harness-one/observe';
import type { TokenUsageRecord, CostAlert } from 'harness-one/observe';
import type { EvictionStrategy } from 'harness-one/observe';
import { KahanSum, lruStrategy, safeWarn } from 'harness-one/observe';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

// ---------------------------------------------------------------------------
// CostTracker (Langfuse-backed)
// ---------------------------------------------------------------------------

/** Configuration for the Langfuse cost tracker. */
export interface LangfuseCostTrackerConfig {
  /** A pre-configured Langfuse client instance. */
  readonly client: Langfuse;
  /** Warning threshold (0-1). Defaults to 0.8. */
  readonly warningThreshold?: number;
  /** Critical threshold (0-1). Defaults to 0.95. */
  readonly criticalThreshold?: number;
  /** Maximum number of usage records to retain. Defaults to 10000. */
  readonly maxRecords?: number;
  /**
   * Factory-time pricing seed. Prefer this over calling `updatePricing()`
   * after construction when the pricing is known up front — the returned
   * tracker exposes only async `updatePricing()` for post-construction
   * mutation (the historical synchronous `setPricing()` has been removed).
   */
  readonly pricing?: ModelPricing[];
  /**
   * Factory-time budget seed. Validated (finite, non-negative) at factory
   * entry with the same rules as `updateBudget()`. Prefer this over calling
   * `updateBudget()` after construction when the budget is known up front.
   */
  readonly budget?: number;
  /**
   * OBS-015: Optional hook invoked when the Langfuse client fails to export
   * (e.g., flushAsync rejects). When omitted, errors are routed to
   * `logger.error` (if provided) or `console.warn` as a last resort.
   */
  readonly onExportError?: (
    err: unknown,
    context: { op: 'flush' | 'record'; details?: unknown },
  ) => void;
  /**
   * OBS-015: Optional structured logger. When `onExportError` is not set,
   * export errors are reported via `logger.error`. Falls back to
   * `console.warn` when neither is configured.
   */
  readonly logger?: Logger;
}

/**
 * Runtime statistics for the Langfuse cost tracker. Exposed via
 * `getStats()` so operators can monitor export health.
 */
export interface LangfuseCostTrackerStats {
  /** Number of usage records currently retained (after eviction). */
  readonly records: number;
  /** Count of flush errors observed since tracker creation / last reset. */
  readonly flushErrors: number;
  /** Count of `budget_exceeded` Langfuse events emitted. */
  readonly budgetExceededEvents: number;
}

/**
 * Cost tracker shape returned by `createLangfuseCostTracker`. Extends the
 * core `CostTracker` contract with Langfuse-specific instrumentation.
 */
export interface LangfuseCostTracker extends CostTracker {
  /** Export-health counters. */
  getStats(): LangfuseCostTrackerStats;
  /**
   * Wave-12 P1-8: Wait for every in-flight `client.flushAsync()` invocation
   * issued by `recordUsage` to settle (fulfilled OR rejected). Resolves when
   * the pending-flush set drains or when `timeoutMs` elapses, whichever comes
   * first. Safe to call multiple times; never throws.
   *
   * Default timeout is 5_000ms.
   */
  dispose(timeoutMs?: number): Promise<void>;
}

/**
 * Create a CostTracker that records costs via Langfuse generations.
 *
 * Each usage record is exported as a Langfuse generation with cost metadata,
 * while also tracking totals locally for budget alerts.
 *
 * ARCH-008: This tracker uses the `lru` eviction strategy from
 * `harness-one/observe` — `getCostByModel()` and `getCostByTrace()` track
 * the *retained record window* (`maxRecords`). The core `createCostTracker`
 * defaults to `'overflow-bucket'` (cumulative since start, never evicts
 * per-key totals). The divergence is intentional: Langfuse pairs this local
 * tracker with a backend that retains the long-tail history, so the
 * in-process view is a sliding window matched to the bounded record buffer.
 */
export function createLangfuseCostTracker(config: LangfuseCostTrackerConfig): LangfuseCostTracker {
  // ARCH-008: explicit strategy reference so the divergence with the core
  // tracker is grep-able and substitutable.
  const evictionStrategy: EvictionStrategy = lruStrategy;
  const { client, onExportError, logger } = config;
  const maxRecords = config.maxRecords ?? 10_000;
  if (config.maxRecords !== undefined && config.maxRecords < 1) {
    throw new HarnessError('maxRecords must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxRecords value');
  }
  const pricing = new Map<string, ModelPricing>();
  const records: TokenUsageRecord[] = [];
  const alertHandlers: ((alert: CostAlert) => void)[] = [];
  let budget: number | undefined;

  // CQ-010(a): Compensated floating-point accumulation replaces the naive
  // running total plus the 1000-record recalibration workaround. KahanSum
  // keeps drift bounded without periodic O(N) reduce passes.
  const runningSum = new KahanSum();

  // CQ-010(b): Maintain per-model and per-trace totals incrementally. This
  // turns `getCostByModel` / `getCostByTrace` from O(N) array scans into
  // O(1) / O(k) lookups that scale with distinct keys, not total records.
  const modelTotals = new Map<string, KahanSum>();
  const traceTotals = new Map<string, KahanSum>();

  const warningThreshold = config.warningThreshold ?? 0.8;
  const criticalThreshold = config.criticalThreshold ?? 0.95;

  const warnedModels = new Set<string>();

  // OBS-003: Dedupe `budget_exceeded` event emission per (model + budget).
  // Keys are re-seeded on `applyBudget` so a new budget produces a fresh
  // window of events, and fully cleared on `reset()`.
  const emittedBudgetExceeded = new Set<string>();

  // P3-3: `setPricing` / `setBudget` mutators were removed from the returned
  // tracker surface. The helpers below hold the same bodies and are shared
  // between factory-time seeding (from `config.pricing` / `config.budget`)
  // and the async `updatePricing` / `updateBudget` methods.
  function applyPricing(newPricing: ModelPricing[]): void {
    for (const p of newPricing) {
      pricing.set(p.model, p);
    }
  }

  function applyBudget(newBudget: number): void {
    if (!Number.isFinite(newBudget) || newBudget < 0) {
      throw new HarnessError(
        `Budget must be a non-negative finite number, got ${newBudget}`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Provide a non-negative number for the budget',
      );
    }
    budget = newBudget;
    // OBS-003: New budget => new dedupe window.
    emittedBudgetExceeded.clear();
  }

  // Seed pricing / budget from config, if provided. Budget seeding runs
  // through `applyBudget` so factory-time invalid budgets throw the same
  // `CORE_INVALID_CONFIG` error as post-construction `updateBudget()`.
  if (config.pricing) {
    applyPricing(config.pricing);
  }
  if (config.budget !== undefined) {
    applyBudget(config.budget);
  }

  // OBS-015: Export-health counters.
  let flushErrors = 0;
  let budgetExceededEvents = 0;

  // Wave-12 P1-8: Track in-flight `flushAsync` promises so shutdown / flush
  // callers can await them instead of leaking fire-and-forget promises. Each
  // entry is registered before it is fired and removed in a `finally` once
  // settled, regardless of success or rejection.
  const pendingFlushes = new Set<Promise<unknown>>();

  function handleExportError(err: unknown, op: 'flush' | 'record', details?: unknown): void {
    if (op === 'flush') {
      flushErrors++;
    }
    if (onExportError) {
      try {
        onExportError(err, { op, details });
      } catch {
        // Never let a user callback break the record path.
      }
      return;
    }
    if (logger) {
      logger.error('[harness-one/langfuse] export error', {
        op,
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
        ...(details !== undefined ? { details } : {}),
      });
      return;
    }
    // Wave-5F T13: route final fallback through safeWarn (redaction-enabled).
    safeWarn(undefined, `[harness-one/langfuse] ${op} error`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  function computeCost(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): number {
    const p = pricing.get(usage.model);
    if (!p) {
      if (!warnedModels.has(usage.model)) {
        warnedModels.add(usage.model);
        safeWarn(undefined, `[harness-one/langfuse] No pricing configured for model "${usage.model}" — cost will be reported as $0`);
      }
      return 0;
    }
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
      safeWarn(undefined, `[harness-one/langfuse] Invalid token counts for model "${usage.model}" — inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}. Cost will be 0.`);
      return 0;
    }
    let cost = 0;
    cost += (usage.inputTokens / 1000) * p.inputPer1kTokens;
    cost += (usage.outputTokens / 1000) * p.outputPer1kTokens;
    if (usage.cacheReadTokens && p.cacheReadPer1kTokens) {
      cost += (usage.cacheReadTokens / 1000) * p.cacheReadPer1kTokens;
    }
    if (usage.cacheWriteTokens && p.cacheWritePer1kTokens) {
      cost += (usage.cacheWriteTokens / 1000) * p.cacheWritePer1kTokens;
    }
    return cost;
  }

  // ARCH-008: thin wrapper around the LRU strategy's bucket resolution.
  // Capacity is set to Number.MAX_SAFE_INTEGER because Langfuse never
  // capped the per-key map (and the LRU strategy ignores the capacity hint
  // for non-overflow paths anyway). Kept as a function so the per-call
  // shape stays identical to the historical `addToKeyedMap` helper.
  function addToKeyedMap(map: Map<string, KahanSum>, key: string, delta: number): void {
    const sum = evictionStrategy.resolveKeyBucket(map, key, Number.MAX_SAFE_INTEGER);
    if (sum) sum.add(delta);
  }

  function emitAlert(alert: CostAlert): void {
    for (const handler of alertHandlers) {
      handler(alert);
    }
    // OBS-003: When the budget is actually exceeded, emit a Langfuse event
    // (deduped by model + budget) so downstream dashboards can alert. The
    // warning/critical thresholds are intentionally excluded — only true
    // exceedance triggers the stop signal.
    if (alert.type === 'exceeded') {
      tryEmitBudgetExceededEvent(alert);
    }
  }

  function tryEmitBudgetExceededEvent(alert: CostAlert): void {
    // The `reset()` path clears this set, and `applyBudget()` clears it too,
    // so a fresh budget window re-emits once per affected model.
    const last = records[records.length - 1];
    const model = last?.model ?? 'unknown';
    const dedupeKey = `${model}::${alert.budget}`;
    if (emittedBudgetExceeded.has(dedupeKey)) return;
    emittedBudgetExceeded.add(dedupeKey);

    try {
      // Attach to the most recent trace id when available so the event is
      // visible in context. Otherwise create a synthetic tracking trace.
      const traceId = last?.traceId ?? 'budget-exceeded';
      const lfTrace = client.trace({ id: traceId, name: 'budget-exceeded' });
      lfTrace.event({
        name: 'budget_exceeded',
        level: 'ERROR',
        metadata: {
          model,
          budget: alert.budget,
          currentCost: alert.currentCost,
          percentUsed: alert.percentUsed,
          message: alert.message,
        },
      });
      budgetExceededEvents++;
    } catch (err) {
      // Emitting the signal must never crash the record path.
      handleExportError(err, 'record', { reason: 'budget_exceeded_event_failed' });
    }
  }

  const tracker: LangfuseCostTracker = {
    recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord {
      // F18c: Snapshot the budget reference at the start of the call so all
      // checks within this invocation use a consistent value, even if
      // updateBudget() is called concurrently from another async context.
      const budgetSnapshot = budget;

      const estimatedCost = computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);

      // CQ-010(a): KahanSum handles drift; no recalibration pass needed.
      runningSum.add(estimatedCost);
      // CQ-010(b): Maintain per-model / per-trace totals incrementally.
      addToKeyedMap(modelTotals, usage.model, estimatedCost);
      addToKeyedMap(traceTotals, usage.traceId, estimatedCost);

      if (records.length > maxRecords) {
        // records.length > maxRecords guarantees at least one element, so
        // shift() cannot return undefined — but we narrow defensively for TS.
        const evicted = records.shift();
        if (evicted) {
          runningSum.subtract(evicted.estimatedCost);
          // ARCH-008: delegate per-key total decrement to the strategy. For
          // `lruStrategy` this matches the historical "subtract from per-model
          // / per-trace KahanSum" behaviour.
          evictionStrategy.onRecordEvicted(evicted, modelTotals, traceTotals);
        }
      }

      // Export to Langfuse as a generation with cost metadata
      const trace = client.trace({ id: usage.traceId, name: 'cost-tracking' });
      trace.generation({
        name: `usage-${usage.model}`,
        model: usage.model,
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
        },
        metadata: {
          estimatedCost,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
      });

      // OBS-015: Flush errors surface through the configured hook / logger
      // instead of being swallowed with a bare console.warn. The error is
      // also counted so operators can observe degraded export health.
      //
      // Wave-12 P1-8: Track the in-flight promise so `flush()` / shutdown
      // paths on the exporter (and future dispose paths on the tracker) can
      // await rather than race to completion. The catch handler is itself
      // wrapped so a throwing logger can't surface as an unhandled rejection.
      const flushPromise = client.flushAsync().catch((err: unknown) => {
        try {
          handleExportError(err, 'flush');
        } catch {
          // Defensive: never let a user logger break the pending-flush machinery.
        }
      });
      pendingFlushes.add(flushPromise);
      flushPromise.finally(() => {
        pendingFlushes.delete(flushPromise);
      });

      // F18c: Use the snapshot taken at entry, not the live `budget` variable.
      if (budgetSnapshot !== undefined) {
        const alert = tracker.checkBudget();
        if (alert) {
          emitAlert(alert);
        }
      }

      return record;
    },

    getTotalCost(): number {
      return runningSum.total;
    },

    getCostByModel(): Record<string, number> {
      // CQ-010(b): O(k) over distinct models — no per-record scan.
      const result: Record<string, number> = {};
      for (const [model, sum] of modelTotals) {
        result[model] = sum.total;
      }
      return result;
    },

    getCostByModelMap(): ReadonlyMap<string, number> {
      // Snapshot a frozen copy so callers cannot mutate the internal
      // KahanSum map. Preserves insertion order.
      const snapshot = new Map<string, number>();
      for (const [model, sum] of modelTotals) {
        snapshot.set(model, sum.total);
      }
      return snapshot;
    },

    getCostByTrace(traceId: string): number {
      // CQ-010(b): O(1) lookup — no per-record filter/reduce.
      return traceTotals.get(traceId)?.total ?? 0;
    },

    /**
     * Wave-13 C-1 / P3-3: async-serialised pricing update. Mirrors the core
     * CostTracker contract so this Langfuse-backed tracker satisfies the same
     * interface. Delegates to the `applyPricing` helper — Langfuse pricing
     * state is still single-writer, but the Promise-returning shape lets
     * callers compose updates with other concurrency-safe code paths
     * uniformly.
     */
    async updatePricing(newPricing: ModelPricing[]): Promise<void> {
      applyPricing(newPricing);
    },

    /**
     * Wave-13 C-1 / P3-3: async-serialised budget update. Delegates to the
     * `applyBudget` helper (same validation + dedupe-clear semantics as the
     * factory-time `config.budget` seed).
     */
    async updateBudget(newBudget: number): Promise<void> {
      applyBudget(newBudget);
    },

    checkBudget(): CostAlert | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
      const percentUsed = currentCost / budget;

      // CQ-010(c): actual >= hard budget is a distinct, stronger state than
      // `critical`. Surface it so callers can trigger shouldStop semantics.
      if (percentUsed >= 1.0) {
        return {
          type: 'exceeded',
          currentCost,
          budget,
          percentUsed,
          message: `Exceeded: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
        };
      }
      if (percentUsed >= criticalThreshold) {
        return {
          type: 'critical',
          currentCost,
          budget,
          percentUsed,
          message: `Critical: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
        };
      }
      if (percentUsed >= warningThreshold) {
        return {
          type: 'warning',
          currentCost,
          budget,
          percentUsed,
          message: `Warning: ${(percentUsed * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(4)} / $${budget.toFixed(2)})`,
        };
      }
      return null;
    },

    onAlert(handler: (alert: CostAlert) => void): () => void {
      alertHandlers.push(handler);
      return () => {
        const idx = alertHandlers.indexOf(handler);
        if (idx >= 0) alertHandlers.splice(idx, 1);
      };
    },

    updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined {
      // Find the most recent record for this traceId
      let lastIdx = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].traceId === traceId) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx === -1) return undefined;

      const existing = records[lastIdx];
      const oldCost = existing.estimatedCost;

      // Merge updated token fields
      const merged = {
        ...existing,
        ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
        ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
      };
      const newCost = computeCost(merged);
      merged.estimatedCost = newCost;

      records[lastIdx] = merged;
      const delta = newCost - oldCost;
      runningSum.add(delta);
      addToKeyedMap(modelTotals, merged.model, delta);
      addToKeyedMap(traceTotals, merged.traceId, delta);

      if (budget !== undefined) {
        const alert = tracker.checkBudget();
        if (alert) emitAlert(alert);
      }

      return merged;
    },

    reset(): void {
      records.length = 0;
      runningSum.reset();
      modelTotals.clear();
      traceTotals.clear();
      emittedBudgetExceeded.clear();
      flushErrors = 0;
      budgetExceededEvents = 0;
    },

    getAlertMessage(): string | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
      const percentUsed = currentCost / budget;

      if (percentUsed >= 1.0) {
        return `[BUDGET EXCEEDED] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Stop all non-essential operations.`;
      }
      if (percentUsed >= criticalThreshold) {
        return `[BUDGET CRITICAL] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Be extremely concise.`;
      }
      if (percentUsed >= warningThreshold) {
        return `[BUDGET WARNING] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Please be concise.`;
      }
      return null;
    },

    isBudgetExceeded(): boolean {
      if (budget === undefined) return false;
      // CQ-010(c): Keep isBudgetExceeded / shouldStop / checkBudget=exceeded
      // on the same criterion so callers see consistent signals.
      return tracker.getTotalCost() >= budget;
    },

    budgetUtilization(): number {
      if (budget === undefined || budget === 0) return 0;
      return tracker.getTotalCost() / budget;
    },

    shouldStop(): boolean {
      return tracker.isBudgetExceeded();
    },

    getStats(): LangfuseCostTrackerStats {
      return {
        records: records.length,
        flushErrors,
        budgetExceededEvents,
      };
    },

    async dispose(timeoutMs: number = 5_000): Promise<void> {
      // Wave-12 P1-8: Drain pending flushes with a cap so shutdown cannot hang
      // on an unresponsive Langfuse backend. `allSettled` guarantees rejections
      // don't propagate; the timeout guarantees bounded wait time.
      if (pendingFlushes.size === 0) return;
      const snapshot = Array.from(pendingFlushes);
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timerHandle = setTimeout(resolve, Math.max(0, timeoutMs));
      });
      try {
        await Promise.race([
          Promise.allSettled(snapshot).then(() => undefined),
          timeout,
        ]);
      } finally {
        if (timerHandle !== undefined) clearTimeout(timerHandle);
      }
    },
  };

  return tracker;
}
