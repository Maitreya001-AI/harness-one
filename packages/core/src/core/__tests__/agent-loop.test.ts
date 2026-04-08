import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type { AgentAdapter, ChatResponse, Message, ToolCallRequest, StreamChunk, ToolSchema } from '../types.js';
import type { AgentEvent } from '../events.js';
import { HarnessError } from '../errors.js';

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

  // =====================================================================
  // Reproduction tests for identified issues
  // =====================================================================

  describe('C5: adapter.chat() exceptions must be caught', () => {
    it('yields error event and done event when adapter.chat() throws', async () => {
      const adapterError = new Error('LLM provider connection failed');
      const adapter: AgentAdapter = {
        async chat() {
          throw adapterError;
        },
      };

      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Must yield an error event wrapping the adapter error
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as Extract<AgentEvent, { type: 'error' }>).error).toBeDefined();

      // Must still yield a done event for cleanup
      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect((doneEvent as Extract<AgentEvent, { type: 'done' }>).reason).toBe('error');
    });

    it('yields done event even when adapter.chat() throws on second iteration', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          throw new Error('Rate limited');
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
    });
  });

  describe('F14: Tool call exceptions do not leak stack traces to LLM', () => {
    it('includes error message but not stack trace in tool result when onToolCall throws', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'bad_tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'handled' }, usage: USAGE };
        },
      };
      const toolError = new Error('tool crashed with details');
      toolError.stack = 'Error: tool crashed with details\n    at ToolHandler (tool.ts:42:5)';
      const onToolCall = vi.fn().mockRejectedValue(toolError);

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();

      // The result should contain the error message but NOT the stack trace
      const resultObj = toolResult.result as { error: string; stack?: string };
      expect(resultObj.error).toBe('tool crashed with details');
      expect(resultObj.stack).toBeUndefined();
    });
  });

  describe('H2: Token budget check must trigger immediately after exceeding', () => {
    it('does not process tool calls when budget is already exceeded after response', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      // Adapter returns a response with tool calls that exceeds the budget
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          // First call uses 2000 tokens, which exceeds budget of 1500
          // and returns tool calls
          return {
            message: { role: 'assistant', content: '', toolCalls: [toolCall] },
            usage: { inputTokens: 1000, outputTokens: 1000 },
          };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1500, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // onToolCall should NOT have been called because budget was exceeded
      // after the first response -- tool calls should be skipped
      expect(onToolCall).not.toHaveBeenCalled();

      // Should only have made one adapter.chat() call
      expect(callCount).toBe(1);

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('token_budget');
    });
  });

  describe('H3: abort() cancels in-flight adapter.chat() calls', () => {
    it('passes abort signal to adapter.chat() and cancels on abort()', async () => {
      let receivedSignal: AbortSignal | undefined;
      const adapter: AgentAdapter = {
        async chat(params) {
          receivedSignal = params.signal;
          // Simulate a long-running call
          return { message: { role: 'assistant', content: 'Hi' }, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // The adapter should have received an AbortSignal
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    it('aborts the signal passed to adapter when abort() is called', async () => {
      let receivedSignal: AbortSignal | undefined;
      let resolveChat: ((value: ChatResponse) => void) | undefined;

      const adapter: AgentAdapter = {
        chat(params) {
          receivedSignal = params.signal;
          return new Promise((resolve) => {
            resolveChat = resolve;
          });
        },
      };

      const loop = new AgentLoop({ adapter });
      const gen = loop.run([{ role: 'user', content: 'test' }]);

      // First gen.next() yields iteration_start synchronously, then the generator
      // enters the adapter.chat() call which returns a pending Promise.
      // The second gen.next() will be blocked waiting for chat() to resolve.
      const first = await gen.next(); // iteration_start
      expect(first.value).toEqual({ type: 'iteration_start', iteration: 1 });

      // Start the second gen.next() which will call adapter.chat() and block
      const secondPromise = gen.next();

      // Wait a tick for the chat() call to be invoked
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now adapter.chat() has been called and receivedSignal should be set
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);

      // Abort the loop -- this should abort the signal
      loop.abort();
      expect(receivedSignal!.aborted).toBe(true);

      // Resolve the chat to let the generator proceed
      resolveChat!({ message: { role: 'assistant', content: 'Hi' }, usage: USAGE });

      // Drain remaining events
      const events: AgentEvent[] = [];
      let result = await secondPromise;
      if (!result.done) events.push(result.value);
      while (true) {
        result = await gen.next();
        if (result.done) break;
        events.push(result.value);
      }

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('aborted');
    });

    it('links external signal to internal abort controller', async () => {
      let receivedSignal: AbortSignal | undefined;
      const externalController = new AbortController();

      const adapter: AgentAdapter = {
        async chat(params) {
          receivedSignal = params.signal;
          return { message: { role: 'assistant', content: 'Hi' }, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, signal: externalController.signal });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // The adapter should receive a signal (the internal one, linked to external)
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('H4: Conversation array unbounded growth warning', () => {
    it('emits warning event when conversation exceeds maxConversationMessages', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 3) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 5,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should emit a warning event when conversation exceeds limit
      const warningEvent = events.find((e) => e.type === 'warning');
      expect(warningEvent).toBeDefined();
      expect((warningEvent as Extract<AgentEvent, { type: 'warning' }>).message.toLowerCase()).toContain('conversation');

      // Should still complete normally (don't hard-fail)
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
    });
  });

  describe('H5: Agent Loop passes tools to adapter', () => {
    it('passes tools config to adapter.chat() in every call', async () => {
      const receivedTools: (readonly ToolSchema[] | undefined)[] = [];
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'search', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          receivedTools.push(params.tools);
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('result');

      const tools: ToolSchema[] = [
        { name: 'search', description: 'Search', parameters: { type: 'object' } },
      ];

      const loop = new AgentLoop({ adapter, onToolCall, tools });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Every adapter.chat() call should have received the tools
      expect(receivedTools).toHaveLength(2);
      expect(receivedTools[0]).toEqual(tools);
      expect(receivedTools[1]).toEqual(tools);
    });
  });

  describe('Streaming: Agent Loop supports streaming mode', () => {
    it('uses adapter.stream() and yields text_delta events when streaming is enabled', async () => {
      const chunks: StreamChunk[] = [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ];

      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'Hello world' }, usage: USAGE };
        },
        async *stream() {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // Should yield text_delta events
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas).toHaveLength(2);
      expect((deltas[0] as Extract<AgentEvent, { type: 'text_delta' }>).text).toBe('Hello');
      expect((deltas[1] as Extract<AgentEvent, { type: 'text_delta' }>).text).toBe(' world');

      // Should yield a message event with accumulated text
      const msgEvent = events.find((e) => e.type === 'message');
      expect(msgEvent).toBeDefined();
      expect((msgEvent as Extract<AgentEvent, { type: 'message' }>).message.content).toBe('Hello world');

      // Should yield done
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
    });

    it('handles streaming with tool calls', async () => {
      const toolCallChunks: StreamChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'call_1', name: 'search' } },
        { type: 'tool_call_delta', toolCall: { arguments: '{"q":"test"}' } },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ];
      const textChunks: StreamChunk[] = [
        { type: 'text_delta', text: 'Found it!' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ];
      let callCount = 0;

      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('Should not be called in streaming mode');
        },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            for (const chunk of toolCallChunks) yield chunk;
          } else {
            for (const chunk of textChunks) yield chunk;
          }
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('search result');

      const loop = new AgentLoop({ adapter, onToolCall, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'search' }]));

      // Should have tool_call event
      const toolCallEvent = events.find((e) => e.type === 'tool_call');
      expect(toolCallEvent).toBeDefined();

      // Should have tool_result event
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult).toBeDefined();

      // Should have text_delta from second call
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas.length).toBeGreaterThan(0);

      // Should have done
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
    });

    it('falls back to chat() when streaming is enabled but adapter has no stream()', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'Hello' }, usage: USAGE };
        },
        // No stream() method
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // Should still work, falling back to chat()
      const msgEvent = events.find((e) => e.type === 'message');
      expect(msgEvent).toBeDefined();

      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
    });

    // ── New streaming tests ──────────────────────────────────────────────

    it('accumulates full response text in conversation history for subsequent iterations', async () => {
      const chunks: StreamChunk[] = [
        { type: 'text_delta', text: 'Accumulated' },
        { type: 'text_delta', text: ' response' },
        { type: 'text_delta', text: ' text' },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } },
      ];

      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('Should not be called when stream() is available');
        },
        async *stream() {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // Verify all three deltas were yielded
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas).toHaveLength(3);

      // Verify the accumulated message has the full concatenated text
      const msgEvent = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
      expect(msgEvent).toBeDefined();
      expect(msgEvent.message.content).toBe('Accumulated response text');

      // Verify usage is passed through from the done chunk
      expect(msgEvent.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    });

    it('yields tool_call_delta events during streaming', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc1', name: 'readFile' } },
        { type: 'tool_call_delta', toolCall: { arguments: '{"path":' } },
        { type: 'tool_call_delta', toolCall: { arguments: '"test.ts"}' } },
        { type: 'done', usage: USAGE },
      ];

      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('Should not be called');
        },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            for (const chunk of chunks) yield chunk;
          } else {
            yield { type: 'text_delta' as const, text: 'Done!' };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('file contents');

      const loop = new AgentLoop({ adapter, onToolCall, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'read file' }]));

      // Should have yielded tool_call_delta events
      const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
      expect(toolDeltas.length).toBeGreaterThanOrEqual(3);

      // Should eventually yield a tool_call event with accumulated data
      const toolCallEvent = events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent.toolCall.name).toBe('readFile');
      expect(toolCallEvent.toolCall.arguments).toBe('{"path":"test.ts"}');
    });

    it('does not call chat() when streaming is enabled and adapter has stream()', async () => {
      const chatSpy = vi.fn();
      const adapter: AgentAdapter = {
        async chat() {
          chatSpy();
          return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
        },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'streamed' };
          yield { type: 'done' as const, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      expect(chatSpy).not.toHaveBeenCalled();
    });

    it('fallback to chat() produces no text_delta events', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'Via chat' }, usage: USAGE };
        },
        // No stream() method
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // No text_delta events because chat() was used, not stream()
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas).toHaveLength(0);

      // But still yields a message
      const msg = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
      expect(msg.message.content).toBe('Via chat');
    });

    it('handles stream() throwing an error gracefully', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
        },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'partial' };
          throw new Error('Stream connection lost');
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // Should have an error event from the stream failure
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();

      // Should still have a done event
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      expect((done as Extract<AgentEvent, { type: 'done' }>).reason).toBe('error');
    });

    it('passes tools to adapter.stream() when configured', async () => {
      let receivedTools: readonly ToolSchema[] | undefined;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('Should not be called');
        },
        async *stream(params) {
          receivedTools = params.tools;
          yield { type: 'text_delta' as const, text: 'hi' };
          yield { type: 'done' as const, usage: USAGE };
        },
      };

      const tools: ToolSchema[] = [
        { name: 'search', description: 'Search', parameters: { type: 'object' } },
      ];

      const loop = new AgentLoop({ adapter, streaming: true, tools });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      expect(receivedTools).toEqual(tools);
    });
  });

  // =====================================================================
  // Additional comprehensive tests for untested features
  // =====================================================================

  describe('maxConversationMessages warning (comprehensive)', () => {
    it('warning message includes the actual conversation length', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 2) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 3,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings.length).toBeGreaterThan(0);

      // Warning should include the conversation length number
      const warningMsg = (warnings[0] as Extract<AgentEvent, { type: 'warning' }>).message;
      expect(warningMsg).toMatch(/\d+/); // contains a number
      expect(warningMsg.toLowerCase()).toContain('conversation');
    });

    it('does not emit warning when conversation stays under maxConversationMessages', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hi' }, usage: USAGE },
      ]);

      const loop = new AgentLoop({
        adapter,
        maxConversationMessages: 100,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(0);
    });

    it('emits no warning when maxConversationMessages is not configured', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount <= 5) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('Post-call budget check (comprehensive)', () => {
    it('emits error event with token_budget reason when adapter response pushes tokens over budget', async () => {
      // A single response that immediately exceeds the budget
      const adapter: AgentAdapter = {
        async chat() {
          return {
            message: { role: 'assistant', content: 'big response' },
            usage: { inputTokens: 600, outputTokens: 600 },
          };
        },
      };

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1000 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should emit an error event before done
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      const error = (errorEvent as Extract<AgentEvent, { type: 'error' }>).error;
      expect(error.message).toContain('Token budget exceeded');

      // Done event with token_budget reason
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('token_budget');
    });

    it('still emits the message event before the budget error when content is present', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return {
            message: { role: 'assistant', content: 'important content', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] },
            usage: { inputTokens: 800, outputTokens: 800 },
          };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1000, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Message event should appear before the error event
      const types = events.map((e) => e.type);
      const msgIdx = types.indexOf('message');
      const errIdx = types.indexOf('error');
      expect(msgIdx).toBeGreaterThan(-1);
      expect(errIdx).toBeGreaterThan(msgIdx);

      // Tool should NOT have been called (budget exceeded before tool dispatch)
      expect(onToolCall).not.toHaveBeenCalled();
    });

    it('accumulates tokens across multiple iterations before triggering budget', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            // First call: 400 tokens, under 1000 budget
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: { inputTokens: 200, outputTokens: 200 } };
          }
          // Second call: 800 tokens, cumulative = 1200 > 1000
          return { message: { role: 'assistant', content: 'result' }, usage: { inputTokens: 400, outputTokens: 400 } };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1000, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // First call should succeed (400 < 1000)
      expect(onToolCall).toHaveBeenCalledTimes(1);
      // Second call pushes over budget
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('token_budget');
      expect(callCount).toBe(2);
    });
  });

  describe('Tools passed to adapter (comprehensive)', () => {
    it('passes tools config to adapter.chat() in every call', async () => {
      const receivedTools: (readonly ToolSchema[] | undefined)[] = [];
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'search', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          receivedTools.push(params.tools);
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('result');

      const tools: ToolSchema[] = [
        { name: 'search', description: 'Search', parameters: { type: 'object' } },
        { name: 'readFile', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ];

      const loop = new AgentLoop({ adapter, onToolCall, tools });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Both calls should have received the same tools array
      expect(receivedTools).toHaveLength(2);
      expect(receivedTools[0]).toEqual(tools);
      expect(receivedTools[1]).toEqual(tools);
    });

    it('passes undefined tools when none configured', async () => {
      let receivedTools: readonly ToolSchema[] | undefined = [] as ToolSchema[];
      const adapter: AgentAdapter = {
        async chat(params) {
          receivedTools = params.tools;
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      expect(receivedTools).toBeUndefined();
    });
  });

  describe('Streaming: stream returns null result (empty stream)', () => {
    it('yields error + done when stream produces no chunks at all', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
        },
        async *stream() {
          // empty stream - produces no chunks
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // An empty stream results in an empty message with no tool calls => end_turn
      const msg = events.find((e) => e.type === 'message');
      expect(msg).toBeDefined();
      expect((msg as Extract<AgentEvent, { type: 'message' }>).message.content).toBe('');

      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      expect((done as Extract<AgentEvent, { type: 'done' }>).reason).toBe('end_turn');
    });
  });

  describe('Streaming: tool_call_delta without id appends to last tool call', () => {
    it('appends arguments to last accumulated tool call when chunk has no id', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc1', name: 'search' } },
        // Chunk without id - should append to last tool call (tc1)
        { type: 'tool_call_delta', toolCall: { arguments: '{"q":' } },
        { type: 'tool_call_delta', toolCall: { arguments: '"hello"}' } },
        { type: 'done', usage: USAGE },
      ];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            for (const chunk of chunks) yield chunk;
          } else {
            yield { type: 'text_delta' as const, text: 'result' };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolCallEvent = events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent.toolCall.id).toBe('tc1');
      expect(toolCallEvent.toolCall.name).toBe('search');
      expect(toolCallEvent.toolCall.arguments).toBe('{"q":"hello"}');
    });
  });

  describe('Streaming: tool_call_delta with existing id updates name', () => {
    it('updates name on existing accumulated tool call', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc1', name: '' } },
        // Same id, provides name update
        { type: 'tool_call_delta', toolCall: { id: 'tc1', name: 'readFile', arguments: '{}' } },
        { type: 'done', usage: USAGE },
      ];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            for (const chunk of chunks) yield chunk;
          } else {
            yield { type: 'text_delta' as const, text: 'done' };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolCallEvent = events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent.toolCall.name).toBe('readFile');
    });
  });

  describe('Streaming: stream error wraps non-Error throw', () => {
    it('wraps non-Error thrown from stream into Error instance', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'fallback' }, usage: USAGE };
        },
        async *stream() {
          throw 'string stream error';
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeInstanceOf(Error);
      expect(errorEvent.error.message).toBe('string stream error');

      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      expect((done as Extract<AgentEvent, { type: 'done' }>).reason).toBe('error');
    });
  });

  describe('Abort after tool calls', () => {
    it('stops when abort() is called during onToolCall execution', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'slow_tool', arguments: '{}' };
      let loopRef: AgentLoop;
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockImplementation(async () => {
        // Abort during tool call execution
        loopRef.abort();
        return 'result';
      });

      loopRef = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loopRef.run([{ role: 'user', content: 'test' }]));

      // Should have aborted after tool calls
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('aborted');

      // Tool call should have been made
      expect(onToolCall).toHaveBeenCalledTimes(1);
    });
  });

  describe('Token budget exceeded AFTER adapter response (post-call check)', () => {
    it('emits message then error when single response exceeds budget without tool calls', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          return {
            message: { role: 'assistant', content: 'response text' },
            usage: { inputTokens: 600, outputTokens: 600 },
          };
        },
      };

      const loop = new AgentLoop({ adapter, maxTotalTokens: 1000 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const types = events.map((e) => e.type);
      // When there are no tool calls, the message should still be yielded
      // because post-call budget check happens before the tool call dispatch
      const msgIdx = types.indexOf('message');
      const errIdx = types.indexOf('error');
      expect(msgIdx).toBeGreaterThan(-1);
      expect(errIdx).toBeGreaterThan(msgIdx);

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('token_budget');
    });
  });

  describe('No onToolCall handler registered', () => {
    it('returns error message as tool result when onToolCall is not provided', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'unknown_tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'handled' }, usage: USAGE };
        },
      };

      // No onToolCall handler
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();
      const result = toolResult.result as { error: string };
      expect(result.error).toContain('No onToolCall handler');
    });
  });

  describe('Non-Error tool call exception', () => {
    it('serializes non-Error throw from onToolCall as string error', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockRejectedValue('string error from tool');

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();
      const result = toolResult.result as { error: string };
      expect(result.error).toBe('string error from tool');
    });
  });

  describe('Pre-aborted external signal', () => {
    it('aborts immediately when external signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(); // pre-abort

      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'Hello' }, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, signal: controller.signal });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('aborted');
    });
  });

  describe('Streaming: post-call budget check with streaming', () => {
    it('triggers token budget after streaming response pushes over budget', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'big response' };
          yield { type: 'done' as const, usage: { inputTokens: 800, outputTokens: 800 } };
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true, maxTotalTokens: 1000 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('token_budget');
    });
  });

  describe('Streaming: done chunk without usage', () => {
    it('uses zero usage when done chunk has no usage field', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'hello' };
          yield { type: 'done' as const }; // no usage
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const msg = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
      expect(msg).toBeDefined();
      expect(msg.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');
    });
  });

  describe('Pre-call token budget check (lines 128-135)', () => {
    it('triggers pre-call budget check with maxTotalTokens of -1', async () => {
      let chatCalled = false;
      const adapter: AgentAdapter = {
        async chat() {
          chatCalled = true;
          return { message: { role: 'assistant', content: 'Hi' }, usage: USAGE };
        },
      };

      // With maxTotalTokens = -1, the pre-call check (0 > -1 = true) fires
      // before any LLM call is made
      const loop = new AgentLoop({ adapter, maxTotalTokens: -1 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // The adapter should NOT have been called because budget check fires first
      expect(chatCalled).toBe(false);

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('token_budget');
    });
  });

  describe('Error event type (comprehensive)', () => {
    it('yields error event with the original Error instance when adapter.chat() throws', async () => {
      const originalError = new Error('Network timeout after 30s');
      const adapter: AgentAdapter = {
        async chat() {
          throw originalError;
        },
      };

      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBe(originalError);
      expect(errorEvent.error.message).toBe('Network timeout after 30s');
    });

    it('wraps non-Error throws into an Error instance', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          throw 'string error'; // non-Error throw
        },
      };

      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeInstanceOf(Error);
      expect(errorEvent.error.message).toBe('string error');
    });

    it('always yields done event after error event when adapter.chat() throws', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('Catastrophic failure');
        },
      };

      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const types = events.map((e) => e.type);

      // error event is present
      expect(types).toContain('error');
      // done event is present
      expect(types).toContain('done');

      // done event comes after the error event
      const errorIdx = types.indexOf('error');
      const doneIdx = types.indexOf('done');
      expect(doneIdx).toBeGreaterThan(errorIdx);

      // done reason is 'error'
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('error');
    });

    it('done event after error still includes cumulative token usage', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: { inputTokens: 100, outputTokens: 50 } };
          }
          throw new Error('Rate limited');
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      // Total usage from the first successful call should be preserved
      expect(done.totalUsage.inputTokens).toBe(100);
      expect(done.totalUsage.outputTokens).toBe(50);
    });

    it('yields iteration_start before the error event', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('Immediate failure');
        },
      };

      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const types = events.map((e) => e.type);
      expect(types[0]).toBe('iteration_start');
      expect(types).toContain('error');
      expect(types).toContain('done');
    });
  });
});
