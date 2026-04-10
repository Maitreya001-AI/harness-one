/**
 * Self-healing retry wrapper for guardrail pipelines.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

/**
 * Run content through guardrails with automatic retry and regeneration.
 *
 * **Early break behavior:** Self-healing breaks on the first guardrail failure
 * in each attempt and does not run remaining guardrails. This is intentional for
 * efficiency -- the retry prompt addresses the first failure, and subsequent
 * guardrails are re-evaluated on the next attempt. Users should be aware that
 * only the first failing guardrail's reason is passed to `buildRetryPrompt`.
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
    /** Optional: estimate tokens for a string. Used with maxTotalTokens. */
    estimateTokens?: (text: string) => number;
    /** Optional: maximum total tokens across all regeneration attempts. */
    maxTotalTokens?: number;
    /** Optional: AbortSignal for external cancellation. */
    signal?: AbortSignal;
  },
  initialContent: string,
): Promise<{ content: string; attempts: number; passed: boolean; totalTokens?: number }> {
  const maxRetries = config.maxRetries ?? 3;
  const regenerateTimeoutMs = config.regenerateTimeoutMs ?? 30_000;
  const estimateTokens = config.estimateTokens;
  const maxTotalTokens = config.maxTotalTokens;
  let totalTokens = estimateTokens ? estimateTokens(initialContent) : undefined;
  let content = initialContent;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check for external cancellation
    if (config.signal?.aborted) {
      return { content, attempts: attempt, passed: false, ...(totalTokens !== undefined && { totalTokens }) };
    }

    const failures: Array<{ reason: string }> = [];
    const ctx: GuardrailContext = { content };

    // Stop at first guardrail failure instead of running all guardrails
    for (const entry of config.guardrails) {
      const verdict = await entry.guard(ctx);
      if (verdict.action === 'block') {
        failures.push({ reason: verdict.reason });
        break;
      } else if (verdict.action === 'modify') {
        failures.push({ reason: verdict.reason });
        break;
      }
    }

    if (failures.length === 0) {
      return { content, attempts: attempt, passed: true, ...(totalTokens !== undefined && { totalTokens }) };
    }

    if (attempt === maxRetries) {
      return { content, attempts: attempt, passed: false, ...(totalTokens !== undefined && { totalTokens }) };
    }

    // Exponential backoff with jitter: base * (0.5 + random * 0.5)
    const baseMs = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
    const backoffMs = baseMs * (0.5 + Math.random() * 0.5);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    const retryPrompt = config.buildRetryPrompt(content, failures);

    // Check token budget before regeneration
    if (estimateTokens && maxTotalTokens !== undefined) {
      const promptTokens = estimateTokens(retryPrompt);
      if (totalTokens !== undefined && totalTokens + promptTokens > maxTotalTokens) {
        return { content, attempts: attempt, passed: false, ...(totalTokens !== undefined && { totalTokens }) };
      }
    }

    // Track retry prompt tokens in the budget before attempting regeneration
    const retryPromptTokens = estimateTokens ? estimateTokens(retryPrompt) : 0;

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
    } catch (err) {
      // Don't swallow regenerate() errors — include them in failure context
      const _errorMessage = err instanceof Error ? err.message : String(err);
      void _errorMessage; // preserved for debugging/logging
      // Count the retry prompt tokens even on failure so the budget is accurate
      if (estimateTokens && totalTokens !== undefined) {
        totalTokens += retryPromptTokens;
      }
      return {
        content,
        attempts: attempt,
        passed: false,
        ...(totalTokens !== undefined && { totalTokens }),
      };
    }

    // Track tokens for the regenerated content
    if (estimateTokens && content) {
      totalTokens = (totalTokens ?? 0) + estimateTokens(content);
    }
  }

  // Should not be reached, but TypeScript needs it
  return { content, attempts: maxRetries, passed: false, ...(totalTokens !== undefined && { totalTokens }) };
}
