/**
 * Token counting for messages, delegating to the internal token estimator.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { Tokenizer } from '../_internal/token-estimator.js';
import {
  estimateTokens,
  registerTokenizer as internalRegister,
} from '../_internal/token-estimator.js';

/**
 * Count tokens for an array of messages.
 *
 * Uses a registered tokenizer for the model if available, otherwise falls back
 * to the built-in heuristic.
 *
 * @example
 * ```ts
 * const tokens = countTokens('claude-3', [{ role: 'user', content: 'Hello' }]);
 * ```
 */
export function countTokens(model: string, messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(model, msg.content);
  }
  return total;
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
