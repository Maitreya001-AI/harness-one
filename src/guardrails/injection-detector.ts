/**
 * Prompt injection detector guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

// Zero-width characters to strip before matching
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g;

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

// High sensitivity: aggressive substring matching + base64
const HIGH_PATTERNS: RegExp[] = [
  /ignore/i,
  /pretend/i,
  /reveal/i,
  /disregard/i,
  /override/i,
];

// Base64 detection: looks for base64 encoded strings of reasonable length
const BASE64_RE = /(?:[A-Za-z0-9+/]{4}){8,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/;

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
      patterns = [...BASE_PATTERNS, ...MEDIUM_PATTERNS, ...HIGH_PATTERNS, ...extraPatterns, BASE64_RE];
      break;
  }

  const guard: Guardrail = (ctx: GuardrailContext) => {
    // Normalize: strip zero-width characters
    const normalized = ctx.content.replace(ZERO_WIDTH_RE, '');

    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        return { action: 'block', reason: `Potential prompt injection detected: matched pattern ${pattern.source}` };
      }
    }

    return { action: 'allow' };
  };

  return { name: 'injection-detector', guard };
}
