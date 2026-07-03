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

/**
 * An instance-scoped tokenizer registry. Each registry owns its own
 * model→tokenizer map and falls back to the same {@link heuristicEstimate}
 * for unregistered models.
 *
 * Prefer this over the module-level {@link registerTokenizer} /
 * {@link estimateTokens} when embedding harness-one as a library: two
 * consumers in one process can each hold their own registry without
 * clobbering each other's tokenizers.
 */
export interface TokenizerRegistry {
  /**
   * Register a tokenizer for `model`. Returns `true` if a new tokenizer was
   * installed, `false` if `model` already had one (the call still overwrites,
   * but the boolean flags unintended double-registration).
   */
  register(model: string, tokenizer: Tokenizer): boolean;
  /** Estimate token count for `text` under `model` (registered or heuristic). */
  estimate(model: string, text: string): number;
}

/** Internal shape: a {@link TokenizerRegistry} plus a test-only `clear`. */
interface MutableTokenizerRegistry extends TokenizerRegistry {
  /** Drop all registered tokenizers (isolation reset for tests). */
  clear(): void;
}

/** Build a fresh registry closed over its own private Map. */
function makeRegistry(): MutableTokenizerRegistry {
  const registry = new Map<string, Tokenizer>();
  return {
    register(model: string, tokenizer: Tokenizer): boolean {
      const isNew = !registry.has(model);
      registry.set(model, tokenizer);
      return isNew;
    },
    estimate(model: string, text: string): number {
      const tokenizer = registry.get(model);
      if (tokenizer) {
        return tokenizer.encode(text).length;
      }
      return heuristicEstimate(text);
    },
    clear(): void {
      registry.clear();
    },
  };
}

/**
 * Create an isolated {@link TokenizerRegistry}.
 *
 * The returned registry has its own map and shares nothing with the
 * module-level default or any other registry. Recommended for library
 * authors — see {@link registerTokenizer} for why the global path is a
 * footgun in multi-tenant/embedded processes.
 *
 * @example
 * ```ts
 * const reg = createTokenizerRegistry();
 * reg.register('gpt-4', { encode: (t) => enc.encode(t) });
 * const n = reg.estimate('gpt-4', 'Hello world');
 * ```
 */
export function createTokenizerRegistry(): TokenizerRegistry {
  return makeRegistry();
}

/**
 * Process-wide default registry backing the module-level
 * {@link registerTokenizer} / {@link estimateTokens} / {@link clearTokenizerRegistry}
 * functions. Kept for backward compatibility with the global API and with
 * `@harness-one/tiktoken`, which registers into it at import time.
 */
const defaultRegistry = makeRegistry();

/**
 * Register a tokenizer for a specific model in the **process-wide default
 * registry**.
 *
 * Returns `true` if a new tokenizer was installed, `false` if this model
 * already had one and the call was a no-op. The boolean lets callers
 * detect unintended overwrites or double-registration in init code.
 *
 * ⚠️ **Mutates global state.** This writes to a single default registry
 * shared by the whole process, so two independent consumers (or two tests)
 * can clobber each other. **Library authors** embedding harness-one should
 * prefer {@link createTokenizerRegistry} and thread the instance through the
 * `tokenizerRegistry` injection points instead of mutating the global.
 *
 * @example
 * ```ts
 * const registered = registerTokenizer('gpt-4', { encode: (text) => myEncoder.encode(text) });
 * if (!registered) console.warn('tokenizer for gpt-4 was already registered');
 * ```
 */
export function registerTokenizer(model: string, tokenizer: Tokenizer): boolean {
  return defaultRegistry.register(model, tokenizer);
}

/**
 * Clear all registered tokenizers in the process-wide default registry.
 * **Test-only** — call in `afterEach` or `afterAll` to restore isolation
 * when tests register custom tokenizers into the global path.
 *
 * @internal Exposed for test suites; not part of the public API contract.
 */
export function clearTokenizerRegistry(): void {
  defaultRegistry.clear();
}

/**
 * Estimate token count for text using the process-wide default registry's
 * tokenizer for `model`, or the heuristic when none is registered.
 *
 * @example
 * ```ts
 * const tokens = estimateTokens('claude-3', 'Hello world');
 * ```
 */
export function estimateTokens(model: string, text: string): number {
  return defaultRegistry.estimate(model, text);
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

  const normalCount = Math.max(0, len - cjkCount - codeCount);

  return Math.ceil(cjkCount / 1.5 + codeCount / 3 + normalCount / 4 + 4);
}
