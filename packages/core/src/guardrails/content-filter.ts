/**
 * Content filter guardrail for blocked keywords and patterns.
 *
 * @module
 */

import type { Guardrail } from './types.js';

/** Escape special regex characters so a literal string can be used inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const patterns = config.blockedPatterns ?? [];

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
      if (pattern.test(ctx.content)) {
        return { action: 'block', reason: `Content matches blocked pattern: ${pattern.source}` };
      }
    }

    return { action: 'allow' };
  };

  return { name: 'content-filter', guard };
}
