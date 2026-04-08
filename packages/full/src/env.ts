/**
 * Environment-based configuration helper for harness-one-full.
 *
 * Reads well-known HARNESS_* environment variables and returns a
 * partial HarnessConfig that can be spread into createHarness().
 *
 * @module
 */

import type { HarnessConfig } from './index.js';

/**
 * Build a partial HarnessConfig from environment variables.
 *
 * Reads the following variables:
 * - `HARNESS_PROVIDER` — `'anthropic'` or `'openai'`
 * - `HARNESS_MODEL` — model name string
 * - `HARNESS_MAX_ITERATIONS` — integer
 * - `HARNESS_MAX_TOKENS` — integer (maps to maxTotalTokens)
 * - `HARNESS_BUDGET` — float
 *
 * @param env Optional env map (defaults to `process.env`)
 *
 * @example
 * ```ts
 * const envConfig = createConfigFromEnv();
 * const harness = createHarness({ ...envConfig, provider: 'anthropic', client });
 * ```
 */
export function createConfigFromEnv(
  env?: Record<string, string | undefined>,
): Partial<HarnessConfig> {
  const e = env ?? process.env;

  const provider = e['HARNESS_PROVIDER'] as 'anthropic' | 'openai' | undefined;
  const model = e['HARNESS_MODEL'];
  const maxIterations = e['HARNESS_MAX_ITERATIONS']
    ? parseInt(e['HARNESS_MAX_ITERATIONS'], 10)
    : undefined;
  const maxTotalTokens = e['HARNESS_MAX_TOKENS']
    ? parseInt(e['HARNESS_MAX_TOKENS'], 10)
    : undefined;
  const budget = e['HARNESS_BUDGET'] ? parseFloat(e['HARNESS_BUDGET']) : undefined;

  return {
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(maxIterations !== undefined && !isNaN(maxIterations) && { maxIterations }),
    ...(maxTotalTokens !== undefined && !isNaN(maxTotalTokens) && { maxTotalTokens }),
    ...(budget !== undefined && !isNaN(budget) && { budget }),
  } as Partial<HarnessConfig>;
}
