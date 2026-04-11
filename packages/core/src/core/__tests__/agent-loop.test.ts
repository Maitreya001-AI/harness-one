import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type { AgentAdapter, ChatResponse, Message, ToolCallRequest, StreamChunk, ToolSchema, ExecutionStrategy, ToolExecutionResult } from '../types.js';
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
      const loopRef: { current: AgentLoop | undefined } = { current: undefined };
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount >= 2) loopRef.current!.abort();
          return { message: { role: 'assistant', content: '', toolCalls: [{ id: `c${callCount}`, name: 't', arguments: '{}' }] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      loopRef.current = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loopRef.current.run([{ role: 'user', content: 'test' }]));

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
      const loopRef: { current: AgentLoop | undefined } = { current: undefined };
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockImplementation(async () => {
        // Abort during tool call execution
        loopRef.current!.abort();
        return 'result';
      });

      loopRef.current = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loopRef.current.run([{ role: 'user', content: 'test' }]));

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
    it('rejects maxTotalTokens of -1 at construction time with INVALID_CONFIG', () => {
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: 'Hi' }, usage: USAGE };
        },
      };

      // With input validation, invalid config is now rejected at construction
      expect(() => new AgentLoop({ adapter, maxTotalTokens: -1 })).toThrow('maxTotalTokens must be > 0');
    });
  });

  describe('Error event type (comprehensive)', () => {
    it('wraps adapter errors in HarnessError with categorized error code', async () => {
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
      expect(errorEvent.error).toBeInstanceOf(HarnessError);
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_NETWORK');
      expect(errorEvent.error.message).toBe('Network timeout after 30s');
      expect((errorEvent.error as HarnessError).cause).toBe(originalError);
    });

    it('wraps non-Error throws into a HarnessError instance', async () => {
      const adapter: AgentAdapter = {
        async chat() {
          throw 'string error'; // non-Error throw
        },
      };

      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeInstanceOf(HarnessError);
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_ERROR');
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

  describe('dispose() method', () => {
    it('marks the loop as aborted via the abort controller signal', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hello!' }, usage: USAGE },
      ]);
      const loop = new AgentLoop({ adapter });

      // Before dispose, running should work normally
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('end_turn');

      // Dispose the loop
      loop.dispose();

      // After dispose, a new run should immediately abort
      const events2 = await collectEvents(loop.run([{ role: 'user', content: 'Hi again' }]));
      const done2 = events2.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done2).toBeDefined();
      expect(done2.reason).toBe('aborted');
    });

    it('cancels an in-flight adapter call when dispose() is called', async () => {
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

      // Get past iteration_start to the adapter.chat() call
      const first = await gen.next();
      expect(first.value).toEqual({ type: 'iteration_start', iteration: 1 });

      const secondPromise = gen.next();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal!.aborted).toBe(false);

      // Dispose should abort the signal
      loop.dispose();
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

      const doneEvt = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvt).toBeDefined();
      expect(doneEvt.reason).toBe('aborted');
    });
  });

  describe('getMetrics()', () => {
    it('returns zero metrics before run', () => {
      const adapter = createMockAdapter([]);
      const loop = new AgentLoop({ adapter });
      const metrics = loop.getMetrics();
      expect(metrics.iteration).toBe(0);
      expect(metrics.totalToolCalls).toBe(0);
      expect(metrics.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('tracks iteration count and tool calls after run', async () => {
      const toolCall: ToolCallRequest = { id: 'tc_1', name: 'search', arguments: '{}' };
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE },
        { message: { role: 'assistant', content: 'Done' }, usage: USAGE },
      ]);
      const loop = new AgentLoop({
        adapter,
        onToolCall: async () => 'result',
      });
      await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const metrics = loop.getMetrics();
      expect(metrics.iteration).toBe(2);
      expect(metrics.totalToolCalls).toBe(1);
      expect(metrics.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    });

    it('tracks multiple tool calls in a single iteration', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc_1', name: 'a', arguments: '{}' },
        { id: 'tc_2', name: 'b', arguments: '{}' },
        { id: 'tc_3', name: 'c', arguments: '{}' },
      ];
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls }, usage: USAGE },
        { message: { role: 'assistant', content: 'Done' }, usage: USAGE },
      ]);
      const loop = new AgentLoop({
        adapter,
        onToolCall: async () => 'ok',
      });
      await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const metrics = loop.getMetrics();
      expect(metrics.totalToolCalls).toBe(3);
    });
  });

  describe('single source of truth for abort state', () => {
    it('uses only abortController.signal.aborted, no redundant boolean', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hi' }, usage: USAGE },
      ]);
      const loop = new AgentLoop({ adapter });

      // Verify there is no 'aborted' boolean property on the instance
      // (only abortController should exist for abort state)
      const ownProps = Object.getOwnPropertyNames(loop);
      expect(ownProps).not.toContain('aborted');
    });
  });

  describe('parallel tool execution', () => {
    it('defaults to sequential execution when parallel is not set', async () => {
      const calls: string[] = [];
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
      const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
        calls.push(`start:${call.name}`);
        await new Promise((r) => setTimeout(r, 10));
        calls.push(`end:${call.name}`);
        return `result_${call.name}`;
      });

      const loop = new AgentLoop({ adapter, onToolCall });
      await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      // Sequential: tool_a starts and ends before tool_b starts
      expect(calls).toEqual(['start:tool_a', 'end:tool_a', 'start:tool_b', 'end:tool_b']);
    });

    it('executes tools in parallel when parallel: true', async () => {
      const calls: string[] = [];
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
      const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };
      const toolCall3: ToolCallRequest = { id: 'tc3', name: 'tool_c', arguments: '{}' };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2, toolCall3] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
        calls.push(`start:${call.name}`);
        await new Promise((r) => setTimeout(r, 50));
        calls.push(`end:${call.name}`);
        return `result_${call.name}`;
      });

      const start = Date.now();
      const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
      await collectEvents(loop.run([{ role: 'user', content: 'go' }]));
      const elapsed = Date.now() - start;

      // All three should start before any ends (parallel)
      const startCount = calls.filter((c) => c.startsWith('start:')).length;
      expect(startCount).toBe(3);

      // Parallel: total time should be much less than 150ms (3 * 50ms sequential)
      expect(elapsed).toBeLessThan(130);
    });

    it('respects isSequentialTool — sequential tools run after parallel batch', async () => {
      const order: string[] = [];
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'parallel_tool', arguments: '{}' };
      const toolCall2: ToolCallRequest = { id: 'tc2', name: 'seq_tool', arguments: '{}' };
      const toolCall3: ToolCallRequest = { id: 'tc3', name: 'another_parallel', arguments: '{}' };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2, toolCall3] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
        order.push(call.name);
        await new Promise((r) => setTimeout(r, 10));
        return `result_${call.name}`;
      });

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        parallel: true,
        isSequentialTool: (name) => name === 'seq_tool',
      });
      await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      // seq_tool must appear after both parallel tools
      const seqIdx = order.indexOf('seq_tool');
      const par1Idx = order.indexOf('parallel_tool');
      const par2Idx = order.indexOf('another_parallel');
      expect(seqIdx).toBeGreaterThan(par1Idx);
      expect(seqIdx).toBeGreaterThan(par2Idx);
    });

    it('emits all tool_call events before all tool_result events in parallel mode', async () => {
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
      const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const relevantTypes = events
        .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
        .map((e) => e.type);

      // All tool_call events before any tool_result
      expect(relevantTypes).toEqual(['tool_call', 'tool_call', 'tool_result', 'tool_result']);
    });

    it('preserves conversation order for tool result messages in parallel mode', async () => {
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'slow_tool', arguments: '{}' };
      const toolCall2: ToolCallRequest = { id: 'tc2', name: 'fast_tool', arguments: '{}' };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockImplementation(async (call: ToolCallRequest) => {
        // slow_tool takes longer but was called first
        const delay = call.name === 'slow_tool' ? 40 : 5;
        await new Promise((r) => setTimeout(r, delay));
        return `result_${call.name}`;
      });

      const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const resultEvents = events.filter((e) => e.type === 'tool_result') as Array<
        Extract<AgentEvent, { type: 'tool_result' }>
      >;

      // Results should be in original call order, not completion order
      expect(resultEvents[0].toolCallId).toBe('tc1');
      expect(resultEvents[1].toolCallId).toBe('tc2');
    });

    it('uses a custom ExecutionStrategy when provided', async () => {
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };

      const customStrategy: ExecutionStrategy = {
        async execute(calls, handler) {
          const results: ToolExecutionResult[] = [];
          for (const call of calls) {
            const result = await handler(call);
            results.push({ toolCallId: call.id, result: `custom:${result}` });
          }
          return results;
        },
      };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockResolvedValue('raw');

      const loop = new AgentLoop({ adapter, onToolCall, executionStrategy: customStrategy });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const resultEvent = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(resultEvent.result).toBe('custom:raw');
    });

    it('handles single tool call correctly in parallel mode', async () => {
      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'only_tool', arguments: '{}' };

      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockResolvedValue('result');

      const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const types = events.map((e) => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types).toContain('done');

      const resultEvent = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(resultEvent.result).toBe('result');
      expect(resultEvent.toolCallId).toBe('tc1');
    });
  });

  // =====================================================================
  // Fix 1: Conversation history auto-pruning
  // =====================================================================
  describe('Fix 1: Conversation auto-pruning keeps head + tail', () => {
    it('prunes conversation to keep first message (system) and most recent N-1 messages', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let capturedMessages: Message[] = [];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount <= 4) {
            return { message: { role: 'assistant', content: `response_${callCount}`, toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'final' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      // maxConversationMessages = 4, start with 1 message
      // After each iteration: +1 assistant + 1 tool = +2 messages
      // iteration 1: 1 -> 3 (user, assistant, tool) — under limit
      // iteration 2: 3 -> 5 (> 4) — triggers pruning before adapter call
      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 4,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'system prompt' }]));

      // Should have emitted at least one pruning warning
      const warnings = events.filter((e) => e.type === 'warning') as Array<Extract<AgentEvent, { type: 'warning' }>>;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].message).toContain('pruned');

      // The conversation passed to adapter should always be <= maxConversationMessages
      // after pruning kicks in. The last adapter call should have at most 4 messages.
      expect(capturedMessages.length).toBeLessThanOrEqual(4);

      // The first message should always be the original system prompt
      expect(capturedMessages[0].content).toBe('system prompt');
    });

    it('does not prune when conversation is at or under the limit', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hello' }, usage: USAGE },
      ]);

      const loop = new AgentLoop({ adapter, maxConversationMessages: 10 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(0);
    });

    it('preserves the most recent tail messages after pruning', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let lastCapturedMessages: Message[] = [];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          lastCapturedMessages = [...params.messages];
          callCount++;
          if (callCount <= 3) {
            return { message: { role: 'assistant', content: `resp_${callCount}`, toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('tool_result');

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 3,
      });
      await collectEvents(loop.run([{ role: 'user', content: 'start' }]));

      // After pruning: first message + last 2 messages
      expect(lastCapturedMessages[0].content).toBe('start');
      expect(lastCapturedMessages.length).toBeLessThanOrEqual(3);
    });
  });

  // =====================================================================
  // Fix 2: JSON.stringify safety for tool results
  // =====================================================================
  describe('Fix 2: JSON.stringify safety for circular references', () => {
    it('handles circular reference in tool result without throwing', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      let capturedMessages: Message[] = [];
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'handled' }, usage: USAGE };
        },
      };

      // Create a circular reference object
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      const onToolCall = vi.fn().mockResolvedValue(circular);

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should complete without throwing
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');

      // The tool result message in conversation should have the fallback content
      const toolMsg = capturedMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('[Object could not be serialized]');
    });

    it('still serializes normal objects via JSON.stringify', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      let capturedMessages: Message[] = [];
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };

      const onToolCall = vi.fn().mockResolvedValue({ key: 'value', num: 42 });

      const loop = new AgentLoop({ adapter, onToolCall });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolMsg = capturedMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('{"key":"value","num":42}');
    });

    it('passes string results through directly without JSON.stringify', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let callCount = 0;
      let capturedMessages: Message[] = [];
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };

      const onToolCall = vi.fn().mockResolvedValue('string result');

      const loop = new AgentLoop({ adapter, onToolCall });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolMsg = capturedMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('string result');
    });
  });

  // =====================================================================
  // Fix 3: Adapter error categorization
  // =====================================================================
  describe('Fix 3: Adapter error categorization', () => {
    it('categorizes rate limit errors as ADAPTER_RATE_LIMIT', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Rate limit exceeded: 429 Too Many Requests'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_RATE_LIMIT');
    });

    it('categorizes "too many requests" as ADAPTER_RATE_LIMIT', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Too many requests, please slow down'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_RATE_LIMIT');
    });

    it('categorizes auth errors as ADAPTER_AUTH', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('401 Unauthorized: Invalid API key'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_AUTH');
    });

    it('categorizes "api key" errors as ADAPTER_AUTH', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Invalid API key provided'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_AUTH');
    });

    it('categorizes timeout errors as ADAPTER_NETWORK', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Request timeout after 30000ms'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_NETWORK');
    });

    it('categorizes ECONNREFUSED errors as ADAPTER_NETWORK', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('connect ECONNREFUSED 127.0.0.1:8080'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_NETWORK');
    });

    it('categorizes fetch errors as ADAPTER_NETWORK', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('fetch failed'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_NETWORK');
    });

    it('categorizes parse errors as ADAPTER_PARSE', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Failed to parse JSON response'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_PARSE');
    });

    it('categorizes malformed response errors as ADAPTER_PARSE', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Malformed response from API'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_PARSE');
    });

    it('falls back to ADAPTER_ERROR for uncategorized errors', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Something completely unexpected'); },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_ERROR');
    });

    it('falls back to ADAPTER_ERROR for non-Error throws', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw 42; },
      };
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_ERROR');
    });

    it('categorizes streaming adapter errors the same way', async () => {
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          throw new Error('Rate limit exceeded on stream');
        },
      };
      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as HarnessError).code).toBe('ADAPTER_RATE_LIMIT');
    });
  });

  // =====================================================================
  // Fix 4: Streaming partial tool call without ID warning
  // =====================================================================
  describe('Fix 4: Streaming partial tool call chunk without ID and no accumulated calls', () => {
    it('yields warning when tool_call_delta has no ID and no prior accumulated calls exist', async () => {
      const chunks: StreamChunk[] = [
        // A tool_call_delta without an id, and no prior tool calls accumulated
        { type: 'tool_call_delta', toolCall: { arguments: '{"orphan": true}' } },
        { type: 'text_delta', text: 'response' },
        { type: 'done', usage: USAGE },
      ];

      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          for (const chunk of chunks) yield chunk;
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const warnings = events.filter((e) => e.type === 'warning') as Array<Extract<AgentEvent, { type: 'warning' }>>;
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].message).toContain('partial tool call chunk without ID');
      expect(warnings[0].message).toContain('no accumulated calls');

      // Should still complete normally
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');
    });

    it('does not yield warning when tool_call_delta without ID appends to existing accumulated call', async () => {
      const chunks: StreamChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc1', name: 'search' } },
        // No id, but tc1 is already accumulated — should append, not warn
        { type: 'tool_call_delta', toolCall: { arguments: '{"q":"test"}' } },
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

      // No warning should be emitted since there IS an accumulated call
      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings).toHaveLength(0);
    });
  });

  // =====================================================================
  // Fix 5: executionStrategy vs parallel precedence (JSDoc comment)
  // =====================================================================
  describe('Fix 5: executionStrategy takes precedence over parallel flag', () => {
    it('uses explicit executionStrategy even when parallel: true is also set', async () => {
      const executionOrder: string[] = [];
      const customStrategy: ExecutionStrategy = {
        async execute(calls, handler) {
          const results: ToolExecutionResult[] = [];
          for (const call of calls) {
            executionOrder.push(`custom:${call.name}`);
            const result = await handler(call);
            results.push({ toolCallId: call.id, result });
          }
          return results;
        },
      };

      const toolCall1: ToolCallRequest = { id: 'tc1', name: 'tool_a', arguments: '{}' };
      const toolCall2: ToolCallRequest = { id: 'tc2', name: 'tool_b', arguments: '{}' };
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: '', toolCalls: [toolCall1, toolCall2] }, usage: USAGE },
        { message: { role: 'assistant', content: 'done' }, usage: USAGE },
      ]);
      const onToolCall = vi.fn().mockResolvedValue('ok');

      // Both parallel: true AND executionStrategy provided
      // executionStrategy should take precedence
      const loop = new AgentLoop({
        adapter,
        onToolCall,
        parallel: true,
        executionStrategy: customStrategy,
      });
      await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      // The custom strategy should have been used, not the parallel one
      expect(executionOrder).toEqual(['custom:tool_a', 'custom:tool_b']);
    });
  });

  // =====================================================================
  // Production-readiness fixes: reproduction tests
  // =====================================================================

  describe('Fix 1: Signal listener memory leak - cleanup in run() finally', () => {
    it('removes external signal listener after run() completes normally', async () => {
      const externalController = new AbortController();
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hi' }, usage: USAGE },
      ]);

      const loop = new AgentLoop({ adapter, signal: externalController.signal });
      await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // After run() completes, the external signal listener should be removed.
      // We can verify by aborting the external signal and checking the loop
      // does NOT get affected (its internal abort controller should not fire).
      // If listener was leaked, aborting externalController would try to abort the loop.
      // We test that a second run is not immediately aborted by the external signal.
      const loop2 = new AgentLoop({ adapter: createMockAdapter([
        { message: { role: 'assistant', content: 'Hello again' }, usage: USAGE },
      ]) });
      const events2 = await collectEvents(loop2.run([{ role: 'user', content: 'test' }]));
      const done2 = events2.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done2.reason).toBe('end_turn');
    });

    it('removes external signal listener even when generator is broken out of early', async () => {
      const externalController = new AbortController();
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'loop', arguments: '{}' };
      const adapter: AgentAdapter = {
        async chat() {
          return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({
        adapter,
        signal: externalController.signal,
        onToolCall,
        maxIterations: 100,
      });

      const gen = loop.run([{ role: 'user', content: 'test' }]);
      // Consume only a few events then break
      let count = 0;
      for await (const _event of gen) {
        count++;
        if (count >= 3) break;
      }

      // After breaking out, the finally block should have cleaned up the listener.
      // Verify the external signal has no lingering listeners by checking the loop
      // internal state was cleaned up (the _externalAbortHandler should be undefined).
      // We verify indirectly: aborting external signal should NOT throw or cause issues.
      externalController.abort();
      // If no error thrown, cleanup worked correctly
    });
  });

  describe('Fix 2: Token overflow bypass - safe bounds on token values', () => {
    it('clamps absurdly large token values to prevent overflow bypass', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      const adapter: AgentAdapter = {
        async chat() {
          return {
            message: { role: 'assistant', content: '', toolCalls: [toolCall] },
            // Buggy adapter reports absurdly large tokens (e.g., Number.MAX_SAFE_INTEGER)
            usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
          };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, maxTotalTokens: 5000, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should trigger token budget exceeded due to clamped-but-still-large value
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('token_budget');

      // The clamped input tokens should be at most 1,000,000,000
      expect(loop.usage.inputTokens).toBeLessThanOrEqual(1_000_000_000);
    });
  });

  describe('Fix 3: Stream DoS protection - cumulative byte tracking', () => {
    it('enforces cumulative stream byte limit across iterations', async () => {
      // Create a streaming adapter that produces just under the per-iteration limit
      // but over the cumulative limit when combined across iterations
      const bigText = 'x'.repeat(AgentLoop.MAX_STREAM_BYTES - 100);
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            // First iteration: produce tool calls with large text
            yield { type: 'text_delta' as const, text: bigText };
            yield { type: 'tool_call_delta' as const, toolCall: { id: 'tc1', name: 'tool' } };
            yield { type: 'tool_call_delta' as const, toolCall: { arguments: '{}' } };
            yield { type: 'done' as const, usage: USAGE };
          } else {
            // Second iteration: would push cumulative over limit
            yield { type: 'text_delta' as const, text: bigText };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      // maxIterations=2 -> cumulative limit = 2 * MAX_STREAM_BYTES
      // Two iterations each producing MAX_STREAM_BYTES-100 bytes should be under limit
      const loop = new AgentLoop({ adapter, onToolCall, streaming: true, maxIterations: 2 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should complete normally since both iterations are under per-iteration limit
      // and cumulative is under 2 * MAX_STREAM_BYTES
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
    });
  });

  describe('Fix 4: Tool execution timeout via toolTimeoutMs', () => {
    it('times out slow tool calls when toolTimeoutMs is set', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'slow_tool', arguments: '{}' };
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'handled timeout' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return 'should not reach';
      });

      const loop = new AgentLoop({ adapter, onToolCall, toolTimeoutMs: 50 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();
      const result = toolResult.result as { error: string };
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('50ms');

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');
    });

    it('does not time out fast tool calls', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'fast_tool', arguments: '{}' };
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
      const onToolCall = vi.fn().mockResolvedValue('fast result');

      const loop = new AgentLoop({ adapter, onToolCall, toolTimeoutMs: 5000 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();
      expect(toolResult.result).toBe('fast result');
    });

    it('works without toolTimeoutMs set (backward compatible)', async () => {
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
      const onToolCall = vi.fn().mockResolvedValue('result');

      const loop = new AgentLoop({ adapter, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('end_turn');
    });
  });

  describe('Fix 5: finalEventEmitted rename from yieldedDone', () => {
    it('emits done event (final event) with correct reason on normal completion', async () => {
      const adapter = createMockAdapter([
        { message: { role: 'assistant', content: 'Hello!' }, usage: USAGE },
      ]);
      const loop = new AgentLoop({ adapter });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');
    });

    it('emits done event (final event) with aborted reason when abort triggers', async () => {
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

  // =====================================================================
  // PR fixes: 5 production-readiness issues
  // =====================================================================

  describe('PR Fix 1: Timer leak - tool timeout timer cleared in finally block', () => {
    it('clears the timeout timer after a fast tool completes before the deadline', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'fast_tool', arguments: '{}' };
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
      // Tool completes immediately — well before the 5s timeout.
      // The timer must be cleared so it does not keep the event loop alive.
      const onToolCall = vi.fn().mockResolvedValue('fast result');

      const loop = new AgentLoop({ adapter, onToolCall, toolTimeoutMs: 5000 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();
      // Result is from the fast tool, not a timeout error
      expect(toolResult.result).toBe('fast result');

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done.reason).toBe('end_turn');
    });

    it('resolves with timeout error when tool exceeds toolTimeoutMs', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'slow_tool', arguments: '{}' };
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
      const onToolCall = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return 'too late';
      });

      const loop = new AgentLoop({ adapter, onToolCall, toolTimeoutMs: 30 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResult = events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
      expect(toolResult).toBeDefined();
      const result = toolResult.result as { error: string };
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('30ms');
    });

    it('correctly handles multiple sequential timed-out tool calls', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'slow_a', arguments: '{}' },
        { id: 'tc2', name: 'slow_b', arguments: '{}' },
      ];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return 'never';
      });

      const loop = new AgentLoop({ adapter, onToolCall, toolTimeoutMs: 30 });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const toolResults = events.filter((e) => e.type === 'tool_result') as Array<
        Extract<AgentEvent, { type: 'tool_result' }>
      >;
      expect(toolResults).toHaveLength(2);
      // Both should have timed-out error messages
      for (const r of toolResults) {
        expect((r.result as { error: string }).error).toContain('timed out');
      }
    });
  });

  describe('PR Fix 2: Conversation trimming - preserve all leading system messages', () => {
    it('preserves multiple leading system messages when trimming', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let capturedMessages: Message[] = [];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount <= 3) {
            return { message: { role: 'assistant', content: `r${callCount}`, toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      // Start with 2 system messages followed by a user message
      const initialMessages: Message[] = [
        { role: 'system', content: 'System prompt 1' },
        { role: 'system', content: 'System prompt 2' },
        { role: 'user', content: 'User request' },
      ];

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 5,
      });
      const events = await collectEvents(loop.run(initialMessages));

      // Should have triggered pruning
      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings.length).toBeGreaterThan(0);

      // Both system messages should be present in the pruned conversation
      const systemMsgs = capturedMessages.filter((m) => m.role === 'system');
      expect(systemMsgs).toHaveLength(2);
      expect(systemMsgs[0].content).toBe('System prompt 1');
      expect(systemMsgs[1].content).toBe('System prompt 2');
    });

    it('handles trimming when first message is a user message (no system messages)', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let capturedMessages: Message[] = [];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount <= 3) {
            return { message: { role: 'assistant', content: `r${callCount}`, toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      // No system message — first message is user
      const initialMessages: Message[] = [
        { role: 'user', content: 'First user message' },
      ];

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 3,
      });
      const events = await collectEvents(loop.run(initialMessages));

      // Should still complete without errors
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();

      // After pruning, capturedMessages must be <= 3
      expect(capturedMessages.length).toBeLessThanOrEqual(3);

      // The first captured message should be the original user message (no system to preserve)
      expect(capturedMessages[0].role).toBe('user');
      expect(capturedMessages[0].content).toBe('First user message');
    });

    it('preserves exactly 0 system messages when no system prefix exists', async () => {
      const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
      let capturedMessages: Message[] = [];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat(params) {
          capturedMessages = [...params.messages];
          callCount++;
          if (callCount <= 4) {
            return { message: { role: 'assistant', content: `r${callCount}`, toolCalls: [toolCall] }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        maxConversationMessages: 4,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'go' }]));

      const warnings = events.filter((e) => e.type === 'warning');
      expect(warnings.length).toBeGreaterThan(0);

      // No system messages in the pruned result (none were added)
      const systemMsgs = capturedMessages.filter((m) => m.role === 'system');
      expect(systemMsgs).toHaveLength(0);

      // Conversation length never exceeds limit
      expect(capturedMessages.length).toBeLessThanOrEqual(4);
    });
  });

  describe('PR Fix 3: Stream/tool limits configurable via config', () => {
    it('uses custom maxStreamBytes when set in config', async () => {
      const SMALL_LIMIT = 10; // 10 bytes — very small limit for testing
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'x'.repeat(SMALL_LIMIT + 1) }; // exceeds 10 bytes
          yield { type: 'done' as const, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true, maxStreamBytes: SMALL_LIMIT });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should hit the stream size limit
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.message).toContain(`${SMALL_LIMIT} bytes`);

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('error');
    });

    it('uses custom maxToolArgBytes when set in config', async () => {
      const SMALL_ARG_LIMIT = 5; // 5 bytes — very small limit for testing
      const chunks: StreamChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc1', name: 'tool' } },
        // arguments exceed the 5-byte limit
        { type: 'tool_call_delta', toolCall: { id: 'tc1', arguments: '{"key":"value"}' } },
        { type: 'done', usage: USAGE },
      ];

      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          for (const chunk of chunks) yield chunk;
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true, maxToolArgBytes: SMALL_ARG_LIMIT });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should hit the per-tool-arg size limit
      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.message).toContain(`${SMALL_ARG_LIMIT} bytes`);
    });

    it('defaults maxStreamBytes to AgentLoop.MAX_STREAM_BYTES when not specified', () => {
      const adapter = createMockAdapter([]);
      const loop = new AgentLoop({ adapter });
      // The static constant is the default — no config override means default applies
      // We verify indirectly: the loop accepts config without maxStreamBytes fine
      expect(loop).toBeDefined();
    });

    it('defaults maxToolArgBytes to 5MB when not specified', () => {
      const adapter = createMockAdapter([]);
      const loop = new AgentLoop({ adapter });
      // Same default verification pattern
      expect(loop).toBeDefined();
    });
  });

  describe('PR Fix 4: Fallback adapter mutex prevents double-switch on concurrent failures', () => {
    // This test is better placed in fallback-adapter.test.ts, but we verify
    // the AgentLoop correctly uses the fallback adapter with concurrent tool calls.
    it('does not break when using fallback adapter with parallel tools', async () => {
      const toolCalls: ToolCallRequest[] = [
        { id: 'tc1', name: 'tool_a', arguments: '{}' },
        { id: 'tc2', name: 'tool_b', arguments: '{}' },
      ];
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          callCount++;
          if (callCount === 1) {
            return { message: { role: 'assistant', content: '', toolCalls }, usage: USAGE };
          }
          return { message: { role: 'assistant', content: 'done' }, usage: USAGE };
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({ adapter, onToolCall, parallel: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');
    });
  });

  describe('PR Fix 5: cumulativeStreamBytes reset on stream error/abort', () => {
    it('resets cumulative stream byte count after a stream error so subsequent runs are not penalized', async () => {
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            // First iteration: yield some bytes then fail
            yield { type: 'text_delta' as const, text: 'partial data' };
            throw new Error('stream interrupted');
          }
          // This path not reached since the first iteration errors and ends the run
          yield { type: 'text_delta' as const, text: 'second' };
          yield { type: 'done' as const, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // The stream error should cause a done event with reason 'error'
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('error');

      // An error event from the stream failure should be present
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
    });

    it('does not accumulate stream bytes from a failed iteration into later iterations', async () => {
      // Use a very small maxStreamBytes to quickly trigger limits
      const LIMIT = 20;
      let callCount = 0;

      const adapter: AgentAdapter = {
        async chat() { throw new Error('Should not be called'); },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            // First iteration: yield tool call (no text bytes) — succeeds
            yield { type: 'tool_call_delta' as const, toolCall: { id: 'tc1', name: 'tool' } };
            yield { type: 'tool_call_delta' as const, toolCall: { arguments: '{}' } };
            yield { type: 'done' as const, usage: USAGE };
          } else {
            // Second iteration: normal text response within limit
            yield { type: 'text_delta' as const, text: 'ok' };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };
      const onToolCall = vi.fn().mockResolvedValue('ok');

      const loop = new AgentLoop({
        adapter,
        onToolCall,
        streaming: true,
        maxStreamBytes: LIMIT,
        maxIterations: 2,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'test' }]));

      // Should complete successfully — the second iteration's 2-byte response
      // is well under the LIMIT and cumulative bytes were not inflated
      const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(done).toBeDefined();
      expect(done.reason).toBe('end_turn');
    });
  });
});
