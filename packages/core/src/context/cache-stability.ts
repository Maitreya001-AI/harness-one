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

  // If completely equal
  if (firstDivergenceIndex === -1) {
    const totalTokens = countTokens(m, [...v1]);
    return {
      prefixMatchRatio: 1,
      firstDivergenceIndex: -1,
      stablePrefixTokens: totalTokens,
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
    recommendations,
  };
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
