/**
 * Prompt injection detector guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

// Zero-width characters to strip before matching
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g;

// Cyrillic-to-Latin homoglyph map for common confusables
const HOMOGLYPH_MAP: Record<string, string> = {
  '\u0430': 'a', // Cyrillic а → Latin a
  '\u0435': 'e', // Cyrillic е → Latin e
  '\u043E': 'o', // Cyrillic о → Latin o
  '\u0441': 'c', // Cyrillic с → Latin c
  '\u0440': 'p', // Cyrillic р → Latin p
  '\u0443': 'y', // Cyrillic у → Latin y
  '\u0445': 'x', // Cyrillic х → Latin x
  '\u0456': 'i', // Cyrillic і → Latin i
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

// Medium sensitivity: partial match / more flexible
const MEDIUM_PATTERNS: RegExp[] = [
  /ignore\s+.*?instructions/i,
  /pretend\s+.*?you/i,
  /reveal\s+.*?(prompt|instructions|rules)/i,
  /forget\s+.*?(rules|instructions)/i,
];

// High sensitivity: context-requiring patterns + base64
const HIGH_PATTERNS: RegExp[] = [
  /ignore\b.*?\b(?:instruction|rule|previous|system|prompt|above)/i,
  /pretend\b.*?\b(?:you|are|to be)/i,
  /reveal\b.*?\b(?:prompt|instruction|rule|system|secret)/i,
  /disregard\b.*?\b(?:instruction|rule|previous|above)/i,
  /override\b.*?\b(?:instruction|rule|system|safety|setting)/i,
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
      patterns = [...BASE_PATTERNS, ...MEDIUM_PATTERNS, ...extraPatterns];
      break;
    case 'high':
      patterns = [...BASE_PATTERNS, ...MEDIUM_PATTERNS, ...HIGH_PATTERNS, ...extraPatterns, ...BASE64_PATTERNS];
      break;
  }

  const guard: Guardrail = (ctx: GuardrailContext) => {
    // Normalize: strip zero-width characters
    let normalized = ctx.content.replace(ZERO_WIDTH_RE, '');
    // Normalize Unicode (NFKC collapses many confusables)
    normalized = normalized.normalize('NFKC');
    // Apply Cyrillic-to-Latin homoglyph mapping
    normalized = normalized.replace(/[\u0430\u0435\u043E\u0441\u0440\u0443\u0445\u0456]/g, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
    // Normalize whitespace (newlines, tabs, multiple spaces → single space)
    normalized = normalized.replace(/\s+/g, ' ');
    // Strip markdown formatting characters
    normalized = normalized.replace(MARKDOWN_RE, '');

    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return { action: 'block', reason: `Potential prompt injection detected: matched pattern ${pattern.source}` };
      }
    }

    return { action: 'allow' };
  };

  return { name: 'injection-detector', guard };
}
