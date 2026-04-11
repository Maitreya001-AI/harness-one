/**
 * Token cost tracking with budget alerts.
 *
 * @module
 */

import type { TokenUsageRecord, CostAlert } from './types.js';

/** Pricing configuration for a model. */
export interface ModelPricing {
  readonly model: string;
  readonly inputPer1kTokens: number;
  readonly outputPer1kTokens: number;
  readonly cacheReadPer1kTokens?: number;
  readonly cacheWritePer1kTokens?: number;
}

/** Tracker for token usage costs with budget alerting. */
export interface CostTracker {
  /** Set pricing for one or more models. */
  setPricing(pricing: ModelPricing[]): void;
  /** Record token usage and return the record with computed cost. */
  recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord;
  /**
   * Update the most recent usage record for a given traceId with partial new token counts.
   * Used for streaming scenarios where token counts arrive incrementally.
   * Recalculates cost difference and adjusts the running total accordingly.
   * Returns the updated record, or undefined if no record exists for the traceId.
   */
  updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined;
  /** Get total cost across all usage. */
  getTotalCost(): number;
  /** Get cost breakdown by model. */
  getCostByModel(): Record<string, number>;
  /** Get cost for a specific trace. */
  getCostByTrace(traceId: string): number;
  /** Set the budget limit. */
  setBudget(budget: number): void;
  /** Check if budget thresholds have been crossed. */
  checkBudget(): CostAlert | null;
  /** Register an alert handler. Returns a cleanup function to unsubscribe. */
  onAlert(handler: (alert: CostAlert) => void): () => void;
  /** Reset all usage records. */
  reset(): void;
  /** Get a prompt-injectable alert message based on budget usage, or null if under threshold. */
  getAlertMessage(): string | null;
}

/**
 * Standalone Kahan summation utility class for accurate floating-point accumulation.
 *
 * Uses Kahan compensated summation to minimize floating-point drift when
 * accumulating many small values. Supports both addition and subtraction.
 */
export class KahanSum {
  private _total = 0;
  private _compensation = 0;

  /** Add a value to the running sum. */
  add(x: number): void {
    const y = x - this._compensation;
    const t = this._total + y;
    this._compensation = (t - this._total) - y;
    this._total = t;
  }

  /** Subtract a value from the running sum. */
  subtract(x: number): void {
    this.add(-x);
  }

  /** Get the current accumulated total. */
  get total(): number {
    return this._total;
  }

  /** Reset the sum to zero. */
  reset(): void {
    this._total = 0;
    this._compensation = 0;
  }
}

/**
 * Create a new CostTracker instance.
 *
 * @example
 * ```ts
 * const tracker = createCostTracker({
 *   pricing: [{ model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 }],
 *   budget: 10.0,
 * });
 * tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
 * console.log(tracker.getTotalCost());
 * ```
 */
export function createCostTracker(config?: {
  pricing?: ModelPricing[];
  budget?: number;
  alertThresholds?: { warning: number; critical: number };
}): CostTracker {
  const pricing = new Map<string, ModelPricing>();
  const records: TokenUsageRecord[] = [];
  const alertHandlers: ((alert: CostAlert) => void)[] = [];
  let budget: number | undefined = config?.budget;
  const warningThreshold = config?.alertThresholds?.warning ?? 0.8;
  const criticalThreshold = config?.alertThresholds?.critical ?? 0.95;
  const maxRecords = 10_000;

  // Fix 5: Use KahanSum utility for running total
  const runningSum = new KahanSum();

  // Fix 4: Track cumulative per-model costs separately from the buffer.
  // modelTotals accumulates costs permanently (not affected by buffer eviction),
  // ensuring getCostByModel() stays consistent with getTotalCost().
  const modelTotals = new Map<string, KahanSum>();

  if (config?.pricing) {
    for (const p of config.pricing) {
      pricing.set(p.model, p);
    }
  }

  function computeCost(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): number {
    const p = pricing.get(usage.model);
    if (!p) return 0;

    let cost = 0;
    cost += (usage.inputTokens / 1000) * p.inputPer1kTokens;
    cost += (usage.outputTokens / 1000) * p.outputPer1kTokens;
    if (usage.cacheReadTokens && p.cacheReadPer1kTokens) {
      cost += (usage.cacheReadTokens / 1000) * p.cacheReadPer1kTokens;
    }
    if (usage.cacheWriteTokens && p.cacheWritePer1kTokens) {
      cost += (usage.cacheWriteTokens / 1000) * p.cacheWritePer1kTokens;
    }
    return Math.round(cost * 1_000_000) / 1_000_000;  // Round to 6 decimal places (micro-dollar precision)
  }

  function emitAlert(alert: CostAlert): void {
    for (const handler of alertHandlers) {
      handler(alert);
    }
  }

  // Issue 1: Standalone functions using closure references instead of `this`
  function checkBudgetFn(): CostAlert | null {
    if (budget === undefined || budget <= 0) return null;
    const currentCost = runningSum.total;
    const percentUsed = currentCost / budget;

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
  }

  function getAlertMessageFn(): string | null {
    if (budget === undefined) return null;
    const currentCost = runningSum.total;
    const percentUsed = currentCost / budget;

    if (percentUsed >= criticalThreshold) {
      return `[BUDGET CRITICAL] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Be extremely concise.`;
    }
    if (percentUsed >= warningThreshold) {
      return `[BUDGET WARNING] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Please be concise.`;
    }
    return null;
  }

  return {
    setPricing(newPricing: ModelPricing[]): void {
      for (const p of newPricing) {
        pricing.set(p.model, p);
      }
    },

    recordUsage(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): TokenUsageRecord {
      const estimatedCost = computeCost(usage);
      const record: TokenUsageRecord = {
        ...usage,
        estimatedCost,
        timestamp: Date.now(),
      };
      records.push(record);

      // Fix 5: Use KahanSum for running total
      runningSum.add(estimatedCost);

      // Fix 4: Accumulate per-model cost permanently
      let modelSum = modelTotals.get(usage.model);
      if (!modelSum) {
        modelSum = new KahanSum();
        modelTotals.set(usage.model, modelSum);
      }
      modelSum.add(estimatedCost);

      if (records.length > maxRecords) {
        const evicted = records.shift()!;
        runningSum.subtract(evicted.estimatedCost);
      }

      // Check budget alerts after recording
      if (budget !== undefined) {
        const alert = checkBudgetFn();
        if (alert) {
          emitAlert(alert);
        }
      }

      return record;
    },

    updateUsage(traceId: string, usage: Partial<Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp' | 'traceId' | 'model'>>): TokenUsageRecord | undefined {
      // Find the most recent record for the given traceId
      let existingRecord: TokenUsageRecord | undefined;
      let existingIndex = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].traceId === traceId) {
          existingRecord = records[i];
          existingIndex = i;
          break;
        }
      }

      if (!existingRecord || existingIndex === -1) return undefined;

      // Build the updated record with merged token counts
      const updatedFields: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'> = {
        traceId: existingRecord.traceId,
        model: existingRecord.model,
        inputTokens: usage.inputTokens ?? existingRecord.inputTokens,
        outputTokens: usage.outputTokens ?? existingRecord.outputTokens,
        ...(usage.cacheReadTokens !== undefined
          ? { cacheReadTokens: usage.cacheReadTokens }
          : existingRecord.cacheReadTokens !== undefined
            ? { cacheReadTokens: existingRecord.cacheReadTokens }
            : {}),
        ...(usage.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: usage.cacheWriteTokens }
          : existingRecord.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: existingRecord.cacheWriteTokens }
            : {}),
      };

      const newCost = computeCost(updatedFields);
      const oldCost = existingRecord.estimatedCost;
      const costDelta = newCost - oldCost;

      const updatedRecord: TokenUsageRecord = {
        ...updatedFields,
        estimatedCost: newCost,
        timestamp: existingRecord.timestamp,
      };

      // Mutate in place (same array slot — no eviction impact)
      records[existingIndex] = updatedRecord;

      // Adjust running totals
      runningSum.add(costDelta);

      const modelSum = modelTotals.get(existingRecord.model);
      if (modelSum) {
        modelSum.add(costDelta);
      }

      // Check budget alerts after update
      if (budget !== undefined) {
        const alert = checkBudgetFn();
        if (alert) {
          emitAlert(alert);
        }
      }

      return updatedRecord;
    },

    getTotalCost(): number {
      return runningSum.total;
    },

    // Fix 4: getCostByModel() returns from permanent modelTotals accumulator,
    // consistent with getTotalCost() even after buffer eviction.
    getCostByModel(): Record<string, number> {
      const result: Record<string, number> = {};
      for (const [model, sum] of modelTotals) {
        result[model] = sum.total;
      }
      return result;
    },

    getCostByTrace(traceId: string): number {
      return records
        .filter(r => r.traceId === traceId)
        .reduce((sum, r) => sum + r.estimatedCost, 0);
    },

    /**
     * Set the budget limit for cost alerting.
     *
     * Alerts are only re-evaluated on the next recordUsage() call, not
     * immediately on budget change. If the current cost already exceeds
     * the new budget, the alert will fire on the next recordUsage().
     */
    setBudget(newBudget: number): void {
      budget = newBudget;
    },

    checkBudget: checkBudgetFn,

    onAlert(handler: (alert: CostAlert) => void): () => void {
      alertHandlers.push(handler);
      return () => {
        const idx = alertHandlers.indexOf(handler);
        if (idx >= 0) alertHandlers.splice(idx, 1);
      };
    },

    reset(): void {
      records.length = 0;
      runningSum.reset();
      modelTotals.clear();
    },

    getAlertMessage: getAlertMessageFn,
  };
}
