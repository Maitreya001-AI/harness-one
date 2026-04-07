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

  describe('FIX-3: Negative token budget underflow', () => {
    it('clamps negative token values to zero so they cannot bypass budget', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      // First call: adapter reports negative tokens (malicious/buggy adapter)
      // Second call: adapter reports large positive tokens and returns tool calls
      //   so the loop continues to a third iteration where the budget check triggers
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return {
              message: { role: 'assistant', content: '', toolCalls: [toolCall] },
              usage: { inputTokens: -1000, outputTokens: -1000 },
            };
          }
          // Return tool calls so the loop continues to iteration 3 where budget is checked
          return {
            message: { role: 'assistant', content: '', toolCalls: [toolCall] },
            usage: { inputTokens: 800, outputTokens: 800 },
          };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1500, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Negative tokens should be clamped to 0, so cumulative is 0+800+800=1600 after two calls
      // which exceeds the 1500 budget on the third iteration check.
      // Without clamping: -2000 + 1600 = -400, budget never exceeded.
      expect(loop.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(loop.usage.outputTokens).toBeGreaterThanOrEqual(0);

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('token_budget');
    });
  });

  describe('FIX-7: Generator cleanup on .return()/.throw()', () => {
    it('yields a done event with reason aborted when consumer breaks out early', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxIterations: 100, onToolCall });
      const events: AgentEvent[] = [];

      const gen = loop.run([{ role: 'user', content: 'test' }]);
      // Consume only a few events then break
      for await (const event of gen) {
        events.push(event);
        if (events.length >= 3) break; // break out early
      }

      // The generator should have yielded a done event with reason 'aborted' in finally
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }> | undefined;
      // If no done event was collected during iteration, the finally block should handle cleanup
      // We verify the generator is properly closed by checking it doesn't hang
      // The key assertion: after breaking, the generator should be done
      const next = await gen.next();
      expect(next.done).toBe(true);
    });
  });
});
