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
    /** Timeout for regenerate() in milliseconds (default: 30000). */
    regenerateTimeoutMs?: number;
  },
  initialContent: string,
): Promise<{ content: string; attempts: number; passed: boolean }> {
  const maxRetries = config.maxRetries ?? 3;
  const regenerateTimeoutMs = config.regenerateTimeoutMs ?? 30_000;
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

    // Exponential backoff: wait min(1000 * 2^(attempt-1), 10000) ms
    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    const retryPrompt = config.buildRetryPrompt(content, failures);
    try {
      content = await Promise.race([
        config.regenerate(retryPrompt),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`regenerate() timed out after ${regenerateTimeoutMs}ms`)),
            regenerateTimeoutMs,
          ),
        ),
      ]);
    } catch {
      // If regenerate times out or throws, return failure
      return { content, attempts: attempt, passed: false };
    }
  }

  // Should not be reached, but TypeScript needs it
  return { content, attempts: maxRetries, passed: false };
}
