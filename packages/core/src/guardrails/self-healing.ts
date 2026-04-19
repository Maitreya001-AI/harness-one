/**
 * Self-healing retry wrapper for guardrail pipelines.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { computeBackoffMs } from '../infra/backoff.js';

/**
 * AbortSignal-aware sleep.
 *
 * Rejects with a `HarnessError(HarnessErrorCode.GUARD_SELF_HEALING_ABORTED)` if the signal fires
 * during the sleep. On both resolution paths we clear the timer AND detach the
 * listener — forgetting either side leaks a handle (the timer keeps the event
 * loop alive; the listener keeps the AgentLoop/other host alive via the
 * signal). `{ once: true }` gives us belt-and-braces for the abort case; we
 * still call `removeEventListener` on success to stay robust against polyfills
 * that don't honour `once`.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HarnessError('Self-healing aborted', HarnessErrorCode.GUARD_SELF_HEALING_ABORTED, 'Abort fired before sleep started'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const timeoutId = setTimeout(() => {
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* non-fatal */ }
      }
      resolve();
    }, ms);
    if (signal) {
      onAbort = (): void => {
        clearTimeout(timeoutId);
        // removeEventListener is idempotent + safe if `once: true` already fired.
        try { signal.removeEventListener('abort', onAbort as () => void); } catch { /* non-fatal */ }
        reject(new HarnessError('Self-healing aborted', HarnessErrorCode.GUARD_SELF_HEALING_ABORTED, 'Abort fired during backoff sleep'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

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
): Promise<{ content: string; attempts: number; passed: boolean; failureReason?: string; totalTokens?: number }> {
  const maxRetries = config.maxRetries ?? 3;
  if (maxRetries < 1) {
    throw new HarnessError('maxRetries must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a maxRetries value of 1 or higher');
  }
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

    // Exponential backoff with jitter via shared utility.
    const backoffMs = computeBackoffMs(attempt - 1);
    // honour external abort during backoff. Previously we
    // used a raw setTimeout so aborting during sleep kept the timer armed
    // until natural expiry (wasted handle + delayed shutdown). `sleepWithAbort`
    // clears the timer and detaches the listener on either resolution path.
    try {
      await sleepWithAbort(backoffMs, config.signal);
    } catch (err) {
      if (err instanceof HarnessError && err.code === HarnessErrorCode.GUARD_SELF_HEALING_ABORTED) {
        return { content, attempts: attempt, passed: false, ...(totalTokens !== undefined && { totalTokens }) };
      }
      throw err;
    }

    const retryPrompt = config.buildRetryPrompt(content, failures);

    // Estimate retry prompt tokens once and reuse for both budget check and tracking
    const retryPromptTokens = estimateTokens ? estimateTokens(retryPrompt) : 0;

    // Check token budget before regeneration
    if (estimateTokens && maxTotalTokens !== undefined) {
      if (totalTokens !== undefined && totalTokens + retryPromptTokens > maxTotalTokens) {
        return { content, attempts: attempt, passed: false, ...(totalTokens !== undefined && { totalTokens }) };
      }
    }

    // SEC-008: hold a reference to the timeout id so we can ALWAYS clear it
    // when the race settles (regardless of which side wins or throws). Without
    // this, a fast regenerate leaves the reject-on-timeout timer pending,
    // keeping the event loop alive and leaking one handle per retry.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`regenerate() timed out after ${regenerateTimeoutMs}ms`)),
            regenerateTimeoutMs,
          );
        });
        content = await Promise.race([
          config.regenerate(retryPrompt),
          timeoutPromise,
        ]);
      } finally {
        // Always clear the timer — regardless of success, rejection, or timeout.
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    } catch (err) {
      // Preserve regenerate() error info so callers can debug failures.
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Count the retry prompt tokens even on failure so the budget is accurate
      if (estimateTokens && totalTokens !== undefined) {
        totalTokens += retryPromptTokens;
      }
      return {
        content,
        attempts: attempt,
        passed: false,
        failureReason: errorMessage,
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
