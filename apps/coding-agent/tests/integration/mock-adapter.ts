/**
 * Programmable mock adapter for integration tests.
 *
 * Each `chat()` call returns the next entry from the configured `script`,
 * so tests can scenario-drive the AgentLoop into specific states without
 * spinning up a real LLM.
 *
 * @module
 */

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  ToolCallRequest,
} from 'harness-one/core';

export interface MockTurn {
  readonly text?: string;
  readonly toolCalls?: readonly { id: string; name: string; arguments: string }[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface MockAdapter extends AgentAdapter {
  readonly captured: ChatParams[];
}

/**
 * Build a programmable mock adapter.
 *
 * After exhausting `script`, the adapter returns a final-text turn
 * containing `"DONE"` so the AgentLoop terminates cleanly.
 */
export function createMockAdapter(script: readonly MockTurn[]): MockAdapter {
  const captured: ChatParams[] = [];
  let cursor = 0;

  function nextTurn(): MockTurn {
    if (cursor < script.length) return script[cursor++];
    return { text: 'DONE', outputTokens: 1 };
  }

  function buildResponse(turn: MockTurn): ChatResponse {
    const usage = {
      inputTokens: turn.inputTokens ?? 5,
      outputTokens: turn.outputTokens ?? 5,
    };
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      const toolCalls: ToolCallRequest[] = turn.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      return {
        message: {
          role: 'assistant',
          content: turn.text ?? '',
          toolCalls,
        },
        usage,
      };
    }
    return {
      message: { role: 'assistant', content: turn.text ?? '' },
      usage,
    };
  }

  return {
    name: 'coding-agent:mock',
    captured,
    async chat(params: ChatParams): Promise<ChatResponse> {
      captured.push(params);
      return buildResponse(nextTurn());
    },
    async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
      captured.push(params);
      const turn = nextTurn();
      const usage = {
        inputTokens: turn.inputTokens ?? 5,
        outputTokens: turn.outputTokens ?? 5,
      };
      if (turn.text) yield { type: 'text_delta', text: turn.text };
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          yield { type: 'tool_call_delta', toolCall: tc };
        }
      }
      yield { type: 'done', usage };
    },
  };
}
