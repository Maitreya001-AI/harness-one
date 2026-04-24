/**
 * Langfuse CostTracker — cost-tracking entry point for
 * `@harness-one/langfuse`.
 *
 * Structure: the wiring layer lives here; dedicated siblings own the
 * sub-concerns.
 *
 *   - `cost-pricing.ts`  pricing table + `computeCost` (pure math)
 *   - `cost-export.ts`   `handleExportError`, pending-flush tracking,
 *                        bounded `dispose()`
 *
 *   (Alert / budget logic still lives inline — it is tightly coupled with
 *   the `KahanSum`-backed `runningSum` and with the per-call
 *   `budgetSnapshot` race invariant.)
 *
 * @module
 */

import type { Langfuse } from 'langfuse';
import type { CostTracker, ModelPricing } from 'harness-one/observe';
import type { TokenUsageRecord, CostAlert } from 'harness-one/observe';
import type { EvictionStrategy, Logger } from 'harness-one/observe';
import { KahanSum, lruStrategy } from 'harness-one/observe';
import { requireFiniteNonNegative, requirePositiveInt } from 'harness-one/advanced';

import { createLangfusePricing } from './cost-pricing.js';
import { createExportHealth } from './cost-export.js';

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
   * Optional hook invoked when the Langfuse client fails to export
   * (e.g., flushAsync rejects). When omitted, errors are routed to
   * `logger.error` (if provided) or `console.warn` as a last resort.
   */
  readonly onExportError?: (
    err: unknown,
    context: { op: 'flush' | 'record'; details?: unknown },
  ) => void;
  /**
   * Optional structured logger. When `onExportError` is not set, export
   * errors are reported via `logger.error`. Falls back to `console.warn`
   * when neither is configured.
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
   * Wait for every in-flight `client.flushAsync()` invocation issued by
   * `recordUsage` to settle (fulfilled OR rejected). Resolves when
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
 *
 * @example
 * ```ts
 * import { Langfuse } from 'langfuse';
 * import { createLangfuseCostTracker } from '@harness-one/langfuse';
 *
 * const client = new Langfuse({ ... });
 * const costs = createLangfuseCostTracker({ client, maxRecords: 1000 });
 * costs.track({ model: 'claude-sonnet-4-20250514', usage: { inputTokens: 100, outputTokens: 50 } });
 * const total = costs.getTotalCost();
 * ```
 */
export function createLangfuseCostTracker(config: LangfuseCostTrackerConfig): LangfuseCostTracker {
  // ARCH-008: explicit strategy reference so the divergence with the core
  // tracker is grep-able and substitutable.
  const evictionStrategy: EvictionStrategy = lruStrategy;
  const { client } = config;
  const maxRecords = config.maxRecords ?? 10_000;
  // Delegate to the shared helper so langfuse and core agree on what
  // counts as a positive integer.
  requirePositiveInt(config.maxRecords, 'maxRecords');
  const pricingTable = createLangfusePricing(config.pricing);
  const exportHealth = createExportHealth({
    ...(config.onExportError !== undefined && { onExportError: config.onExportError }),
    ...(config.logger !== undefined && { logger: config.logger }),
  });
  const records: TokenUsageRecord[] = [];
  const alertHandlers: ((alert: CostAlert) => void)[] = [];
  let budget: number | undefined;

  // Compensated floating-point accumulation replaces the naive running total
  // plus the 1000-record recalibration workaround. KahanSum keeps drift
  // bounded without periodic O(N) reduce passes.
  const runningSum = new KahanSum();

  // Maintain per-model and per-trace totals incrementally. This turns
  // `getCostByModel` / `getCostByTrace` from O(N) array scans into O(1) /
  // O(k) lookups that scale with distinct keys, not total records.
  const modelTotals = new Map<string, KahanSum>();
  const traceTotals = new Map<string, KahanSum>();

  const warningThreshold = config.warningThreshold ?? 0.8;
  const criticalThreshold = config.criticalThreshold ?? 0.95;

  // Dedupe `budget_exceeded` event emission per (model + budget). Keys are
  // re-seeded on `applyBudget` so a new budget produces a fresh window of
  // events, and fully cleared on `reset()`.
  const emittedBudgetExceeded = new Set<string>();

  // `setPricing` / `setBudget` mutators are not on the returned tracker
  // surface. The budget helper below shares its body with the async
  // `updateBudget` method; pricing updates route through the pricing table.
  function applyBudget(newBudget: number): void {
    // Shared helper keeps langfuse/core/preset in lockstep on what
    // counts as a valid budget.
    requireFiniteNonNegative(newBudget, 'budget');
    budget = newBudget;
    // New budget => new dedupe window.
    emittedBudgetExceeded.clear();
  }

  // Pricing seeding happens inside `createLangfusePricing`. Budget seeding
  // still runs through `applyBudget` so factory-time invalid budgets throw
  // the same `CORE_INVALID_CONFIG` as post-construction `updateBudget()`.
  if (config.budget !== undefined) {
    applyBudget(config.budget);
  }

  // Event counter (flush counter lives inside `exportHealth`).
  let budgetExceededEvents = 0;

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
    // When the budget is actually exceeded, emit a Langfuse event (deduped
    // by model + budget) so downstream dashboards can alert. The
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
      exportHealth.handleExportError(err, 'record', { reason: 'budget_exceeded_event_failed' });
    }
  }

  const tracker: LangfuseCostTracker = {
    recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord {
      // F18c: Snapshot the budget reference at the start of the call so all
      // checks within this invocation use a consistent value, even if
      // updateBudget() is called concurrently from another async context.
      const budgetSnapshot = budget;

      const estimatedCost = pricingTable.computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);

      // KahanSum handles drift; no recalibration pass needed.
      runningSum.add(estimatedCost);
      // Maintain per-model / per-trace totals incrementally.
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

      // Export to Langfuse as a generation with cost metadata.
      // `client.trace()` and `.generation()` are synchronous builders that
      // can throw on malformed input or a torn-down client. A throw here
      // MUST NOT escape recordUsage() — the in-memory bookkeeping above
      // is already committed, so the caller would otherwise see a
      // half-applied record. Route failures through the same exportHealth
      // pipeline as async flush errors.
      try {
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
      } catch (err) {
        exportHealth.handleExportError(err, 'record', {
          reason: 'generation_failed',
          traceId: usage.traceId,
        });
      }

      // Flush errors surface through the configured hook / logger instead
      // of being swallowed with a bare console.warn. The error is also
      // counted so operators can observe degraded export health.
      //
      // `exportHealth.trackFlush` owns the pending-promise set + the
      // safe `handleExportError` routing.
      exportHealth.trackFlush(client.flushAsync());

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

    getCostByModel(): ReadonlyMap<string, number> {
      // Snapshot a copy so callers cannot mutate the internal KahanSum
      // map. O(k) over distinct models; insertion order preserved.
      const snapshot = new Map<string, number>();
      for (const [model, sum] of modelTotals) {
        snapshot.set(model, sum.total);
      }
      return snapshot;
    },

    getCostByTrace(traceId: string): number {
      // O(1) lookup — no per-record filter/reduce.
      return traceTotals.get(traceId)?.total ?? 0;
    },

    /**
     * Async-serialised pricing update. Mirrors the core `CostTracker`
     * contract so this Langfuse-backed tracker satisfies the same
     * interface. Delegates to the `applyPricing` helper — Langfuse
     * pricing state is still single-writer, but the Promise-returning
     * shape lets callers compose updates with other concurrency-safe
     * code paths uniformly.
     */
    async updatePricing(newPricing: ModelPricing[]): Promise<void> {
      pricingTable.apply(newPricing);
    },

    /**
     * Async-serialised budget update. Delegates to the `applyBudget`
     * helper (same validation + dedupe-clear semantics as the
     * factory-time `config.budget` seed).
     */
    async updateBudget(newBudget: number): Promise<void> {
      applyBudget(newBudget);
    },

    checkBudget(): CostAlert | null {
      if (budget === undefined) return null;
      const currentCost = tracker.getTotalCost();
      const percentUsed = currentCost / budget;

      // actual >= hard budget is a distinct, stronger state than `critical`.
      // Surface it so callers can trigger shouldStop semantics.
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
      const newCost = pricingTable.computeCost(merged);
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
      exportHealth.reset();
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
      // Keep isBudgetExceeded / shouldStop / checkBudget=exceeded on the
      // same criterion so callers see consistent signals.
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
        flushErrors: exportHealth.getFlushErrors(),
        budgetExceededEvents,
      };
    },

    async dispose(timeoutMs: number = 5_000): Promise<void> {
      // Pending-flush draining lives inside `exportHealth.dispose`.
      await exportHealth.dispose(timeoutMs);
    },
  };

  return tracker;
}
