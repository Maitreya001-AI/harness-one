/**
 * Default model pricing snapshot for opt-in convenience use with
 * {@link createCostTracker}.
 *
 * **WARNING — vendor pricing changes frequently.** This snapshot is a
 * best-effort baseline so a caller who only wants budget gating to
 * function ("trip an alert when spend > $X") can pass `defaultModelPricing`
 * without writing the table by hand. It is NOT a substitute for verifying
 * pricing against the vendor's billing API for production billing
 * pipelines.
 *
 * The snapshot date is recorded as {@link DEFAULT_PRICING_SNAPSHOT_DATE}.
 * If your code is later than that, audit the vendor pricing pages before
 * trusting any cost number from this constant.
 *
 * @example
 * ```ts
 * import { createCostTracker, defaultModelPricing } from 'harness-one/observe';
 *
 * const tracker = createCostTracker({
 *   pricing: defaultModelPricing,
 *   budget: 10.0,
 * });
 * ```
 *
 * **Sources** (verify before billing-critical use):
 *  - Anthropic: https://www.anthropic.com/pricing
 *  - OpenAI:    https://openai.com/api/pricing/
 *
 * @module
 */

import type { ModelPricing } from '../core/pricing.js';

/**
 * Date of the snapshot below in ISO format. Bump this whenever the
 * pricing entries are refreshed against vendor docs.
 */
export const DEFAULT_PRICING_SNAPSHOT_DATE = '2026-04-26' as const;

/**
 * Read-only snapshot of public per-model pricing for the major
 * Anthropic Claude and OpenAI GPT models. Numeric fields are
 * USD-per-1k-token values — see {@link ModelPricing}.
 *
 * Order is alphabetical within each vendor block to make diffs readable.
 *
 * Each Claude entry includes Anthropic prompt-caching prices:
 * `cacheWritePer1kTokens = 1.25 × input` and
 * `cacheReadPer1kTokens  = 0.10 × input`. OpenAI does not surface a
 * comparable per-token cache price publicly, so those fields are omitted.
 */
export const defaultModelPricing: readonly ModelPricing[] = Object.freeze([
  // ── Anthropic Claude 4 family ────────────────────────────────────────
  {
    model: 'claude-opus-4',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    cacheWritePer1kTokens: 0.01875,
    cacheReadPer1kTokens: 0.0015,
  },
  {
    model: 'claude-opus-4-7',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    cacheWritePer1kTokens: 0.01875,
    cacheReadPer1kTokens: 0.0015,
  },
  {
    model: 'claude-sonnet-4',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    cacheWritePer1kTokens: 0.00375,
    cacheReadPer1kTokens: 0.0003,
  },
  {
    model: 'claude-sonnet-4-6',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    cacheWritePer1kTokens: 0.00375,
    cacheReadPer1kTokens: 0.0003,
  },
  {
    model: 'claude-sonnet-4-20250514',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    cacheWritePer1kTokens: 0.00375,
    cacheReadPer1kTokens: 0.0003,
  },
  {
    model: 'claude-haiku-4',
    inputPer1kTokens: 0.0008,
    outputPer1kTokens: 0.004,
    cacheWritePer1kTokens: 0.001,
    cacheReadPer1kTokens: 0.00008,
  },
  {
    model: 'claude-haiku-4-5-20251001',
    inputPer1kTokens: 0.0008,
    outputPer1kTokens: 0.004,
    cacheWritePer1kTokens: 0.001,
    cacheReadPer1kTokens: 0.00008,
  },
  // ── Anthropic Claude 3.x legacy (still in production use) ───────────
  {
    model: 'claude-3-5-sonnet-20241022',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    cacheWritePer1kTokens: 0.00375,
    cacheReadPer1kTokens: 0.0003,
  },
  {
    model: 'claude-3-5-haiku-20241022',
    inputPer1kTokens: 0.0008,
    outputPer1kTokens: 0.004,
    cacheWritePer1kTokens: 0.001,
    cacheReadPer1kTokens: 0.00008,
  },
  {
    model: 'claude-3-opus-20240229',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    cacheWritePer1kTokens: 0.01875,
    cacheReadPer1kTokens: 0.0015,
  },
  {
    model: 'claude-3-haiku-20240307',
    inputPer1kTokens: 0.00025,
    outputPer1kTokens: 0.00125,
    cacheWritePer1kTokens: 0.0003125,
    cacheReadPer1kTokens: 0.000025,
  },

  // ── OpenAI GPT family ────────────────────────────────────────────────
  {
    model: 'gpt-4o',
    inputPer1kTokens: 0.0025,
    outputPer1kTokens: 0.01,
  },
  {
    model: 'gpt-4o-mini',
    inputPer1kTokens: 0.00015,
    outputPer1kTokens: 0.0006,
  },
  {
    model: 'gpt-4-turbo',
    inputPer1kTokens: 0.01,
    outputPer1kTokens: 0.03,
  },
  {
    model: 'gpt-4',
    inputPer1kTokens: 0.03,
    outputPer1kTokens: 0.06,
  },
  {
    model: 'gpt-3.5-turbo',
    inputPer1kTokens: 0.0005,
    outputPer1kTokens: 0.0015,
  },
] satisfies readonly ModelPricing[]);

/**
 * Look up a default pricing entry by model name. Returns `undefined` if the
 * model is not in the snapshot — callers should treat that as "I need to
 * supply pricing for this model myself" rather than as a billing-safe zero.
 */
export function getDefaultPricing(model: string): ModelPricing | undefined {
  return defaultModelPricing.find((p) => p.model === model);
}
