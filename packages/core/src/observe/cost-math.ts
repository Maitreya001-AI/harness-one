/**
 * Pure math primitives for the cost-tracker.
 *
 * Isolated here so the tracker factory can focus on lifecycle, eviction, and
 * alerting instead of numerical bookkeeping. Everything in this module is
 * closure-free and side-effect-free (other than `safeWarn` for non-finite
 * tokens, which is explicitly passed in).
 *
 * @module
 */

import type { TokenUsageRecord } from './types.js';
import type { ModelPricing } from './cost-tracker.js';

/**
 * Kahan compensated summation — maintains a tight running sum that is
 * resistant to catastrophic cancellation when many similar-magnitude
 * floating-point values are accumulated. Used for per-model / per-trace /
 * global cost totals.
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
 * Pure-function cost calculation — given a usage record and the pricing
 * entry for its model, return the estimated cost in dollars rounded to
 * micro-dollar precision (6 decimal places).
 *
 * Returns `0` when `pricing` is undefined (unknown model) or when either
 * token count is non-finite. The caller owns the decision of how / whether
 * to surface the non-finite case to logs.
 */
export function priceUsage(
  usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>,
  pricing: ModelPricing | undefined,
): number {
  if (!pricing) return 0;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return 0;
  let cost = 0;
  cost += (usage.inputTokens / 1000) * pricing.inputPer1kTokens;
  cost += (usage.outputTokens / 1000) * pricing.outputPer1kTokens;
  if (usage.cacheReadTokens && pricing.cacheReadPer1kTokens) {
    cost += (usage.cacheReadTokens / 1000) * pricing.cacheReadPer1kTokens;
  }
  if (usage.cacheWriteTokens && pricing.cacheWritePer1kTokens) {
    cost += (usage.cacheWriteTokens / 1000) * pricing.cacheWritePer1kTokens;
  }
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Cheap guard used before {@link priceUsage} — true when the caller should
 * warn about non-finite token counts before treating the cost as 0.
 */
export function hasNonFiniteTokens(
  usage: Pick<TokenUsageRecord, 'inputTokens' | 'outputTokens'>,
): boolean {
  return !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens);
}
