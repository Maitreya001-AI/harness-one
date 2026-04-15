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
 * Returns `true` if a new tokenizer was installed, `false` if this model
 * already had one and the call was a no-op. The boolean lets callers
 * detect unintended overwrites or double-registration in init code.
 *
 * @example
 * ```ts
 * const registered = registerTokenizer('gpt-4', { encode: (text) => myEncoder.encode(text) });
 * if (!registered) console.warn('tokenizer for gpt-4 was already registered');
 * ```
 */
export function registerTokenizer(model: string, tokenizer: Tokenizer): boolean {
  const isNew = !registry.has(model);
  registry.set(model, tokenizer);
  return isNew;
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

/**
 * Heuristic token estimation — single-pass O(n) character classifier.
 *
 * Replaces an earlier implementation that called `text.match(CJK_RE)` and
 * `text.match(CODE_RE)` separately, which scanned the text twice. For large
 * messages (50 KB+), the extra scan dominated context-packing latency.
 *
 * Character classes (approximations, calibrated against tiktoken):
 * - CJK: U+2E80–U+9FFF, U+F900–U+FAFF, U+FE30–U+FE4F → ~1.5 chars/token
 * - Code/punctuation: `{}()[];:=<>!&|+-*\/%^~?@#$\`"',.` → ~3 chars/token
 * - Default: everything else → ~4 chars/token
 * - Framing overhead: +4 tokens per message
 *
 * We precompute a bitmap for code/punctuation (ASCII-only, so a tight
 * boolean array indexed by char code) and check CJK ranges with numeric
 * comparisons on the UTF-16 code unit — avoids per-char regex overhead.
 */
const CODE_PUNCT_BITMAP = new Uint8Array(128);
for (const c of "{}()[];:=<>!&|+-*/%^~?@#$\\`\"',.") {
  const cc = c.charCodeAt(0);
  if (cc < 128) CODE_PUNCT_BITMAP[cc] = 1;
}

function isCJK(cc: number): boolean {
  // U+2E80..U+9FFF
  if (cc >= 0x2e80 && cc <= 0x9fff) return true;
  // U+F900..U+FAFF
  if (cc >= 0xf900 && cc <= 0xfaff) return true;
  // U+FE30..U+FE4F
  if (cc >= 0xfe30 && cc <= 0xfe4f) return true;
  return false;
}

function heuristicEstimate(text: string): number {
  const len = text.length;
  if (len === 0) return 4; // framing only

  let cjkCount = 0;
  let codeCount = 0;

  for (let i = 0; i < len; i++) {
    const cc = text.charCodeAt(i);
    if (cc < 128) {
      if (CODE_PUNCT_BITMAP[cc]) codeCount++;
    } else if (isCJK(cc)) {
      cjkCount++;
    }
  }

  const normalCount = len - cjkCount - codeCount;

  return Math.ceil(cjkCount / 1.5 + codeCount / 3 + normalCount / 4 + 4);
}
