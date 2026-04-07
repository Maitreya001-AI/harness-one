/**
 * Content filter guardrail for blocked keywords and patterns.
 *
 * @module
 */

import type { Guardrail } from './types.js';

/**
 * Create a content filter guardrail.
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
  const blockedLower = (config.blocked ?? []).map((w) => w.toLowerCase());
  const patterns = config.blockedPatterns ?? [];

  const guard: Guardrail = (ctx) => {
    const contentLower = ctx.content.toLowerCase();

    for (const word of blockedLower) {
      if (contentLower.includes(word)) {
        return { action: 'block', reason: `Content contains blocked keyword: "${word}"` };
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
