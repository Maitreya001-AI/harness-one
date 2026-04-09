/**
 * Testing utilities — mock adapters and helpers for writing agent tests.
 *
 * @module
 */

import type { AgentAdapter, AssistantMessage, ChatParams, ChatResponse, Message, TokenUsage } from './types.js';

/** Configuration for the mock adapter. */
export interface MockAdapterConfig {
  /** Ordered list of responses the mock will return. The last response repeats. */
  responses: Array<{ content: string; toolCalls?: AssistantMessage['toolCalls'] }>;
}

/**
 * Create a mock AgentAdapter that returns pre-configured responses.
 *
 * The returned adapter includes a `calls` array capturing every ChatParams
 * it received, enabling assertions on what was sent to the LLM.
 *
 * @example
 * ```ts
 * const adapter = createMockAdapter({
 *   responses: [
 *     { content: 'Hello!' },
 *     { content: 'Tool result', toolCalls: [{ id: '1', name: 'search', arguments: '{}' }] },
 *   ],
 * });
 * const response = await adapter.chat({ messages: [] });
 * expect(adapter.calls).toHaveLength(1);
 * ```
 */
export function createMockAdapter(
  config: MockAdapterConfig,
): AgentAdapter & { calls: ChatParams[] } {
  let responseIndex = 0;
  const calls: ChatParams[] = [];

  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      const resp = config.responses[Math.min(responseIndex++, config.responses.length - 1)];
      const message: Message = {
        role: 'assistant',
        content: resp.content,
        ...(resp.toolCalls ? { toolCalls: resp.toolCalls } : {}),
      };
      const usage: TokenUsage = { inputTokens: 10, outputTokens: 5 };
      return { message, usage };
    },
  };
}
