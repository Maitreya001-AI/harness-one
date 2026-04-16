/**
 * Cache stability analysis — compare two message arrays to assess
 * how well prompt caching will work across iterations.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { CacheStabilityReport } from './types.js';
import { countTokens } from './count-tokens.js';

/**
 * Analyze cache stability between two versions of a message array.
 *
 * Finds the first divergence point, calculates the prefix match ratio,
 * and generates recommendations for improving cache hit rates.
 *
 * @example
 * ```ts
 * const report = analyzeCacheStability(
 *   [{ role: 'system', content: 'You are helpful' }, { role: 'user', content: 'Hi' }],
 *   [{ role: 'system', content: 'You are helpful' }, { role: 'user', content: 'Hello' }],
 * );
 * // report.prefixMatchRatio === 0.5
 * ```
 */
export function analyzeCacheStability(
  v1: readonly Message[],
  v2: readonly Message[],
  model?: string,
): CacheStabilityReport {
  const m = model ?? 'default';
  const maxLen = Math.max(v1.length, v2.length);
  const minLen = Math.min(v1.length, v2.length);

  // Find first divergence
  let firstDivergenceIndex = -1;
  for (let i = 0; i < minLen; i++) {
    if (!messagesEqual(v1[i], v2[i])) {
      firstDivergenceIndex = i;
      break;
    }
  }

  // If no divergence found in shared range, but lengths differ
  if (firstDivergenceIndex === -1 && v1.length !== v2.length) {
    firstDivergenceIndex = minLen;
  }

  // Compute content overlap ratio regardless of position
  const contentOverlapRatio = computeContentOverlapRatio(v1, v2);

  // If completely equal
  if (firstDivergenceIndex === -1) {
    const totalTokens = countTokens(m, [...v1]);
    return {
      prefixMatchRatio: 1,
      firstDivergenceIndex: -1,
      stablePrefixTokens: totalTokens,
      contentOverlapRatio,
      recommendations: [],
    };
  }

  const prefixMatchRatio = maxLen > 0 ? firstDivergenceIndex / maxLen : 1;
  const stablePrefix = v1.slice(0, firstDivergenceIndex);
  const stablePrefixTokens = countTokens(m, [...stablePrefix]);

  const recommendations: string[] = [];

  if (prefixMatchRatio < 0.5) {
    recommendations.push(
      'Low prefix match ratio. Consider pinning system messages and tool definitions at the start.',
    );
  }

  if (firstDivergenceIndex === 0) {
    recommendations.push(
      'Messages diverge from the very first position. Ensure system prompts are identical across calls.',
    );
  }

  if (prefixMatchRatio >= 0.5 && prefixMatchRatio < 0.8) {
    recommendations.push(
      'Moderate cache stability. Consider using a HEAD/MID/TAIL layout to stabilize the prefix.',
    );
  }

  return {
    prefixMatchRatio,
    firstDivergenceIndex,
    stablePrefixTokens,
    contentOverlapRatio,
    recommendations,
  };
}

/**
 * Compute the ratio of content shared between two message arrays regardless of position.
 * Uses a multiset approach: each unique message key is counted in both arrays,
 * and the overlap is the sum of min(countA, countB) / max(totalA, totalB).
 */
function computeContentOverlapRatio(
  v1: readonly Message[],
  v2: readonly Message[],
): number {
  const total = Math.max(v1.length, v2.length);
  if (total === 0) return 1;

  function messageKey(m: Message): string {
    const content = typeof m.content === 'string' ? m.content : stableStringify(m.content);
    return `${m.role}::${content}::${m.name ?? ''}`;
  }

  const counts1 = new Map<string, number>();
  for (const m of v1) {
    const k = messageKey(m);
    counts1.set(k, (counts1.get(k) ?? 0) + 1);
  }

  const counts2 = new Map<string, number>();
  for (const m of v2) {
    const k = messageKey(m);
    counts2.set(k, (counts2.get(k) ?? 0) + 1);
  }

  let overlap = 0;
  for (const [k, c1] of counts1) {
    const c2 = counts2.get(k) ?? 0;
    overlap += Math.min(c1, c2);
  }

  return overlap / total;
}

/**
 * Stable JSON serialization with sorted keys. Ensures identical logical
 * content always produces the same string regardless of property insertion
 * order (unlike native JSON.stringify).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return `{${sorted.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function messagesEqual(a: Message, b: Message): boolean {
  if (a.role !== b.role || a.content !== b.content || a.name !== b.name) {
    return false;
  }

  // Compare tool-specific fields using discriminated union narrowing
  if (a.role === 'tool' && b.role === 'tool') {
    if (a.toolCallId !== b.toolCallId) return false;
  }

  if (a.role === 'assistant' && b.role === 'assistant') {
    if (!toolCallsEqual(a.toolCalls, b.toolCalls)) return false;
  }

  return true;
}

/**
 * Deep structural comparison of toolCalls arrays.
 * Compares field-by-field instead of relying on JSON.stringify,
 * which is not stable across different key insertion orders.
 */
function toolCallsEqual(
  a: readonly import('../core/types.js').ToolCallRequest[] | undefined,
  b: readonly import('../core/types.js').ToolCallRequest[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const ca = a[i];
    const cb = b[i];
    if (ca.id !== cb.id || ca.name !== cb.name || ca.arguments !== cb.arguments) {
      return false;
    }
  }
  return true;
}
