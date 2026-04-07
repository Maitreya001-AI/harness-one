/**
 * Message compression with pluggable strategies.
 *
 * Built-in strategies: truncate, sliding-window, summarize, preserve-failures.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { CompressionStrategy } from './types.js';
import { estimateTokens } from '../_internal/token-estimator.js';
import { HarnessError } from '../core/errors.js';

/** Estimate token count for a single message using the default model heuristic. */
function msgTokens(msg: Message): number {
  return estimateTokens('default', msg.content);
}

/** Options for the compress function. */
export interface CompressOptions {
  readonly strategy: string | CompressionStrategy;
  readonly budget: number;
  readonly preserve?: (msg: Message) => boolean;
  readonly summarizer?: (messages: Message[]) => Promise<string>;
  readonly windowSize?: number;
}

/**
 * Compress messages to fit within a token budget.
 *
 * @example
 * ```ts
 * const result = await compress(messages, {
 *   strategy: 'truncate',
 *   budget: 10,
 * });
 * ```
 */
export async function compress(
  messages: readonly Message[],
  options: CompressOptions,
): Promise<Message[]> {
  const strategy =
    typeof options.strategy === 'string'
      ? getBuiltinStrategy(options.strategy, options)
      : options.strategy;

  const result = await strategy.compress(messages, options.budget, {
    preserve: options.preserve,
  });
  return [...result];
}

function getBuiltinStrategy(
  name: string,
  options: CompressOptions,
): CompressionStrategy {
  switch (name) {
    case 'truncate':
      return createTruncateStrategy();
    case 'sliding-window':
      return createSlidingWindowStrategy(options.windowSize ?? 10);
    case 'summarize':
      return createSummarizeStrategy(options.summarizer);
    case 'preserve-failures':
      return createPreserveFailuresStrategy();
    default:
      throw new HarnessError(
        `Unknown compression strategy: "${name}"`,
        'UNKNOWN_STRATEGY',
        'Use one of: truncate, sliding-window, summarize, preserve-failures',
      );
  }
}

function createTruncateStrategy(): CompressionStrategy {
  return {
    name: 'truncate',
    async compress(messages, targetTokens, options) {
      const preserve = options?.preserve;
      const result: Message[] = [];
      let tokenCount = 0;

      // Work backwards from the end, keeping messages until we hit targetTokens
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const tokens = msgTokens(msg);
        if (preserve && preserve(msg)) {
          result.unshift(msg);
          tokenCount += tokens;
          continue;
        }
        if (tokenCount + tokens <= targetTokens) {
          result.unshift(msg);
          tokenCount += tokens;
        }
      }
      return result;
    },
  };
}

function createSlidingWindowStrategy(windowSize: number): CompressionStrategy {
  return {
    name: 'sliding-window',
    async compress(messages, targetTokens, options) {
      const preserve = options?.preserve;
      const preserved: Message[] = [];
      const rest: Message[] = [];

      for (const msg of messages) {
        if (preserve && preserve(msg)) {
          preserved.push(msg);
        } else {
          rest.push(msg);
        }
      }

      // Keep the last windowSize non-preserved messages, then trim to fit token budget
      const windowed = rest.slice(-windowSize);
      // Trim windowed messages from the front to fit within token budget
      let tokenCount = preserved.reduce((sum, m) => sum + msgTokens(m), 0);
      const fittedWindowed: Message[] = [];
      for (let i = windowed.length - 1; i >= 0; i--) {
        const tokens = msgTokens(windowed[i]);
        if (tokenCount + tokens <= targetTokens) {
          fittedWindowed.unshift(windowed[i]);
          tokenCount += tokens;
        }
      }

      // Merge preserved messages back in original order
      const result: Message[] = [];
      let wIdx = 0;
      let pIdx = 0;
      for (const msg of messages) {
        if (preserve && preserve(msg) && pIdx < preserved.length && msg === preserved[pIdx]) {
          result.push(msg);
          pIdx++;
        } else if (wIdx < fittedWindowed.length && msg === fittedWindowed[wIdx]) {
          result.push(msg);
          wIdx++;
        }
      }
      return result;
    },
  };
}

function createSummarizeStrategy(
  summarizer?: (messages: Message[]) => Promise<string>,
): CompressionStrategy {
  return {
    name: 'summarize',
    async compress(messages, targetTokens, options) {
      if (!summarizer) {
        throw new HarnessError(
          'summarize strategy requires a summarizer callback',
          'MISSING_SUMMARIZER',
          'Pass a summarizer function in CompressOptions',
        );
      }
      const preserve = options?.preserve;

      // Check if total tokens already fit within budget
      const totalTokens = messages.reduce((sum, m) => sum + msgTokens(m), 0);
      if (totalTokens <= targetTokens) {
        return [...messages];
      }

      // Work backwards from the end, keeping messages that fit within budget
      const toKeep: Message[] = [];
      let keptTokens = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const tokens = msgTokens(messages[i]);
        if (keptTokens + tokens <= targetTokens) {
          toKeep.unshift(messages[i]);
          keptTokens += tokens;
        } else {
          break;
        }
      }

      // Everything not kept gets summarized (unless preserved)
      const toSummarize: Message[] = [];
      const keptSet = new Set(toKeep);
      for (const msg of messages) {
        if (keptSet.has(msg)) continue;
        if (preserve && preserve(msg)) {
          toKeep.unshift(msg);
        } else {
          toSummarize.push(msg);
        }
      }

      if (toSummarize.length === 0) {
        return [...messages];
      }

      const summary = await summarizer(toSummarize);
      return [
        { role: 'system' as const, content: `[Summary of earlier conversation]: ${summary}` },
        ...toKeep,
      ];
    },
  };
}

function createPreserveFailuresStrategy(): CompressionStrategy {
  return {
    name: 'preserve-failures',
    async compress(messages, targetTokens) {
      // Like truncate, but never drop messages with isFailureTrace
      const result: Message[] = [];
      const nonFailures: Message[] = [];
      const failures: Message[] = [];

      for (const msg of messages) {
        if (msg.meta?.isFailureTrace) {
          failures.push(msg);
        } else {
          nonFailures.push(msg);
        }
      }

      // Keep all failures, then fill remaining token budget from end of non-failures
      const failureTokens = failures.reduce((sum, m) => sum + msgTokens(m), 0);
      const remainingBudget = Math.max(0, targetTokens - failureTokens);
      const keptNonFailures: Message[] = [];
      let nonFailureTokens = 0;
      for (let i = nonFailures.length - 1; i >= 0; i--) {
        const tokens = msgTokens(nonFailures[i]);
        if (nonFailureTokens + tokens <= remainingBudget) {
          keptNonFailures.unshift(nonFailures[i]);
          nonFailureTokens += tokens;
        }
      }

      // Reconstruct in original order
      for (const msg of messages) {
        if (msg.meta?.isFailureTrace) {
          result.push(msg);
        } else if (keptNonFailures.includes(msg)) {
          result.push(msg);
        }
      }

      return result;
    },
  };
}
