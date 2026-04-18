/**
 * Environment-based configuration helper for @harness-one/preset.
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
 * @param env - Optional env map (defaults to `process.env`).
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

  const rawProvider = e['HARNESS_PROVIDER'];
  const provider = rawProvider === 'anthropic' || rawProvider === 'openai' ? rawProvider : undefined;
  const model = e['HARNESS_MODEL'];
  const maxIterations = (() => {
    const raw = e['HARNESS_MAX_ITERATIONS']?.trim();
    if (!raw) return undefined;
    const val = Number(raw);
    return Number.isInteger(val) && val > 0 ? val : undefined;
  })();
  const maxTotalTokens = (() => {
    const raw = e['HARNESS_MAX_TOKENS']?.trim();
    if (!raw) return undefined;
    const val = Number(raw);
    return Number.isInteger(val) && val > 0 ? val : undefined;
  })();
  const budget = (() => {
    const raw = e['HARNESS_BUDGET']?.trim();
    if (!raw) return undefined;
    const val = Number(raw);
    return Number.isFinite(val) && val > 0 ? val : undefined;
  })();

  return {
    ...(provider !== undefined && { provider }),
    ...(model !== undefined && { model }),
    ...(maxIterations !== undefined && { maxIterations }),
    ...(maxTotalTokens !== undefined && { maxTotalTokens }),
    ...(budget !== undefined && { budget }),
  } as Partial<HarnessConfig>;
}
