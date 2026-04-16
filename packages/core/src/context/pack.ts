/**
 * Context packing — assembles HEAD+MID+TAIL segments, trimming MID if over budget.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type { ContextLayout } from './types.js';
import { countTokens, countMessageTokens } from './count-tokens.js';

/**
 * Pack context into a message array, trimming the MID section if needed.
 *
 * HEAD and TAIL are always included. MID is trimmed from the front (oldest first)
 * when the total exceeds the budget.
 *
 * Uses pre-computed per-message token counts and index-based trimming to avoid
 * O(N^2) performance from array shifting and recounting.
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
): { messages: Message[]; truncated: boolean; midBudgetExhausted: boolean; usage: { head: number; mid: number; tail: number } } {
  const m = model ?? 'default';

  const headTokens = countTokens(m, layout.head);
  const tailTokens = countTokens(m, layout.tail);
  const responseReserve = Math.max(0, layout.budget.responseReserve ?? 0);
  const totalBudget = Math.max(0, layout.budget.totalTokens - responseReserve);

  // H6: Clamp midBudget to 0 when HEAD+TAIL exceed total budget
  const midBudget = Math.max(0, totalBudget - headTokens - tailTokens);
  const midBudgetExhausted = midBudget === 0;

  // C3: Pre-compute per-message token counts to avoid O(N^2) recounting
  const midMsgs = layout.mid;
  const perMsgTokens: number[] = new Array(midMsgs.length);
  let midTokens = 0;
  for (let i = 0; i < midMsgs.length; i++) {
    const t = countMessageTokens(m, midMsgs[i]);
    perMsgTokens[i] = t;
    midTokens += t;
  }

  // C3: Use index-based trimming instead of mid.shift() to avoid O(N^2)
  let trimStart = 0;
  let truncated = false;

  while (midTokens > midBudget && trimStart < midMsgs.length) {
    midTokens -= perMsgTokens[trimStart];
    trimStart++;
    truncated = true;
  }

  const mid = midMsgs.slice(trimStart);

  return {
    messages: [...layout.head, ...mid, ...layout.tail],
    truncated,
    midBudgetExhausted,
    usage: { head: headTokens, mid: midTokens, tail: tailTokens },
  };
}
