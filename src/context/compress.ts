/**
 * Message compression with pluggable strategies.
 *
 * Built-in strategies: truncate, sliding-window, summarize, preserve-failures.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { CompressionStrategy } from './types.js';

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
      throw new Error(`Unknown compression strategy: "${name}"`);
  }
}

function createTruncateStrategy(): CompressionStrategy {
  return {
    name: 'truncate',
    async compress(messages, targetTokens, options) {
      const preserve = options?.preserve;
      const result: Message[] = [];
      let count = 0;

      // Work backwards from the end, keeping messages until we hit targetTokens
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (preserve && preserve(msg)) {
          result.unshift(msg);
          count++;
          continue;
        }
        if (count < targetTokens) {
          result.unshift(msg);
          count++;
        }
      }
      return result;
    },
  };
}

function createSlidingWindowStrategy(windowSize: number): CompressionStrategy {
  return {
    name: 'sliding-window',
    async compress(messages, _targetTokens, options) {
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

      // Keep the last windowSize non-preserved messages
      const windowed = rest.slice(-windowSize);
      // Merge preserved messages back in original order
      const result: Message[] = [];
      let wIdx = 0;
      let pIdx = 0;
      // Interleave based on original position
      for (const msg of messages) {
        if (preserve && preserve(msg) && pIdx < preserved.length && msg === preserved[pIdx]) {
          result.push(msg);
          pIdx++;
        } else if (wIdx < windowed.length && msg === windowed[wIdx]) {
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
        throw new Error('summarize strategy requires a summarizer callback');
      }
      const preserve = options?.preserve;

      if (messages.length <= targetTokens) {
        return [...messages];
      }

      // Split: messages to keep (tail) vs messages to summarize (head)
      const toKeep = messages.slice(-targetTokens);
      const toSummarize: Message[] = [];

      for (const msg of messages.slice(0, messages.length - targetTokens)) {
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

      // Keep all failures, then fill remaining budget from end of non-failures
      const remainingBudget = Math.max(0, targetTokens - failures.length);
      const keptNonFailures = nonFailures.slice(-remainingBudget);

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
