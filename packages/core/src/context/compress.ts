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

/** Result of a compress operation with explicit success/failure signaling. */
export interface CompressResult {
  readonly messages: Message[];
  /** Whether compression succeeded in fitting within the budget. */
  readonly compressed: boolean;
  /** Total token count of the original messages. */
  readonly originalTokens: number;
  /** Total token count of the returned messages. */
  readonly finalTokens: number;
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
): Promise<CompressResult> {
  const originalTokens = messages.reduce((sum, m) => sum + msgTokens(m), 0);

  const strategy =
    typeof options.strategy === 'string'
      ? getBuiltinStrategy(options.strategy, options)
      : options.strategy;

  const result = await strategy.compress(messages, options.budget, {
    ...(options.preserve !== undefined && { preserve: options.preserve }),
  });
  const resultMessages = [...result];
  const finalTokens = resultMessages.reduce((sum, m) => sum + msgTokens(m), 0);
  const compressed = finalTokens <= options.budget;

  return {
    messages: resultMessages,
    compressed,
    originalTokens,
    finalTokens,
  };
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
      // H5: Track by index instead of reference identity
      const preservedIndices: number[] = [];
      const restIndices: number[] = [];

      for (let i = 0; i < messages.length; i++) {
        if (preserve && preserve(messages[i])) {
          preservedIndices.push(i);
        } else {
          restIndices.push(i);
        }
      }

      // Keep the last windowSize non-preserved messages, then trim to fit token budget
      const windowedIndices = restIndices.slice(-windowSize);
      // Trim windowed messages from the front to fit within token budget
      let tokenCount = preservedIndices.reduce((sum, idx) => sum + msgTokens(messages[idx]), 0);
      const fittedWindowedIndices: Set<number> = new Set();
      for (let i = windowedIndices.length - 1; i >= 0; i--) {
        const idx = windowedIndices[i];
        const tokens = msgTokens(messages[idx]);
        if (tokenCount + tokens <= targetTokens) {
          fittedWindowedIndices.add(idx);
          tokenCount += tokens;
        }
      }

      // H5: Merge using index-based lookup (Set for O(1)) in original order
      const preservedSet = new Set(preservedIndices);
      const result: Message[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (preservedSet.has(i) || fittedWindowedIndices.has(i)) {
          result.push(messages[i]);
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

/** Options for conditional compaction. */
export interface CompactOptions {
  readonly budget: number;
  readonly threshold?: number;
  readonly strategy: string | CompressionStrategy;
  readonly windowSize?: number;
  readonly preserve?: (msg: Message) => boolean;
  readonly summarizer?: (messages: Message[]) => Promise<string>;
  /** Custom token counter. Default: built-in heuristic (~20-40% margin). */
  readonly countTokens?: (messages: readonly Message[]) => number;
}

/**
 * Compress messages if estimated token count exceeds budget threshold.
 * Returns messages unchanged if under threshold.
 *
 * Note: The default token estimator has ~20-40% margin.
 * For precise counting, pass a custom `countTokens` function
 * or register a tokenizer via `registerTokenizer()`.
 */
export async function compactIfNeeded(
  messages: readonly Message[],
  options: CompactOptions,
): Promise<Message[]> {
  const threshold = options.threshold ?? 0.75;
  const triggerAt = options.budget * threshold;

  const currentTokens = options.countTokens
    ? options.countTokens(messages)
    : messages.reduce((sum, msg) => sum + msgTokens(msg), 0);

  if (currentTokens <= triggerAt) {
    return [...messages];
  }

  const compressOpts = Object.assign(
    { strategy: options.strategy, budget: options.budget },
    options.preserve !== undefined ? { preserve: options.preserve } : {},
    options.summarizer !== undefined ? { summarizer: options.summarizer } : {},
    options.windowSize !== undefined ? { windowSize: options.windowSize } : {},
  ) as CompressOptions;
  const result = await compress(messages, compressOpts);
  return result.messages;
}

function createPreserveFailuresStrategy(): CompressionStrategy {
  return {
    name: 'preserve-failures',
    async compress(messages, targetTokens) {
      // Single-pass: classify messages and compute tokens simultaneously.
      // Keep all failure traces, then fill remaining budget from end of non-failures.
      const nonFailureIndices: number[] = [];
      const nonFailureTokens: number[] = []; // parallel to nonFailureIndices
      let failureTokens = 0;

      for (let i = 0; i < messages.length; i++) {
        if (messages[i].meta?.isFailureTrace) {
          failureTokens += msgTokens(messages[i]);
        } else {
          nonFailureIndices.push(i);
          nonFailureTokens.push(msgTokens(messages[i]));
        }
      }

      // Fill remaining budget from end of non-failures (reuse pre-computed tokens)
      const remainingBudget = Math.max(0, targetTokens - failureTokens);
      const keptNonFailureIndices: Set<number> = new Set();
      let usedBudget = 0;
      for (let i = nonFailureIndices.length - 1; i >= 0; i--) {
        const tokens = nonFailureTokens[i];
        if (usedBudget + tokens <= remainingBudget) {
          keptNonFailureIndices.add(nonFailureIndices[i]);
          usedBudget += tokens;
        }
      }

      // Reconstruct in original order (single pass over messages)
      const result: Message[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].meta?.isFailureTrace || keptNonFailureIndices.has(i)) {
          result.push(messages[i]);
        }
      }

      return result;
    },
  };
}
