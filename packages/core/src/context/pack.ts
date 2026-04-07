/**
 * Context packing — assembles HEAD+MID+TAIL segments, trimming MID if over budget.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { ContextLayout } from './types.js';
import { countTokens } from './count-tokens.js';

/**
 * Pack context into a message array, trimming the MID section if needed.
 *
 * HEAD and TAIL are always included. MID is trimmed from the front (oldest first)
 * when the total exceeds the budget.
 *
 * @example
 * ```ts
 * const result = packContext({
 *   head: [systemMsg],
 *   mid: conversationHistory,
 *   tail: [latestMsg],
 *   budget,
 * }, 'claude-3');
 * ```
 */
export function packContext(
  layout: ContextLayout,
  model?: string,
): { messages: Message[]; truncated: boolean; usage: { head: number; mid: number; tail: number } } {
  const m = model ?? 'default';

  const headTokens = countTokens(m, layout.head);
  const tailTokens = countTokens(m, layout.tail);
  const totalBudget = layout.budget.totalTokens;

  const midBudget = totalBudget - headTokens - tailTokens;

  let mid = [...layout.mid];
  let midTokens = countTokens(m, mid);
  let truncated = false;

  // Trim from the front (oldest messages) if over budget
  while (midTokens > midBudget && mid.length > 0) {
    const removed = mid.shift()!;
    const removedTokens = countTokens(m, [removed]);
    midTokens -= removedTokens;
    truncated = true;
  }

  return {
    messages: [...layout.head, ...mid, ...layout.tail],
    truncated,
    usage: { head: headTokens, mid: midTokens, tail: tailTokens },
  };
}
