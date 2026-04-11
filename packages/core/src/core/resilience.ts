/**
 * Resilient loop (Ralph Wiggum Loop) — outer retry wrapper for AgentLoop.
 *
 * When the inner agent loop enters a degenerate state (MaxIterationsError,
 * token budget exceeded, or error), this wrapper:
 * 1. Persists current progress via an optional callback
 * 2. Clears context
 * 3. Re-enters the loop with a summarized plan
 *
 * @module
 */

import { AgentLoop } from './agent-loop.js';
import type { AgentLoopConfig } from './agent-loop.js';
import type { AgentEvent, DoneReason } from './events.js';
import type { HarnessError } from './errors.js';
import type { Message } from './types.js';

/** Configuration for the resilient loop factory. */
export interface ResilientLoopConfig {
  /** The underlying agent loop config. */
  loopConfig: AgentLoopConfig;
  /** Maximum outer retries. Defaults to 2. */
  maxOuterRetries?: number;
  /**
   * Called when the inner loop fails. Returns a summary of progress
   * that will be injected as a system message in the retry.
   */
  onRetry?: (context: {
    attempt: number;
    reason: DoneReason;
    error?: HarnessError;
    conversationSoFar: readonly Message[];
  }) => Promise<{ summary: string; additionalMessages?: Message[] }>;
}

/** Handle returned by createResilientLoop. */
export interface ResilientLoop {
  run(messages: Message[]): AsyncGenerator<AgentEvent>;
  abort(): void;
}

/** Done reasons that should trigger a retry. */
const RETRYABLE_REASONS: ReadonlySet<DoneReason> = new Set([
  'max_iterations',
  'token_budget',
  'error',
]);

/**
 * Create a resilient loop that wraps AgentLoop with outer retry logic.
 *
 * @example
 * ```ts
 * const resilient = createResilientLoop({
 *   loopConfig: { adapter },
 *   maxOuterRetries: 2,
 *   onRetry: async ({ attempt, reason }) => ({
 *     summary: `Retry ${attempt} due to ${reason}`,
 *   }),
 * });
 * for await (const event of resilient.run(messages)) {
 *   console.log(event.type);
 * }
 * ```
 */
export function createResilientLoop(config: ResilientLoopConfig): ResilientLoop {
  const { loopConfig, onRetry } = config;
  const maxOuterRetries = config.maxOuterRetries ?? 2;
  let aborted = false;
  let currentLoop: AgentLoop | undefined;

  return {
    async *run(messages: Message[]): AsyncGenerator<AgentEvent> {
      let currentMessages = [...messages];
      let attempt = 0;

      while (attempt <= maxOuterRetries) {
        // Check if aborted before starting a new inner loop
        if (aborted) {
          yield { type: 'done', reason: 'aborted', totalUsage: { inputTokens: 0, outputTokens: 0 } };
          return;
        }

        // Create a fresh AgentLoop for each attempt.
        // We spread loopConfig but do NOT pass the signal through on retries
        // because each inner loop gets its own lifecycle. The outer abort()
        // method handles cancellation.
        currentLoop = new AgentLoop(loopConfig);

        // Run the inner loop, yielding all events except 'done' (held back
        // so we can decide whether to retry or pass it through).
        let doneEvent: AgentEvent | undefined;
        let doneReason: DoneReason | undefined;
        let doneError: HarnessError | undefined;

        for await (const event of currentLoop.run(currentMessages)) {
          if (event.type === 'done') {
            doneEvent = event;
            doneReason = event.reason;
          } else if (event.type === 'error') {
            doneError = event.error as HarnessError;
            yield event;
          } else {
            yield event;
          }
        }

        // Non-retryable reason or retries exhausted: pass through the done event
        if (!doneReason || !RETRYABLE_REASONS.has(doneReason) || attempt >= maxOuterRetries) {
          if (doneEvent) {
            yield doneEvent;
          }
          return;
        }

        // Trigger retry
        attempt++;

        // Call onRetry to get progress summary
        let retryResult: { summary: string; additionalMessages?: Message[] } | undefined;
        if (onRetry) {
          retryResult = await onRetry({
            attempt,
            reason: doneReason,
            ...(doneError !== undefined ? { error: doneError } : {}),
            conversationSoFar: currentMessages,
          });
        }

        // Check abort after onRetry (it may have been called during the callback)
        if (aborted) {
          yield { type: 'done', reason: 'aborted', totalUsage: { inputTokens: 0, outputTokens: 0 } };
          return;
        }

        // Emit warning event about the retry
        yield {
          type: 'warning',
          message: `Resilient loop retry ${attempt}/${maxOuterRetries}`,
        };

        // Build new messages for the retry
        if (retryResult) {
          const systemSummary: Message = {
            role: 'system',
            content: retryResult.summary,
          };
          currentMessages = [
            systemSummary,
            ...(retryResult.additionalMessages ?? []),
          ];
        } else {
          // No onRetry callback, retry with original messages
          currentMessages = [...messages];
        }
      }
    },

    abort(): void {
      aborted = true;
      if (currentLoop) {
        currentLoop.abort();
      }
    },
  };
}
