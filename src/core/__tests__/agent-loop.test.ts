import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type { AgentAdapter, ChatResponse, Message, ToolCallRequest } from '../types.js';
import type { AgentEvent } from '../events.js';

/** Helper: collect all events from an async generator. */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

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

const USAGE = { inputTokens: 10, outputTokens: 5 };

describe('AgentLoop', () => {
  describe('normal completion', () => {
    it('yields iteration_start, message, and done for a simple response', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hello!' }, usage: USAGE },
      ]);
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      expect(events[0]).toEqual({ type: 'iteration_start', iteration: 1 });
      expect(events[1]).toEqual({ type: 'message', message: { role: 'assistant', content: 'Hello!' }, usage: USAGE });
      expect(events[2]).toEqual({ type: 'done', reason: 'end_turn', totalUsage: { inputTokens: 10, outputTokens: 5 } });
      expect(events).toHaveLength(3);
    });
  });

  describe('tool call loop', () => {
    it('calls onToolCall and feeds result back to LLM', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'search', arguments: '{"q":"test"}' };
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE },
        { message: { role: 'assistant', content: 'Found it!' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockResolvedValue('search result');

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'search for test' }]));

      expect(onToolCall).toHaveBeenCalledWith(toolCall);

      const types = events.map((e) => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types).toContain('message');
      expect(types).toContain('done');
    });
  });

  describe('empty tool calls array = end turn', () => {
    it('treats empty toolCalls array as normal end turn', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Done', toolCalls: [] }, usage: USAGE },
      ]);
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      expect((done as Extract<AgentEvent, { type: 'done' }>).reason).toBe('end_turn');
    });
  });

  describe('max iterations', () => {
    it('stops after maxIterations and yields done with reason max_iterations', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
      // Always return tool calls to force looping
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxIterations: 3, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('max_iterations');

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
    });
  });

  describe('abort via signal', () => {
    it('stops when AbortSignal is triggered', async () => {
      const controller = new AbortController();
      const adapter: AgentAdapter = {
        async chat() {
          controller.abort();
          return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, signal: controller.signal, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('aborted');
    });
  });

  describe('abort via .abort() method', () => {
    it('stops when .abort() is called', async () => {
      let callCount = 0;
      let loopRef: AgentLoop;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount >= 2) loopRef.abort();
          return { message: { role: 'assistant', content: '', toolCalls: [{ id: `c${callCount}`, name: 't', arguments: '{}' }] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      loopRef = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loopRef.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('aborted');
    });
  });

  describe('errors as feedback', () => {
    it('serializes onToolCall errors as tool messages and continues', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'bad_tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'I handled the error' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockRejectedValue(new Error('tool crashed'));

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('end_turn');

      // Should have a tool_result with the error
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
    });
  });

  describe('token budget exceeded', () => {
    it('stops when cumulative tokens exceed maxTotalTokens', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      const bigUsage = { inputTokens: 500, outputTokens: 500 };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: bigUsage };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: bigUsage };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1500, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('token_budget');
    });
  });

  describe('usage getter', () => {
    it('returns cumulative token usage', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hi' }, usage: { inputTokens: 100, outputTokens: 50 } },
      ]);
      const loop = new AgentLoop({ adapter });
      await collectEvents(loop.run([{ role: 'user', content: 'Hello' }]));

      expect(loop.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });
  });
});
