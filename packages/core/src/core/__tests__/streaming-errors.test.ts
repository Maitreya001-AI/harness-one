import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import { HarnessError, HarnessErrorCode } from '../errors.js';
import type { AgentAdapter, StreamChunk } from '../types.js';
import type { AgentEvent } from '../events.js';

/** Helper: collect all events from an async generator. */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const USAGE = { inputTokens: 10, outputTokens: 5 };

/** Helper: create a mock streaming adapter from an array of chunks. */
function createStreamingAdapter(chunks: StreamChunk[]): AgentAdapter {
  return {
    async chat() {
      throw new Error('chat() should not be called in streaming mode');
    },
    async *stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

/** Helper: create a streaming adapter whose stream throws mid-iteration. */
function createErrorStreamingAdapter(
  chunksBeforeError: StreamChunk[],
  error: Error,
): AgentAdapter {
  return {
    async chat() {
      throw new Error('chat() should not be called in streaming mode');
    },
    async *stream() {
      for (const chunk of chunksBeforeError) {
        yield chunk;
      }
      throw error;
    },
  };
}

describe('AgentLoop streaming error scenarios', () => {
  describe('stream throws error mid-text-delta', () => {
    it('emits error event and returns done with error reason', async () => {
      const adapter = createErrorStreamingAdapter(
        [
          { type: 'text_delta', text: 'Hello ' },
          { type: 'text_delta', text: 'world' },
        ],
        new Error('Network connection lost'),
      );

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const types = events.map((e) => e.type);
      expect(types).toContain('text_delta');
      expect(types).toContain('error');
      expect(types).toContain('done');

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent.error).toBeDefined();
      expect((errorEvent.error as Error).message).toContain('Network connection lost');

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('error');
    });
  });

  describe('stream throws error mid-tool-call-delta', () => {
    it('emits error event when stream fails during tool call deltas', async () => {
      const adapter = createErrorStreamingAdapter(
        [
          { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'search', arguments: '{"q":' } },
        ],
        new Error('Stream interrupted during tool call'),
      );

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'search' }]));

      const types = events.map((e) => e.type);
      expect(types).toContain('tool_call_delta');
      expect(types).toContain('error');
      expect(types).toContain('done');

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect((errorEvent.error as Error).message).toContain('Stream interrupted during tool call');
    });
  });

  describe('stream exceeds maxStreamBytes', () => {
    it('emits error and stops when single iteration stream is too large', async () => {
      const maxBytes = 50;
      // Create text chunks that together exceed the limit
      const bigText = 'x'.repeat(60);
      const adapter = createStreamingAdapter([
        { type: 'text_delta', text: bigText },
        { type: 'done', usage: USAGE },
      ]);

      const loop = new AgentLoop({ adapter, streaming: true, maxStreamBytes: maxBytes });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect((errorEvent.error as Error).message).toContain('Stream exceeded maximum size');
      expect((errorEvent.error as Error).message).toContain(`${maxBytes}`);

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('error');
    });

    it('emits error for tool call arguments that cause stream bytes overflow', async () => {
      const maxBytes = 30;
      const adapter = createStreamingAdapter([
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'search', arguments: 'x'.repeat(40) } },
        { type: 'done', usage: USAGE },
      ]);

      const loop = new AgentLoop({ adapter, streaming: true, maxStreamBytes: maxBytes });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect((errorEvent.error as Error).message).toContain('Stream exceeded maximum size');
    });
  });

  describe('stream exceeds maxStreamBytes in a multi-iteration scenario', () => {
    it('emits per-iteration stream size error in second iteration', async () => {
      // The cumulative check (maxIterations * maxStreamBytes) is defense-in-depth.
      // In practice, the per-iteration maxStreamBytes check fires first because
      // the cumulative limit is always >= the per-iteration limit.
      // This test verifies that if the second iteration produces too much data,
      // the per-iteration check correctly catches it.

      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('should not be called');
        },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            // First iteration: well within the 100-byte limit
            yield { type: 'text_delta' as const, text: 'a'.repeat(50) };
            yield { type: 'tool_call_delta' as const, toolCall: { id: 'tc-1', name: 'tool1', arguments: '{}' } };
            yield { type: 'done' as const, usage: USAGE };
          } else {
            // Second iteration: exceeds the per-iteration limit of 100
            yield { type: 'text_delta' as const, text: 'b'.repeat(110) };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };

      const onToolCall = vi.fn().mockResolvedValue('result');
      const loop = new AgentLoop({
        adapter,
        streaming: true,
        maxStreamBytes: 100,
        maxIterations: 3,
        onToolCall,
      });

      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      // Should have a stream size exceeded error
      const sizeError = errorEvents.find((e) =>
        e.type === 'error' && (e.error as Error).message.includes('Stream exceeded maximum size'),
      );
      expect(sizeError).toBeDefined();

      // The loop should end with 'error' reason
      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('error');
    });

    it('first iteration stream bytes do not affect second iteration per-iteration limit', async () => {
      // Verify that accumulatedBytes resets per iteration (it's a local var in handleStream)
      // So each iteration gets a fresh maxStreamBytes budget.

      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('should not be called');
        },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            // First iteration: use 90 out of 100 bytes
            yield { type: 'text_delta' as const, text: 'a'.repeat(90) };
            yield { type: 'tool_call_delta' as const, toolCall: { id: 'tc-1', name: 'tool1', arguments: '{}' } };
            yield { type: 'done' as const, usage: USAGE };
          } else {
            // Second iteration: 90 bytes again (within its own 100-byte budget)
            yield { type: 'text_delta' as const, text: 'b'.repeat(90) };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };

      const onToolCall = vi.fn().mockResolvedValue('result');
      const loop = new AgentLoop({
        adapter,
        streaming: true,
        maxStreamBytes: 100,
        maxIterations: 3,
        onToolCall,
      });

      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // Both iterations should succeed (no errors about stream size)
      const sizeErrors = events.filter((e) =>
        e.type === 'error' && (e.error as Error).message.includes('Stream exceeded'),
      );
      expect(sizeErrors).toHaveLength(0);

      // Should complete normally
      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('tool call arguments exceed maxToolArgBytes', () => {
    it('emits error when a single tool call arguments field is too large', async () => {
      const maxToolArgBytes = 50;
      const adapter = createStreamingAdapter([
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'bigTool', arguments: 'x'.repeat(30) } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', arguments: 'y'.repeat(30) } },
        { type: 'done', usage: USAGE },
      ]);

      const loop = new AgentLoop({
        adapter,
        streaming: true,
        maxToolArgBytes,
        maxStreamBytes: 10_000, // large enough so stream bytes is not the issue
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect((errorEvent.error as Error).message).toContain('arguments exceeded maximum size');
      expect((errorEvent.error as Error).message).toContain('bigTool');
      // Per-call wire-size limits MUST classify as ADAPTER_PAYLOAD_OVERSIZED
      // so downstream retry/alert heuristics can distinguish them from cumulative budget.
      expect(errorEvent.error).toBeInstanceOf(HarnessError);
      expect((errorEvent.error as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED);

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('error');
    });

    it('emits error for tool call without id appended to last accumulated call', async () => {
      const maxToolArgBytes = 20;
      const adapter = createStreamingAdapter([
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'tool1', arguments: 'a'.repeat(10) } },
        // No id, appends to last (tc-1)
        { type: 'tool_call_delta', toolCall: { arguments: 'b'.repeat(15) } },
        { type: 'done', usage: USAGE },
      ]);

      const loop = new AgentLoop({
        adapter,
        streaming: true,
        maxToolArgBytes,
        maxStreamBytes: 10_000,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const errorEvent = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
      expect(errorEvent).toBeDefined();
      expect((errorEvent.error as Error).message).toContain('arguments exceeded maximum size');
      // NO-ID path must match WITH-ID path — both are ADAPTER_PAYLOAD_OVERSIZED.
      expect(errorEvent.error).toBeInstanceOf(HarnessError);
      expect((errorEvent.error as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED);
    });
  });

  describe('tool call delta without ID and no accumulated calls', () => {
    it('emits warning event', async () => {
      const adapter = createStreamingAdapter([
        // No prior tool call with an ID, and this chunk has no ID either
        { type: 'tool_call_delta', toolCall: { arguments: '{"key":"value"}' } },
        { type: 'done', usage: USAGE },
      ]);

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const warningEvent = events.find((e) => e.type === 'warning') as Extract<AgentEvent, { type: 'warning' }>;
      expect(warningEvent).toBeDefined();
      expect(warningEvent.message).toContain('without ID');
      expect(warningEvent.message).toContain('no accumulated calls');
    });
  });

  describe('stream returns done without usage', () => {
    it('uses zero usage when stream done chunk has no usage field', async () => {
      const adapter = createStreamingAdapter([
        { type: 'text_delta', text: 'Hello' },
        { type: 'done' }, // no usage field
      ]);

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const messageEvent = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.usage.inputTokens).toBe(0);
      expect(messageEvent.usage.outputTokens).toBe(0);

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.totalUsage.inputTokens).toBe(0);
      expect(doneEvent.totalUsage.outputTokens).toBe(0);
    });
  });

  describe('abort signal during stream', () => {
    it('stops when external abort signal fires during streaming', async () => {
      const controller = new AbortController();

      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('should not be called');
        },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'Start ' };
          // Abort after first chunk
          controller.abort();
          yield { type: 'text_delta' as const, text: 'more text' };
          yield { type: 'done' as const, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true, signal: controller.signal });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // After the stream completes (abort is checked after adapter call),
      // the loop should detect the abort and emit aborted
      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('aborted');
    });

    it('stops when loop.abort() is called during streaming', async () => {
      let loopRef: AgentLoop | undefined; // eslint-disable-line prefer-const

      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('should not be called');
        },
        async *stream() {
          yield { type: 'text_delta' as const, text: 'Start' };
          // Abort mid-stream
          loopRef!.abort();
          yield { type: 'text_delta' as const, text: 'End' };
          yield { type: 'done' as const, usage: USAGE };
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      loopRef = loop;
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe('aborted');
    });
  });

  describe('normal streaming completion', () => {
    it('accumulates text deltas into a complete message', async () => {
      const adapter = createStreamingAdapter([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'done', usage: USAGE },
      ]);

      const loop = new AgentLoop({ adapter, streaming: true });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      const messageEvent = events.find((e) => e.type === 'message') as Extract<AgentEvent, { type: 'message' }>;
      expect(messageEvent).toBeDefined();
      expect(messageEvent.message.content).toBe('Hello world');
      expect(messageEvent.message.role).toBe('assistant');

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('end_turn');
    });

    it('accumulates tool call deltas into tool calls', async () => {
      let callCount = 0;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('should not be called');
        },
        async *stream() {
          callCount++;
          if (callCount === 1) {
            yield { type: 'tool_call_delta' as const, toolCall: { id: 'tc-1', name: 'search', arguments: '{"q":' } };
            yield { type: 'tool_call_delta' as const, toolCall: { id: 'tc-1', arguments: '"test"}' } };
            yield { type: 'done' as const, usage: USAGE };
          } else {
            yield { type: 'text_delta' as const, text: 'Found it' };
            yield { type: 'done' as const, usage: USAGE };
          }
        },
      };

      const onToolCall = vi.fn().mockResolvedValue('search result');
      const loop = new AgentLoop({ adapter, streaming: true, onToolCall });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'search' }]));

      const toolCallEvent = events.find((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>;
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent.toolCall.name).toBe('search');
      expect(toolCallEvent.toolCall.arguments).toBe('{"q":"test"}');

      expect(onToolCall).toHaveBeenCalled();

      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('end_turn');
    });
  });

  describe('config validation for streaming limits', () => {
    it('throws when maxStreamBytes is <= 0', () => {
      expect(() => new AgentLoop({
        adapter: createStreamingAdapter([]),
        maxStreamBytes: 0,
      })).toThrow('maxStreamBytes must be > 0');
    });

    it('throws when maxToolArgBytes is <= 0', () => {
      expect(() => new AgentLoop({
        adapter: createStreamingAdapter([]),
        maxToolArgBytes: -1,
      })).toThrow('maxToolArgBytes must be > 0');
    });
  });

  // Regression guard:
  //
  // Consumer-initiated `.return()` on the run() generator must forward
  // iterator-close through AdapterCaller's manual pump into
  // StreamHandler's `for await`, which in turn closes the underlying
  // `adapter.stream()` generator. Without the `try/finally` around
  // AdapterCaller's pump this chain breaks and the adapter generator
  // leaks until the abort signal fires (which the test adapter ignores).
  describe('adapter stream cleanup on consumer .return()', () => {
    it('closes adapter stream when consumer breaks mid-chunk', async () => {
      let streamReturnCalled = false;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('chat() should not be called in streaming mode');
        },
        async *stream() {
          try {
            yield { type: 'text_delta' as const, text: 'a' };
            // Suspend forever to simulate a slow adapter that does not
            // cooperate with `config.signal`. Only JS iterator-close
            // can surface the finally block here.
            await new Promise(() => {
              /* never resolves */
            });
            yield { type: 'done' as const, usage: USAGE };
          } finally {
            streamReturnCalled = true;
          }
        },
      };

      const loop = new AgentLoop({ adapter, streaming: true });
      const it = loop.run([{ role: 'user', content: 'hi' }]);

      // Advance: iteration_start, then the first text_delta chunk.
      const first = await it.next();
      expect(first.done).toBe(false);
      expect((first.value as AgentEvent).type).toBe('iteration_start');
      const second = await it.next();
      expect(second.done).toBe(false);
      expect((second.value as AgentEvent).type).toBe('text_delta');

      // Consumer bails mid-stream. Iterator-close must propagate all the
      // way down to the adapter generator's finally block.
      await it.return(undefined);

      // Yield once to let any scheduled microtasks flush.
      await Promise.resolve();

      expect(streamReturnCalled).toBe(true);
    });
  });

  // After the StreamHandler / AdapterCaller split, failures on the stream
  // path have TWO candidate yield sites — StreamHandler yields the event
  // inside `handle()`, and agent-loop's post-`call()` bail could yield
  // again. The contract is: the consumer must see EXACTLY ONE
  // `{type:'error'}` event per failed stream regardless of retries. A
  // double-emit here would be a silent regression (consumers typically
  // only assert the presence of an error, not the count).
  describe('stream error yield-order asymmetry', () => {
    it('emits exactly ONE {type:\"error\"} event per failed stream across all retries', async () => {
      // Streaming adapter that always fails with a retryable category.
      // `HTTP 429` routes through categorizeAdapterError to ADAPTER_RATE_LIMIT
      // (the default retryable category), so maxAdapterRetries=2 means
      // the loop sees 3 stream attempts total, all failing.
      let attempts = 0;
      const adapter: AgentAdapter = {
        async chat() {
          throw new Error('should not be called in streaming mode');
        },
        async *stream() {
          attempts++;
          // Message must contain a token the classifier maps to
          // ADAPTER_RATE_LIMIT so the retry path is actually exercised.
          const err: Error & { status?: number } = new Error(`rate limited: attempt #${attempts}`);
          err.status = 429;
          throw err;
        },
      };

      const loop = new AgentLoop({
        adapter,
        streaming: true,
        maxAdapterRetries: 2,
        // Near-zero backoff keeps the test fast; default retryableErrors
        // already includes ADAPTER_RATE_LIMIT.
        baseRetryDelayMs: 1,
      });
      const events = await collectEvents(loop.run([{ role: 'user', content: 'Hi' }]));

      // Retries actually exercised: more than one attempt hit the adapter.
      expect(attempts).toBeGreaterThan(1);

      // The core invariant: one and only one error event regardless of retries.
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);

      // And the done event reports the error terminus.
      const doneEvent = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
      expect(doneEvent.reason).toBe('error');
    });
  });
});
