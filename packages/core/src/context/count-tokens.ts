/**
 * Token counting for messages, delegating to the internal token estimator.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { Tokenizer } from '../infra/token-estimator.js';
import {
  estimateTokens,
  registerTokenizer as internalRegister,
} from '../infra/token-estimator.js';

/**
 * WeakMap-based memoization cache for per-message token counts.
 * Keyed by message object identity, then by model string.
 * Using WeakMap ensures entries are garbage-collected when messages are no longer referenced.
 */
const tokenCache = new WeakMap<Message, Map<string, number>>();

/**
 * Count tokens for an array of messages.
 *
 * Uses a registered tokenizer for the model if available, otherwise falls back
 * to the built-in heuristic. Results are memoized per message object using a
 * WeakMap so repeated counts of the same message avoid redundant computation.
 *
 * @example
 * ```ts
 * const tokens = countTokens('claude-3', [{ role: 'user', content: 'Hello' }]);
 * ```
 */
export function countTokens(model: string, messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += countMessageTokens(model, msg);
  }
  return total;
}

/**
 * Count tokens for a single message with memoization.
 *
 * @internal
 */
export function countMessageTokens(model: string, msg: Message): number {
  let modelCache = tokenCache.get(msg);
  if (modelCache) {
    const cached = modelCache.get(model);
    if (cached !== undefined) {
      return cached;
    }
  } else {
    modelCache = new Map();
    tokenCache.set(msg, modelCache);
  }

  const tokens = estimateTokens(model, msg.content ?? '');
  modelCache.set(model, tokens);
  return tokens;
}

/**
 * Register a custom tokenizer for a model.
 *
 * @example
 * ```ts
 * registerTokenizer('gpt-4', { encode: (text) => tiktoken.encode(text) });
 * ```
 */
export function registerTokenizer(model: string, tokenizer: Tokenizer): void {
  internalRegister(model, tokenizer);
}
