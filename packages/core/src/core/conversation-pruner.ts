/**
 * Conversation pruning logic for the agent loop.
 *
 * Extracted from AgentLoop to keep the core loop focused on orchestration.
 * Handles system message preservation, tail selection, and orphaned tool
 * message cleanup.
 *
 * @module
 */

import type { Message } from './types.js';

/**
 * Result of pruning a conversation. `pruned` is the trimmed conversation
 * array; `warning` is a human-readable note when truncation occurred.
 */
export interface PruneResult {
  readonly pruned: Message[];
  readonly warning?: string;
}

/**
 * Prune a conversation to fit within a maximum message count.
 *
 * Preserves all leading system messages, then takes the most recent
 * (tail) non-system messages to fill the remaining slots. After slicing,
 * cleans up:
 * - Orphaned tool messages at the start of the tail (tool messages without
 *   a preceding assistant message that requested them).
 * - Assistant messages with incomplete tool calls (where some tool result
 *   messages were pruned away).
 *
 * Returns the original conversation unchanged (no warning) when the
 * conversation length is within the limit.
 *
 * @param conversation - The full conversation to prune.
 * @param maxMessages - Maximum number of messages to keep.
 */
export function pruneConversation(
  conversation: Message[],
  maxMessages: number,
): PruneResult {
  if (maxMessages < 1) {
    return { pruned: [], warning: 'maxMessages < 1; conversation fully pruned' };
  }
  if (conversation.length <= maxMessages) {
    return { pruned: conversation };
  }

  const warning = `Conversation pruned from ${conversation.length} to ${maxMessages} messages`;

  // Index-based pruning: compute head/tail boundaries without allocating
  // intermediate arrays, then materialize a single result array at the end.
  // Previously this used 3–5 Array.slice() calls producing O(n) copies each.

  let systemCount = 0;
  while (systemCount < conversation.length && conversation[systemCount].role === 'system') {
    systemCount++;
  }
  const headEnd = Math.max(1, systemCount); // inclusive upper bound exclusive
  const tailSize = maxMessages - headEnd;
  let tailStart = conversation.length - Math.max(1, tailSize);
  if (tailStart < headEnd) tailStart = headEnd;

  // Advance tailStart past orphaned tool messages (no preceding assistant
  // inside the tail window).
  while (tailStart < conversation.length && conversation[tailStart].role === 'tool') {
    tailStart++;
  }

  // If the tail now starts with an assistant that has tool_calls, make sure
  // every corresponding tool-result message is still inside the tail window.
  // If not, drop the assistant + any following orphan tool messages.
  if (tailStart < conversation.length && conversation[tailStart].role === 'assistant') {
    const assistantMsg = conversation[tailStart];
    if (assistantMsg.role === 'assistant' && assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
      const needed = new Set(assistantMsg.toolCalls.map(tc => tc.id));
      for (let i = tailStart + 1; i < conversation.length && needed.size > 0; i++) {
        const m = conversation[i];
        if (m.role === 'tool') needed.delete((m as { toolCallId: string }).toolCallId);
      }
      if (needed.size > 0) {
        tailStart++;
        while (tailStart < conversation.length && conversation[tailStart].role === 'tool') {
          tailStart++;
        }
      }
    }
  }

  // Materialize the result in one allocation.
  const result: Message[] = new Array(headEnd + (conversation.length - tailStart));
  let w = 0;
  for (let i = 0; i < headEnd; i++) result[w++] = conversation[i];
  for (let i = tailStart; i < conversation.length; i++) result[w++] = conversation[i];
  result.length = w;

  return { pruned: result, warning };
}
