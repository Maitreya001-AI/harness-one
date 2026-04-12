/**
 * Content filter guardrail for blocked keywords and patterns.
 *
 * @module
 */

import type { Guardrail } from './types.js';
import { HarnessError } from '../core/errors.js';

/** Escape special regex characters so a literal string can be used inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect patterns that are likely ReDoS candidates.
 * Rejects patterns with nested quantifiers like `(a+)+`, `(\w+)*`, or adjacent quantifiers
 * that can cause catastrophic backtracking.
 */
function isReDoSCandidate(pattern: string): boolean {
  // Nested quantifiers: closing paren or bracket followed immediately by a quantifier,
  // e.g. (a+)+ or (\w+)* or (\w+)?
  if (/(\+|\*|\{)\s*\)(\+|\*|\{|\?)/.test(pattern)) return true;
  // Adjacent quantifiers without grouping: e.g. a++ or a*+ or a*?
  if (/(\+|\*)\s*(\+|\*|\?)/.test(pattern)) return true;
  return false;
}

/**
 * Create a content filter guardrail.
 *
 * Keywords are matched using word-boundary regex (`\b`) after NFKC normalization
 * of both keywords and content, which prevents false positives on substrings
 * (e.g., "contest" will NOT match keyword "test") and catches Unicode obfuscation
 * using combining characters.
 *
 * @example
 * ```ts
 * const filter = createContentFilter({ blocked: ['badword'], blockedPatterns: [/secret\d+/i] });
 * ```
 */
export function createContentFilter(config: {
  blocked?: string[];
  blockedPatterns?: RegExp[];
}): { name: string; guard: Guardrail } {
  // Normalize keywords with NFKC and build boundary-aware regexes.
  // Use \b for word characters at edges, or lookahead/lookbehind for non-word edges.
  const blockedKeywords = (config.blocked ?? []).map((w) => {
    const normalized = w.normalize('NFKC').toLowerCase();
    const escaped = escapeRegExp(normalized);
    // Determine appropriate boundary assertions based on first/last characters
    const startsWithWord = /^\w/.test(normalized);
    const endsWithWord = /\w$/.test(normalized);
    const prefix = startsWithWord ? '\\b' : '(?<!\\w)';
    const suffix = endsWithWord ? '\\b' : '(?!\\w)';
    return {
      original: normalized,
      regex: new RegExp(prefix + escaped + suffix, 'gi'),
    };
  });
  const rawPatterns = config.blockedPatterns ?? [];
  // Validate each user-provided pattern for ReDoS candidates before accepting it
  for (const pat of rawPatterns) {
    if (isReDoSCandidate(pat.source)) {
      throw new HarnessError(
        `Blocked pattern /${pat.source}/ is a potential ReDoS candidate (contains nested or adjacent quantifiers)`,
        'REDOS_PATTERN',
        'Simplify the pattern to avoid nested quantifiers like (a+)+ or (\\w+)*',
      );
    }
  }
  const patterns = rawPatterns;

  const guard: Guardrail = (ctx) => {
    // Normalize content with NFKC before checking against keywords
    const contentNormalized = ctx.content.normalize('NFKC').toLowerCase();

    for (const keyword of blockedKeywords) {
      // Reset regex lastIndex for stateful global regexes
      keyword.regex.lastIndex = 0;
      if (keyword.regex.test(contentNormalized)) {
        return { action: 'block', reason: `Content contains blocked keyword: "${keyword.original}"` };
      }
    }

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(contentNormalized)) {
        return { action: 'block', reason: `Content matches blocked pattern: ${pattern.source}` };
      }
    }

    return { action: 'allow' };
  };

  return { name: 'content-filter', guard };
}
