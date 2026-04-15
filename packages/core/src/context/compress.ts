/**
 * Message compression with pluggable strategies.
 *
 * Built-in strategies: truncate, sliding-window, summarize, preserve-failures.
 *
 * @module
 */

import type { Message, AgentAdapter } from '../core/types.js';
import type { CompressionStrategy } from './types.js';
import { estimateTokens } from '../infra/token-estimator.js';
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
  /**
   * CQ-014: Optional hook invoked when compression falls back to a degraded
   * strategy (e.g. the summarizer callback throws). Receives the underlying
   * error and a human-readable `fallbackReason` describing the fallback path.
   * Never causes compress() itself to throw — onError failures are swallowed
   * to preserve the non-throwing contract of compression fallbacks.
   */
  readonly onError?: (err: unknown, fallbackReason: string) => void;
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
  /**
   * CQ-013: True when the result was produced by a truncate-pass fallback
   * (e.g. summarize strategy had nothing to summarize but budget was still
   * exceeded, so messages were truncated to fit).
   */
  readonly truncated?: boolean;
  /**
   * CQ-014: Present when compression used a degraded fallback path. Examples:
   * - "summarizer failed, truncating instead"
   * - "summarize had no candidates, truncating to fit budget"
   */
  readonly fallbackReason?: string;
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
  if (options.budget <= 0) {
    throw new HarnessError('budget must be > 0', 'INVALID_CONFIG', 'Provide a positive token budget');
  }
  const originalTokens = messages.reduce((sum, m) => sum + msgTokens(m), 0);

  // CQ-013/014: Shared fallback-state object lets the built-in summarize
  // strategy signal truncation/error fallbacks without reshaping the
  // CompressionStrategy public contract.
  const fallbackState: { truncated: boolean; fallbackReason?: string } = {
    truncated: false,
  };

  const strategy =
    typeof options.strategy === 'string'
      ? getBuiltinStrategy(options.strategy, options, fallbackState)
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
    ...(fallbackState.truncated && { truncated: true }),
    ...(fallbackState.fallbackReason !== undefined && { fallbackReason: fallbackState.fallbackReason }),
  };
}

function getBuiltinStrategy(
  name: string,
  options: CompressOptions,
  fallbackState: { truncated: boolean; fallbackReason?: string },
): CompressionStrategy {
  switch (name) {
    case 'truncate':
      return createTruncateStrategy();
    case 'sliding-window':
      return createSlidingWindowStrategy(options.windowSize ?? 10);
    case 'summarize':
      return createSummarizeStrategy(options.summarizer, options.onError, fallbackState);
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

      // Safety net: if every message individually exceeds the budget,
      // always preserve the last message to avoid returning an empty array.
      if (result.length === 0 && messages.length > 0) {
        result.push(messages[messages.length - 1]);
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
      // Use 2 Sets: preserved indices and windowed indices (consolidates 4 data structures to 2)
      const preserved = new Set<number>();
      const restIndices: number[] = [];

      for (let i = 0; i < messages.length; i++) {
        if (preserve && preserve(messages[i])) {
          preserved.add(i);
        } else {
          restIndices.push(i);
        }
      }

      // Keep the last windowSize non-preserved messages, then trim to fit token budget
      const windowedIndices = restIndices.slice(-windowSize);
      // Trim windowed messages from the front to fit within token budget
      let tokenCount = 0;
      for (const idx of preserved) {
        tokenCount += msgTokens(messages[idx]);
      }
      const windowed = new Set<number>();
      for (let i = windowedIndices.length - 1; i >= 0; i--) {
        const idx = windowedIndices[i];
        const tokens = msgTokens(messages[idx]);
        if (tokenCount + tokens <= targetTokens) {
          windowed.add(idx);
          tokenCount += tokens;
        }
      }

      // Merge using index-based lookup in original order
      const result: Message[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (preserved.has(i) || windowed.has(i)) {
          result.push(messages[i]);
        }
      }
      return result;
    },
  };
}

function createSummarizeStrategy(
  summarizer?: (messages: Message[]) => Promise<string>,
  onError?: (err: unknown, fallbackReason: string) => void,
  fallbackState?: { truncated: boolean; fallbackReason?: string },
): CompressionStrategy {
  /**
   * CQ-013 helper: truncate-pass that keeps most recent messages fitting the
   * budget. Used when summarize has nothing to summarize but total tokens
   * still exceed the budget, or when the summarizer fails.
   */
  function truncateToBudget(messages: readonly Message[], targetTokens: number): Message[] {
    const result: Message[] = [];
    let tokenCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = msgTokens(messages[i]);
      if (tokenCount + tokens <= targetTokens) {
        result.unshift(messages[i]);
        tokenCount += tokens;
      }
    }
    // Safety net: if every message exceeds budget, keep the last message.
    if (result.length === 0 && messages.length > 0) {
      result.push(messages[messages.length - 1]);
    }
    return result;
  }

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
        // CQ-013: Nothing to summarize but total exceeds budget. Apply
        // truncate-pass over the result (keep most recent fitting budget)
        // rather than returning all messages and blowing past the budget.
        if (fallbackState) {
          fallbackState.truncated = true;
          fallbackState.fallbackReason =
            'summarize had no candidates to summarize (all preserved); truncated to fit budget';
        }
        return truncateToBudget(messages, targetTokens);
      }

      let summary: string;
      try {
        summary = await summarizer(toSummarize);
      } catch (err) {
        // CQ-014: Report the failure through onError (non-throwing) and
        // record a fallbackReason on the result. Fallback keeps only the
        // most recent half of messages, preserving the non-throwing contract.
        const reason = 'summarizer callback failed; fell back to recent-messages slice';
        if (fallbackState) {
          fallbackState.fallbackReason = reason;
        }
        if (onError) {
          try { onError(err, reason); } catch { /* swallow user-handler errors */ }
        }
        return [...messages.slice(-Math.max(1, Math.ceil(messages.length / 2)))];
      }
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
  /** CQ-014: Forwarded to compress() — invoked when compression falls back. */
  readonly onError?: (err: unknown, fallbackReason: string) => void;
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
    options.onError !== undefined ? { onError: options.onError } : {},
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

/**
 * Create a summarizer function that uses an AgentAdapter to generate summaries.
 *
 * The returned function can be passed as the `summarizer` option to the
 * `summarize` compression strategy.
 *
 * @example
 * ```ts
 * const summarizer = createAdapterSummarizer(adapter);
 * const result = await compress(messages, {
 *   strategy: 'summarize',
 *   budget: 1000,
 *   summarizer,
 * });
 * ```
 */
export function createAdapterSummarizer(adapter: AgentAdapter): (messages: Message[]) => Promise<string> {
  return async (messages: Message[]): Promise<string> => {
    const prompt: Message[] = [
      { role: 'system', content: 'Summarize the following conversation concisely, preserving key facts, decisions, and context needed to continue the conversation. Output only the summary.' },
      { role: 'user', content: messages.map(m => `[${m.role}]: ${m.content}`).join('\n') },
    ];
    const response = await adapter.chat({ messages: prompt });
    return response.message.content;
  };
}
