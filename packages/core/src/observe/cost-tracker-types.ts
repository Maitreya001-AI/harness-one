/**
 * Public type surface for the cost tracker — `ModelPricing`, `CostTracker`,
 * and `OVERFLOW_BUCKET_KEY`. Split out of `cost-tracker.ts` so the
 * implementation file can focus on state machinery.
 *
 * @module
 */

import type { CostAlert } from './types.js';
import type { ModelPricing, TokenUsageRecord } from '../core/pricing.js';

/**
 * Pricing configuration for a model.
 *
 * The canonical definition lives in `core/pricing.ts`; this is a re-export
 * so existing `import { ModelPricing } from 'harness-one/observe'` keeps
 * working. Prefer the `harness-one/core`
 * import for new code — pricing is a cross-cutting primitive, not an
 * observe-only concern.
 */
export type { ModelPricing } from '../core/pricing.js';

/**
 * Synthetic key used to bucket cost entries that arrive after the per-model
 * or per-trace capacity has been reached. See {@link CostTracker} for the
 * rationale — we never evict existing entries (SEC-009) because evictions
 * can be abused by a caller to erase legitimate totals by flooding the
 * tracker with junk keys.
 */
export const OVERFLOW_BUCKET_KEY = '__overflow__';

/**
 * Tracker for token usage costs with budget alerting.
 *
 * Semantics of getters:
 *
 * - `getTotalCost()` reflects the **recent window** of kept records
 *   (bounded by `maxRecords`). When the record buffer evicts, the running
 *   sum subtracts the evicted cost, so this value tracks costs that are
 *   still addressable via `records`.
 * - `getCostByModel()` / `getCostByTrace()` are **cumulative since start**
 *   (or since the last `reset()`). They do NOT decrease when the record
 *   buffer evicts — this lets long-running jobs report end-to-end per-model
 *   spend regardless of buffer churn.
 *
 * Bounded-map semantics (SEC-009):
 *
 * - Once `modelTotals` (or `traceTotals`) reaches its cap, **existing**
 *   entries are never evicted. New, previously-unseen keys are aggregated
 *   into a synthetic `__overflow__` bucket (accessible as
 *   `OVERFLOW_BUCKET_KEY` on the returned record). This prevents a caller
 *   from flooding the tracker with junk keys to erase legitimate totals.
 */
export interface CostTracker {
  /**
   * Concurrency-safe pricing update. Serialises against `updateBudget()` and
   * every concurrent `updatePricing()` via an internal async lock. For
   * first-load pricing prefer passing `pricing` to `createCostTracker()` at
   * factory time.
   */
  updatePricing(pricing: ModelPricing[]): Promise<void>;
  /**
   * Record token usage and return the record with computed cost.
   *
   * `traceId` and `model` on the input are **optional** as of HC-005:
   * missing values fall through to the `'unknown'` bucket so simple
   * callers (single-task budget trackers) don't have to fabricate
   * stub IDs that pollute aggregations.
   */
  recordUsage(
    usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'> & {
      readonly traceId?: string;
      readonly model?: string;
    },
  ): TokenUsageRecord;
  /**
   * Update the most recent usage record for a given traceId with partial new
   * token counts. Used for streaming scenarios where token counts arrive
   * incrementally. Recalculates cost difference and adjusts the running
   * total accordingly. Returns the updated record, or undefined if no record
   * exists for the traceId.
   */
  updateUsage(
    traceId: string,
    usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>,
  ): TokenUsageRecord | undefined;
  /**
   * Recent-window total cost. Tracks the running sum of kept records in the
   * bounded `records` buffer. Not strictly cumulative — evicted records are
   * subtracted.
   */
  getTotalCost(): number;
  /**
   * Cumulative-since-start cost breakdown by model. New unknown models
   * landing after `maxModels` is reached are aggregated under
   * `OVERFLOW_BUCKET_KEY` rather than evicting existing totals.
   *
   * Returns a frozen `ReadonlyMap` so callers get O(1) membership tests
   * (`map.has(model)`), ordered iteration, and no boxing overhead from
   * `Object.entries()`. Snapshot — mutations on the returned map are
   * forbidden and mutations on the tracker are not reflected in the map.
   */
  getCostByModel(): ReadonlyMap<string, number>;
  /**
   * Cumulative-since-start cost for a specific trace. Unknown traces
   * arriving after `maxTraces` is reached bucket into `OVERFLOW_BUCKET_KEY`
   * rather than evicting.
   */
  getCostByTrace(traceId: string): number;
  /**
   * Concurrency-safe budget update. Serialises against `updatePricing()` and
   * concurrent `updateBudget()` via an internal async lock. For initial
   * budget prefer passing `budget` to `createCostTracker()` at factory time.
   */
  updateBudget(budget: number): Promise<void>;
  /** Check if budget thresholds have been crossed. */
  checkBudget(): CostAlert | null;
  /** Register an alert handler. Returns a cleanup function to unsubscribe. */
  onAlert(handler: (alert: CostAlert) => void): () => void;
  /** Reset all usage records. */
  reset(): void;
  /**
   * Get a prompt-injectable alert message based on budget usage, or null if
   * under threshold.
   */
  getAlertMessage(): string | null;
  /**
   * Returns true when `total cost` is greater than or equal to the
   * configured budget. Returns false if no budget is set.
   */
  isBudgetExceeded(): boolean;
  /** Returns fraction of budget used (0-1+). Returns 0 if no budget is set. */
  budgetUtilization(): number;
  /**
   * Returns true when the budget has been exceeded and processing should
   * stop.
   */
  shouldStop(): boolean;
}
