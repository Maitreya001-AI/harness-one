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
 * Result of pruning a conversation.
 *
 * @property pruned - The pruned conversation array.
 * @property warning - A human-readable warning if pruning occurred.
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
  if (conversation.length <= maxMessages) {
    return { pruned: conversation };
  }

  const warning = `Conversation pruned from ${conversation.length} to ${maxMessages} messages`;

  // Preserve all leading system messages (there may be 0 or more)
  let systemCount = 0;
  while (systemCount < conversation.length && conversation[systemCount].role === 'system') {
    systemCount++;
  }
  const head = conversation.slice(0, Math.max(1, systemCount));
  const tailSize = maxMessages - head.length;
  let tail = conversation.slice(-Math.max(1, tailSize));

  // Validate pruned tail: ensure no orphaned tool messages at the start.
  // A tool message must be preceded by an assistant message with matching toolCallId.
  // Walk forward from the start of tail, dropping orphaned tool messages and
  // any assistant messages whose tool calls have lost their corresponding results.
  while (tail.length > 0 && tail[0].role === 'tool') {
    tail = tail.slice(1);
  }

  // Ensure the tail doesn't start with an assistant message that has tool calls
  // without their corresponding tool result messages (which may have been pruned).
  if (tail.length > 0 && tail[0].role === 'assistant') {
    const assistantMsg = tail[0];
    if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
      // Check if all tool call results are present in the remaining tail
      const toolCallIds = new Set(assistantMsg.toolCalls.map(tc => tc.id));
      const resultIds = new Set(
        tail.filter(m => m.role === 'tool').map(m => (m as { toolCallId: string }).toolCallId)
      );
      const allPresent = [...toolCallIds].every(id => resultIds.has(id));
      if (!allPresent) {
        // Drop the assistant message with incomplete tool calls
        tail = tail.slice(1);
        // Also drop any orphaned tool messages that followed it
        while (tail.length > 0 && tail[0].role === 'tool') {
          tail = tail.slice(1);
        }
      }
    }
  }

  return { pruned: [...head, ...tail], warning };
}
