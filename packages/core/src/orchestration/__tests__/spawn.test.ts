import { describe, it, expect, vi } from 'vitest';
import { spawnSubAgent } from '../spawn.js';
import type { AgentAdapter, ChatResponse, ToolCallRequest } from '../../core/types.js';

const USAGE = { inputTokens: 10, outputTokens: 5 };

/** Helper: create a mock adapter that returns responses in sequence. */
function createMockAdapter(responses: ChatResponse[]): AgentAdapter {
  let callIndex = 0;
  return {
    async chat() {
      const response = responses[callIndex];
      if (!response) throw new Error('No more mock responses');
      callIndex++;
      return response;
    },
  };
}

describe('spawnSubAgent', () => {
  it('returns messages and usage for a basic spawn', async () => {
    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: 'Hello from sub-agent' }, usage: USAGE },
    ]);

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.doneReason).toBe('end_turn');
    expect(result.usage).toEqual(USAGE);
    // Should contain the original user message + assistant reply
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hi' });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'Hello from sub-agent' });
  });

  it('propagates abort signal', async () => {
    const ac = new AbortController();
    // Abort immediately
    ac.abort();

    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: 'should not reach' }, usage: USAGE },
    ]);

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'Hi' }],
      signal: ac.signal,
    });

    expect(result.doneReason).toBe('aborted');
  });

  it('reflects cumulative token usage', async () => {
    const toolCall: ToolCallRequest = { id: 'tc-1', name: 'echo', arguments: '{}' };
    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: { inputTokens: 20, outputTokens: 10 } },
      { message: { role: 'assistant', content: 'Done' }, usage: { inputTokens: 30, outputTokens: 15 } },
    ]);

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'go' }],
      onToolCall: async () => 'ok',
    });

    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(25);
  });

  it('includes tool call results in messages', async () => {
    const toolCall: ToolCallRequest = { id: 'tc-1', name: 'search', arguments: '{"q":"test"}' };
    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE },
      { message: { role: 'assistant', content: 'Found it' }, usage: USAGE },
    ]);
    const onToolCall = vi.fn().mockResolvedValue('search result');

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'search' }],
      onToolCall,
    });

    expect(onToolCall).toHaveBeenCalledWith(toolCall);
    // user, tool result (from event), assistant (final message event)
    // Note: intermediate assistant messages with tool calls are not emitted as 'message' events
    expect(result.messages).toHaveLength(3);
    const toolMsg = result.messages[1];
    expect(toolMsg.role).toBe('tool');
    if (toolMsg.role === 'tool') {
      expect(toolMsg.toolCallId).toBe('tc-1');
      expect(toolMsg.content).toBe('search result');
    }
    expect(result.messages[2]).toEqual({ role: 'assistant', content: 'Found it' });
  });

  it('returns frozen result and messages', async () => {
    const adapter = createMockAdapter([
      { message: { role: 'assistant', content: 'Hi' }, usage: USAGE },
    ]);

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
  });

  it('reports max_iterations doneReason', async () => {
    // Adapter always returns tool calls, so loop hits max iterations
    const toolCall: ToolCallRequest = { id: 'tc-1', name: 'loop', arguments: '{}' };
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        return {
          message: { role: 'assistant' as const, content: '', toolCalls: [{ ...toolCall, id: `tc-${callCount}` }] },
          usage: USAGE,
        };
      },
    };

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'go' }],
      onToolCall: async () => 'ok',
      maxIterations: 2,
    });

    expect(result.doneReason).toBe('max_iterations');
  });

  it('uses default maxIterations of 10', async () => {
    let callCount = 0;
    const adapter: AgentAdapter = {
      async chat() {
        callCount++;
        return {
          message: { role: 'assistant' as const, content: '', toolCalls: [{ id: `tc-${callCount}`, name: 'loop', arguments: '{}' }] },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const result = await spawnSubAgent({
      adapter,
      messages: [{ role: 'user', content: 'go' }],
      onToolCall: async () => 'ok',
    });

    expect(result.doneReason).toBe('max_iterations');
    // Should have hit max at iteration 11 (> 10), so 10 adapter calls
    expect(callCount).toBe(10);
  });
});
