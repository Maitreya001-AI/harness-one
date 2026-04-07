/**
 * Self-healing retry wrapper for guardrail pipelines.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

/**
 * Run content through guardrails with automatic retry and regeneration.
 *
 * @example
 * ```ts
 * const result = await withSelfHealing({
 *   maxRetries: 3,
 *   guardrails: [{ name: 'filter', guard: myGuard }],
 *   buildRetryPrompt: (content, failures) => `Fix: ${failures[0].reason}`,
 *   regenerate: async (prompt) => callLLM(prompt),
 * }, 'initial content');
 * ```
 */
export async function withSelfHealing(
  config: {
    maxRetries?: number;
    guardrails: Array<{ name: string; guard: Guardrail }>;
    buildRetryPrompt: (content: string, failures: Array<{ reason: string }>) => string;
    regenerate: (prompt: string) => Promise<string>;
  },
  initialContent: string,
): Promise<{ content: string; attempts: number; passed: boolean }> {
  const maxRetries = config.maxRetries ?? 3;
  let content = initialContent;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const failures: Array<{ reason: string }> = [];
    const ctx: GuardrailContext = { content };

    for (const entry of config.guardrails) {
      const verdict = await entry.guard(ctx);
      if (verdict.action === 'block') {
        failures.push({ reason: verdict.reason });
      } else if (verdict.action === 'modify') {
        failures.push({ reason: verdict.reason });
      }
    }

    if (failures.length === 0) {
      return { content, attempts: attempt, passed: true };
    }

    if (attempt === maxRetries) {
      return { content, attempts: attempt, passed: false };
    }

    const retryPrompt = config.buildRetryPrompt(content, failures);
    content = await config.regenerate(retryPrompt);
  }

  // Should not be reached, but TypeScript needs it
  return { content, attempts: maxRetries, passed: false };
}
