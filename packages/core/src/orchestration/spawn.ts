/**
 * Spawn a sub-agent loop, run it to completion, and return the result.
 *
 * @module
 */

import { AgentLoop } from '../core/agent-loop.js';
import type { Message, TokenUsage } from '../core/types.js';
import type { DoneReason } from '../core/events.js';
import type { SpawnSubAgentConfig, SpawnSubAgentResult } from './types.js';

/**
 * Spawn a child {@link AgentLoop}, run it to completion, and return the
 * accumulated conversation, token usage, and termination reason.
 */
export async function spawnSubAgent(config: SpawnSubAgentConfig): Promise<SpawnSubAgentResult> {
  const loop = new AgentLoop({
    adapter: config.adapter,
    maxIterations: config.maxIterations ?? 10,
    maxTotalTokens: config.maxTotalTokens,
    signal: config.signal,
    tools: config.tools ? [...config.tools] : undefined,
    onToolCall: config.onToolCall,
    streaming: config.streaming,
  });

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
