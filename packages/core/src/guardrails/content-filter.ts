/**
 * Content filter guardrail for blocked keywords and patterns.
 *
 * @module
 */

import type { Guardrail } from './types.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';

/** Escape special regex characters so a literal string can be used inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect patterns that are likely ReDoS candidates.
 *
 * Rejects patterns with:
 *  - Nested quantifiers (`(a+)+`, `(\w+)*`, `(\w+)?`) — exponential backtracking.
 *  - Adjacent quantifiers (`a++`, `a*?`) — mostly invalid or polynomial risk.
 *  - Alternation with a repeat where the alternatives share a prefix
 *    (`(a|a?)+`, `(a|ab)*`, `(a|b|ab)*`) — polynomial-time matcher inputs.
 *  - Alternation containing overlapping literals with a quantified group.
 *
 * NOTE: this is a heuristic, not a theorem prover. Safe patterns may be
 * rejected in rare cases; users should simplify them. The cost of a false
 * positive is low (throw at construction); the cost of a false negative is
 * a denial-of-service.
 */
export function isReDoSCandidate(pattern: string): boolean {
  // 1. Nested quantifiers: closing paren or bracket followed immediately by a
  //    quantifier, e.g. (a+)+ or (\w+)* or (\w+)?
  if (/(\+|\*|\{)\s*\)(\+|\*|\{|\?)/.test(pattern)) return true;
  // 2. Adjacent quantifiers without grouping: e.g. a++ or a*+ or a*?
  if (/(\+|\*)\s*(\+|\*|\?)/.test(pattern)) return true;
  // 3. Simple group with an optional atom then a repeat, e.g. (a|a?)+.
  if (hasOptionalAtomInRepeat(pattern)) return true;
  // 4. Alternation whose branches share a literal prefix, wrapped in a repeat.
  //    Examples: (a|ab)*, (foo|foobar)+, (a|b|ab)*.
  const altBody = extractRepeatedAlternationBody(pattern);
  if (altBody !== null && hasOverlappingAlternatives(altBody)) return true;
  return false;
}

/**
 * Linear scan: returns true if `pattern` contains a simple (non-nested) group
 * `(…?…)` immediately followed by `+` or `*`. Replaces the previous regex
 * `/\([^)]*\?\s*\)[+*]/` which had polynomial backtracking on inputs like
 * `((((…((`.
 */
function hasOptionalAtomInRepeat(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '(') continue;
    let sawQuestion = false;
    for (let j = i + 1; j < pattern.length; j++) {
      const c = pattern[j];
      if (c === '(') break; // nested group — skip this heuristic
      if (c === ')') {
        if (!sawQuestion) break;
        // Allow optional whitespace before the trailing quantifier.
        let k = j + 1;
        while (k < pattern.length && (pattern[k] === ' ' || pattern[k] === '\t')) k++;
        const next = pattern[k];
        if (next === '+' || next === '*') return true;
        break;
      }
      if (c === '?') sawQuestion = true;
    }
  }
  return false;
}

/**
 * Linear scan: returns the body of the first simple (non-nested) alternation
 * group `(A|B|…)` followed by `+` or `*`, or `null` if none exists. Replaces
 * the previous regex `/\(([^()]*\|[^()]*)\)[+*]/` which had polynomial
 * backtracking on inputs with many `|` characters.
 */
function extractRepeatedAlternationBody(pattern: string): string | null {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '(') continue;
    let body = '';
    let hasAlt = false;
    let closeIndex = -1;
    for (let j = i + 1; j < pattern.length; j++) {
      const c = pattern[j];
      if (c === '(') break; // nested — skip
      if (c === ')') { closeIndex = j; break; }
      if (c === '|') hasAlt = true;
      body += c;
    }
    if (closeIndex === -1 || !hasAlt) continue;
    const next = pattern[closeIndex + 1];
    if (next === '+' || next === '*') return body;
  }
  return null;
}

/**
 * Given the body of an alternation group (without the outer parens),
 * return true if any two branches share a literal prefix character.
 * This is a polynomial-time ReDoS amplifier when combined with a repeat.
 */
function hasOverlappingAlternatives(body: string): boolean {
  const branches = body.split('|').map((b) => b.trim());
  if (branches.length < 2) return false;
  // Compare every pair; if any branch is a prefix of another (or they share
  // the same first literal character), flag it.
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const a = branches[i];
      const b = branches[j];
      if (a === '' || b === '') continue;
      // Same first char (ignoring regex metachars at the very start) — treat
      // as overlapping. E.g. (a|ab), (a|a?), (foo|foobar).
      if (a[0] === b[0]) return true;
      // One is a prefix of the other.
      if (a.startsWith(b) || b.startsWith(a)) return true;
    }
  }
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
 * **Case sensitivity (SEC-012):** Before pattern testing, the guard converts
 * the content to lowercase and NFKC-normalizes it. This means:
 *   - Keyword matches are effectively case-insensitive.
 *   - User-supplied `blockedPatterns` are tested against **lowercased**
 *     content. If your pattern uses uppercase literals (e.g., `/SECRET/`) it
 *     will NEVER match — supply lowercase literals or add the `i` flag (which
 *     makes no difference here but improves readability).
 *   - `RegExp`s with the `g` flag are defensively reset via `.lastIndex = 0`
 *     before each `.test()` so repeated calls don't silently miss matches.
 *
 * **ReDoS protection:** Every user-supplied `blockedPatterns` entry is
 * validated at construction time for catastrophic-backtracking risk (nested
 * quantifiers, overlapping alternation with a repeat, etc.). Unsafe patterns
 * throw `HarnessError(HarnessErrorCode.CORE_REDOS_PATTERN)`.
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
    // Determine appropriate boundary assertions based on first/last characters.
    // Use Unicode-aware \p{L} (letter) and \p{N} (number) via 'u' flag so
    // non-ASCII keywords like "café" get correct boundary detection (SEC-012).
    const startsWithWord = /^[\p{L}\p{N}_]/u.test(normalized);
    const endsWithWord = /[\p{L}\p{N}_]$/u.test(normalized);
    const prefix = startsWithWord ? '(?<!\\p{L}|\\p{N}|_)' : '(?<!\\p{L}|\\p{N}|_)';
    const suffix = endsWithWord ? '(?!\\p{L}|\\p{N}|_)' : '(?!\\p{L}|\\p{N}|_)';
    return {
      original: normalized,
      regex: new RegExp(prefix + escaped + suffix, 'giu'),
    };
  });
  const rawPatterns = config.blockedPatterns ?? [];
  // Validate each user-provided pattern for ReDoS candidates before accepting it
  for (const pat of rawPatterns) {
    if (isReDoSCandidate(pat.source)) {
      throw new HarnessError(
        `Blocked pattern /${pat.source}/ is a potential ReDoS candidate (contains nested or adjacent quantifiers)`,
        HarnessErrorCode.CORE_REDOS_PATTERN,
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
