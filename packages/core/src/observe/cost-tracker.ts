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
  /** Register an alert handler. */
  onAlert(handler: (alert: CostAlert) => void): void;
  /** Reset all usage records. */
  reset(): void;
  /** Get a prompt-injectable alert message based on budget usage, or null if under threshold. */
  getAlertMessage(): string | null;
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
  let runningTotal = 0;

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
    return cost;
  }

  function emitAlert(alert: CostAlert): void {
    for (const handler of alertHandlers) {
      handler(alert);
    }
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
      runningTotal += estimatedCost;
      if (records.length > maxRecords) {
        const evicted = records.shift()!;
        runningTotal -= evicted.estimatedCost;
      }

      // Check budget alerts after recording
      if (budget !== undefined) {
        const alert = this.checkBudget();
        if (alert) {
          emitAlert(alert);
        }
      }

      return record;
    },

    getTotalCost(): number {
      return runningTotal;
    },

    getCostByModel(): Record<string, number> {
      const result: Record<string, number> = {};
      for (const r of records) {
        result[r.model] = (result[r.model] ?? 0) + r.estimatedCost;
      }
      return result;
    },

    getCostByTrace(traceId: string): number {
      return records
        .filter(r => r.traceId === traceId)
        .reduce((sum, r) => sum + r.estimatedCost, 0);
    },

    setBudget(newBudget: number): void {
      budget = newBudget;
    },

    checkBudget(): CostAlert | null {
      if (budget === undefined) return null;
      const currentCost = this.getTotalCost();
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
    },

    onAlert(handler: (alert: CostAlert) => void): void {
      alertHandlers.push(handler);
    },

    reset(): void {
      records.length = 0;
      runningTotal = 0;
    },

    getAlertMessage(): string | null {
      if (budget === undefined) return null;
      const currentCost = this.getTotalCost();
      const percentUsed = currentCost / budget;

      if (percentUsed >= criticalThreshold) {
        return `[BUDGET CRITICAL] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Be extremely concise.`;
      }
      if (percentUsed >= warningThreshold) {
        return `[BUDGET WARNING] You have used ${(percentUsed * 100).toFixed(0)}% of your token budget. Please be concise.`;
      }
      return null;
    },
  };
}
