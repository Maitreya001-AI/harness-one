/**
 * Prompt injection detector guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

// Zero-width characters to strip before matching
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g;

// Cyrillic-to-Latin, Greek-to-Latin, IPA, and mathematical homoglyph map for common confusables
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic homoglyphs
  '\u0430': 'a', // Cyrillic а → Latin a
  '\u0435': 'e', // Cyrillic е → Latin e
  '\u043E': 'o', // Cyrillic о → Latin o
  '\u0441': 'c', // Cyrillic с → Latin c
  '\u0440': 'p', // Cyrillic р → Latin p
  '\u0443': 'y', // Cyrillic у → Latin y
  '\u0445': 'x', // Cyrillic х → Latin x
  '\u0456': 'i', // Cyrillic і → Latin i
  '\u0501': 'd', // Cyrillic ԁ → Latin d
  // Greek homoglyphs
  '\u03BF': 'o', // Greek ο (omicron) → Latin o
  '\u03B1': 'a', // Greek α (alpha) → Latin a
  '\u03B5': 'e', // Greek ε (epsilon) → Latin e
  '\u03BD': 'v', // Greek ν (nu) → Latin v
  '\u03BA': 'k', // Greek κ (kappa) → Latin k
  '\u03C4': 't', // Greek τ (tau) → Latin t
  '\u03B7': 'n', // Greek η (eta) → Latin n
  '\u03B9': 'i', // Greek ι (iota) → Latin i
  // IPA extensions
  '\u0251': 'a', // ɑ (Latin alpha) → Latin a
  '\u0261': 'g', // ɡ (script g) → Latin g
  '\u026A': 'i', // ɪ (small capital I) → Latin i
  '\u0274': 'n', // ɴ (small capital N) → Latin n
  '\u025B': 'e', // ɛ (open e) → Latin e
  '\u027E': 'r', // ɾ (fish-hook r) → Latin r
  '\u028C': 'v', // ʌ (turned v) → Latin v
  '\u1E77': 'u', // ṷ (u with circumflex below) → Latin u
  // Mathematical/Roman numeral confusables
  '\u217E': 'd', // ⅾ (small roman numeral five hundred) → Latin d
  '\u217C': 'l', // ⅼ (small roman numeral fifty) → Latin l
  '\u2170': 'i', // ⅰ (small roman numeral one) → Latin i
  '\u2174': 'v', // ⅴ (small roman numeral five) → Latin v
  '\u2179': 'x', // ⅹ (small roman numeral ten) → Latin x
  // Mathematical bold uppercase A-Z: U+1D400–U+1D419
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCodePoint(0x1D400 + i), String.fromCharCode(65 + i).toLowerCase()]),
  ),
  // Mathematical bold lowercase a-z: U+1D41A–U+1D433
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCodePoint(0x1D41A + i), String.fromCharCode(97 + i)]),
  ),
  // Mathematical italic uppercase A-Z: U+1D434–U+1D44D
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCodePoint(0x1D434 + i), String.fromCharCode(65 + i).toLowerCase()]),
  ),
  // Mathematical italic lowercase a-z: U+1D44E–U+1D467
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [String.fromCodePoint(0x1D44E + i), String.fromCharCode(97 + i)]),
  ),
};

// Markdown formatting characters to strip
const MARKDOWN_RE = /[*_~`#>|[\]]/g;

// Base patterns (exact phrases)
const BASE_PATTERNS: RegExp[] = [
  /ignore previous instructions/i,
  /ignore all instructions/i,
  /you are now/i,
  /pretend you are/i,
  /act as/i,
  /system prompt/i,
  /reveal your instructions/i,
  /disregard/i,
  /forget your rules/i,
];

// Medium sensitivity: partial match / more flexible (bounded to prevent ReDoS)
const MEDIUM_PATTERNS: RegExp[] = [
  /ignore\s+.{0,200}?instructions/i,
  /pretend\s+.{0,200}?you/i,
  /reveal\s+.{0,200}?(prompt|instructions|rules)/i,
  /forget\s+.{0,200}?(rules|instructions)/i,
];

// High sensitivity: context-requiring patterns + base64 (bounded to prevent ReDoS)
const HIGH_PATTERNS: RegExp[] = [
  /ignore\b.{0,200}\b(?:instruction|rule|previous|system|prompt|above)/i,
  /pretend\b.{0,200}\b(?:you|are|to be)/i,
  /reveal\b.{0,200}\b(?:prompt|instruction|rule|system|secret)/i,
  /disregard\b.{0,200}\b(?:instruction|rule|previous|above)/i,
  /override\b.{0,200}\b(?:instruction|rule|system|safety|setting)/i,
];

// Base64 detection: looks for base64 encoded strings of reasonable length
const BASE64_PATTERNS: RegExp[] = [
  /(?:[A-Za-z0-9+/]{4}){8,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/,
];

/**
 * Create a prompt injection detector guardrail.
 *
 * @example
 * ```ts
 * const detector = createInjectionDetector({ sensitivity: 'medium' });
 * ```
 */
export function createInjectionDetector(config?: {
  extraPatterns?: RegExp[];
  sensitivity?: 'low' | 'medium' | 'high';
}): { name: string; guard: Guardrail } {
  const sensitivity = config?.sensitivity ?? 'medium';
  const extraPatterns = config?.extraPatterns ?? [];

  let patterns: RegExp[];
  switch (sensitivity) {
    case 'low':
      patterns = [...BASE_PATTERNS, ...extraPatterns];
      break;
    case 'medium':
      patterns = [...BASE_PATTERNS, ...MEDIUM_PATTERNS, ...BASE64_PATTERNS, ...extraPatterns];
      break;
    case 'high':
      patterns = [...BASE_PATTERNS, ...MEDIUM_PATTERNS, ...HIGH_PATTERNS, ...BASE64_PATTERNS, ...extraPatterns];
      break;
  }

  /** Maximum input length for regex pattern checking (ReDoS protection). */
  const MAX_PATTERN_INPUT_LENGTH = 100_000;

  const guard: Guardrail = (ctx: GuardrailContext) => {
    // Normalize: strip zero-width characters
    let normalized = ctx.content.replace(ZERO_WIDTH_RE, '');
    // Normalize Unicode (NFKC collapses many confusables)
    normalized = normalized.normalize('NFKC');
    // Apply Cyrillic-to-Latin, Greek-to-Latin, IPA, and mathematical homoglyph mapping
    // Uses unicode flag (u) to correctly handle surrogate-pair code points (U+1D400 and above)
    normalized = normalized.replace(/[\u0430\u0435\u043E\u0441\u0440\u0443\u0445\u0456\u0501\u03BF\u03B1\u03B5\u03BD\u03BA\u03C4\u03B7\u03B9\u0251\u0261\u026A\u0274\u025B\u027E\u028C\u1E77\u217E\u217C\u2170\u2174\u2179\u{1D400}-\u{1D433}\u{1D434}-\u{1D467}]/gu, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
    // Normalize whitespace (newlines, tabs, multiple spaces → single space)
    normalized = normalized.replace(/\s+/g, ' ');
    // Strip markdown formatting characters
    normalized = normalized.replace(MARKDOWN_RE, '');

    // Process content in overlapping sliding windows to prevent bypassing detection
    // via injection placed beyond the window boundary. Each window overlaps the previous
    // by WINDOW_OVERLAP chars to catch patterns that span window boundaries.
    const WINDOW_OVERLAP = 200;

    if (normalized.length <= MAX_PATTERN_INPUT_LENGTH) {
      for (const pattern of patterns) {
        if (pattern.test(normalized)) {
          return { action: 'block', reason: 'Potential prompt injection detected: injection pattern detected' };
        }
      }
    } else {
      let offset = 0;
      while (offset < normalized.length) {
        const window = normalized.slice(offset, offset + MAX_PATTERN_INPUT_LENGTH);
        for (const pattern of patterns) {
          if (pattern.test(window)) {
            return { action: 'block', reason: 'Potential prompt injection detected: injection pattern detected' };
          }
        }
        // Advance by window size minus overlap so we don't miss cross-boundary patterns
        offset += MAX_PATTERN_INPUT_LENGTH - WINDOW_OVERLAP;
      }
    }

    return { action: 'allow' };
  };

  return { name: 'injection-detector', guard };
}
