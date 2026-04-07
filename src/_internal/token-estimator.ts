/**
 * Token estimation with model-specific tokenizer registry.
 *
 * Provides a heuristic-based token estimator that can be overridden
 * by registering real tokenizers for specific models.
 *
 * @module
 */

/** Interface for pluggable tokenizers. */
export interface Tokenizer {
  encode(text: string): { length: number };
}

const registry = new Map<string, Tokenizer>();

/**
 * Register a tokenizer for a specific model.
 *
 * @example
 * ```ts
 * registerTokenizer('gpt-4', { encode: (text) => myEncoder.encode(text) });
 * ```
 */
export function registerTokenizer(model: string, tokenizer: Tokenizer): void {
  registry.set(model, tokenizer);
}

/**
 * Estimate token count for text using a registered tokenizer or heuristic.
 *
 * @example
 * ```ts
 * const tokens = estimateTokens('claude-3', 'Hello world');
 * ```
 */
export function estimateTokens(model: string, text: string): number {
  const tokenizer = registry.get(model);
  if (tokenizer) {
    return tokenizer.encode(text).length;
  }
  return heuristicEstimate(text);
}

// CJK Unicode ranges
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/g;
// Code/punctuation characters
const CODE_RE = /[{}()\[\];:=<>!&|+\-*/%^~?@#$\\`"',.]/g;

/**
 * Heuristic token estimation.
 *
 * - General English text: ~4 chars per token
 * - CJK characters: ~1.5 chars per token
 * - Code/punctuation: ~3 chars per token
 * - Framing overhead: +4 tokens per message
 */
function heuristicEstimate(text: string): number {
  if (text.length === 0) return 4; // framing only

  // Count CJK characters
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Count code/punctuation characters
  const codeMatches = text.match(CODE_RE);
  const codeCount = codeMatches ? codeMatches.length : 0;

  // Remaining characters are "normal" text
  const normalCount = text.length - cjkCount - codeCount;

  const cjkTokens = cjkCount / 1.5;
  const codeTokens = codeCount / 3;
  const normalTokens = normalCount / 4;
  const framing = 4;

  return Math.ceil(cjkTokens + codeTokens + normalTokens + framing);
}
