/**
 * Spawn a sub-agent loop, run it to completion, and return the result.
 *
 * @module
 */

import { AgentLoop } from '../core/agent-loop.js';
import type { Message } from '../core/types.js';
import type { DoneReason } from '../core/events.js';
import type { SpawnSubAgentConfig, SpawnSubAgentResult } from './types.js';

/**
 * Spawn a child {@link AgentLoop}, run it to completion, and return the
 * accumulated conversation, token usage, and termination reason.
 *
 * **Streaming limitation** (Fix 32): Child agent streaming output is consumed
 * internally by the sub-agent loop. To receive real-time updates from child
 * agents, use the event callback mechanism via `onEvent` instead of direct
 * stream passthrough. The stream events are processed sequentially and results
 * are only available after the sub-agent loop completes.
 */
export async function spawnSubAgent(config: SpawnSubAgentConfig): Promise<SpawnSubAgentResult> {
  const loopConfig: Record<string, unknown> = {
    adapter: config.adapter,
    maxIterations: config.maxIterations ?? 10,
  };
  if (config.maxTotalTokens !== undefined) loopConfig.maxTotalTokens = config.maxTotalTokens;
  if (config.signal !== undefined) loopConfig.signal = config.signal;
  if (config.tools) loopConfig.tools = [...config.tools];
  if (config.onToolCall !== undefined) loopConfig.onToolCall = config.onToolCall;
  if (config.streaming !== undefined) loopConfig.streaming = config.streaming;
  const loop = new AgentLoop(loopConfig as unknown as ConstructorParameters<typeof AgentLoop>[0]);

  const conversation: Message[] = [...config.messages];
  let doneReason: DoneReason = 'end_turn';

  try {
    for await (const event of loop.run([...config.messages])) {
      if (event.type === 'message') {
        conversation.push(event.message);
      } else if (event.type === 'tool_result') {
        conversation.push({
          role: 'tool' as const,
          content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
          toolCallId: event.toolCallId,
        });
      } else if (event.type === 'done') {
        doneReason = event.reason;
      }
    }
  } finally {
    loop.dispose();
  }

  return Object.freeze({
    messages: Object.freeze([...conversation]),
    usage: Object.freeze({ ...loop.usage }),
    doneReason,
  });
}
