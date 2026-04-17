/**
 * Pricing table + cost computation for the Langfuse cost tracker.
 *
 * Wave-16 M2 extraction — mirrors the split done in
 * `harness-one/core/pricing.ts` for the in-process tracker: the math is
 * pure, the pricing table is a small stateful map, and the "warn once per
 * unknown model" behaviour has a home away from the factory body.
 *
 * @module
 * @internal
 */

import type { ModelPricing } from 'harness-one/observe';
import type { TokenUsageRecord } from 'harness-one/observe';
import { safeWarn } from 'harness-one/observe';

/** Handle returned by {@link createLangfusePricing}. */
export interface LangfusePricingTable {
  /** Replace (upsert) entries from the caller-supplied list. */
  apply(newPricing: ModelPricing[]): void;
  /**
   * Compute the estimated cost for a usage record. Returns `0` for unknown
   * models (warning once per model) or when token counts are non-finite.
   */
  computeCost(usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>): number;
}

/**
 * Build a pricing table seeded from `initialPricing`. The table owns the
 * "warn once per unknown model" dedupe set so callers do not accidentally
 * spam the logger on every record.
 */
export function createLangfusePricing(
  initialPricing: readonly ModelPricing[] | undefined,
): LangfusePricingTable {
  const pricing = new Map<string, ModelPricing>();
  const warnedModels = new Set<string>();

  function apply(newPricing: ModelPricing[]): void {
    for (const p of newPricing) {
      pricing.set(p.model, p);
    }
  }

  if (initialPricing) apply([...initialPricing]);

  function computeCost(
    usage: Omit<TokenUsageRecord, 'estimatedCost' | 'timestamp'>,
  ): number {
    const p = pricing.get(usage.model);
    if (!p) {
      if (!warnedModels.has(usage.model)) {
        warnedModels.add(usage.model);
        safeWarn(
          undefined,
          `[harness-one/langfuse] No pricing configured for model "${usage.model}" — cost will be reported as $0`,
        );
      }
      return 0;
    }
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) {
      safeWarn(
        undefined,
        `[harness-one/langfuse] Invalid token counts for model "${usage.model}" — inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}. Cost will be 0.`,
      );
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

  return { apply, computeCost };
}
