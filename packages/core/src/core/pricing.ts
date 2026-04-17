/**
 * Pricing primitives — the cohesive home for everything that describes
 * model cost: the `ModelPricing` type, the validation helpers (lifted
 * from `infra/validate.ts`), and the pure pricing math (`priceUsage`).
 *
 * Wave-15 consolidated these from three disparate homes
 * (`observe/cost-tracker-types.ts`, the retired `observe/cost-math.ts`, and
 * `infra/validate.ts`) so a single module owns the pricing contract.
 * Wave-16 m6 finished the job by deleting `cost-math.ts`; the tracker now
 * imports math straight from this module. The observe module still
 * re-exports the type + math for back-compat.
 *
 * @module
 */

import type { TokenUsageRecord } from '../observe/types.js';

/**
 * Pricing configuration for a model. Numeric fields are dollar-per-1k-token
 * values; cache read/write prices are optional and default to "not priced".
 */
export interface ModelPricing {
  readonly model: string;
  readonly inputPer1kTokens: number;
  readonly outputPer1kTokens: number;
  readonly cacheReadPer1kTokens?: number;
  readonly cacheWritePer1kTokens?: number;
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

// Validation re-exports — kept here so callers reach for one module when
// building / validating pricing.
export {
  validatePricingEntry,
  validatePricingArray,
} from '../infra/validate.js';
export type { PricingNumericFields } from '../infra/validate.js';
