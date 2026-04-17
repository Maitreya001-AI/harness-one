/**
 * Tests for `createOpenAIAdapter().stream()` — split out of the monolith
 * by Wave-16 M3. Covers SSE delta accumulation, tool_call streaming,
 * abort propagation, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor } = vi.hoisted(() => {
  const mockCreateFn = vi.fn();
  const mockOpenAIConstructor = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreateFn } },
    _mockCreate: mockCreateFn,
  }));
  return { mockOpenAIConstructor };
});

vi.mock('openai', () => ({ default: mockOpenAIConstructor }));

import { createOpenAIAdapter } from '../index.js';
import type { StreamChunk } from 'harness-one/core';
import { createMockOpenAIClient } from './openai-test-fixtures.js';

describe('createOpenAIAdapter', () => {
  let mock: ReturnType<typeof createMockOpenAIClient>;

  beforeEach(() => {
    mock = createMockOpenAIClient();
  });

  describe('stream()', () => {
    it('propagates abort signal to SDK client.chat.completions.create() in stream mode', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const controller = new AbortController();
      const adapter = createOpenAIAdapter({ client: mock.client });

      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      })) {
        chunks.push(chunk);
      }

      // The OpenAI SDK accepts signal in the second options parameter
      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('yields text_delta and done chunks from stream', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hello' } }] };
          yield { choices: [{ delta: { content: ' World' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const textChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'text_delta');
      expect(textChunks).toHaveLength(2);
      expect((textChunks[0] as StreamChunk).text).toBe('Hello');
      expect((textChunks[1] as StreamChunk).text).toBe(' World');

      const doneChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'done');
      expect(doneChunks.length).toBeGreaterThanOrEqual(1);
    });

    it('skips chunks with no delta', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{}] };  // no delta
          yield { choices: [] };    // empty choices
          yield { choices: [{ delta: { content: 'OK' } }] };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const textChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'text_delta');
      expect(textChunks).toHaveLength(1);
    });

    it('yields tool_call_delta chunks from stream', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'tc-1',
                  function: { name: 'search', arguments: '{"q":' },
                }],
              },
            }],
          };
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: '"test"}' },
                }],
              },
            }],
          };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Search' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);
      expect((toolChunks[0] as StreamChunk).toolCall!.id).toBe('tc-1');
      expect((toolChunks[0] as StreamChunk).toolCall!.name).toBe('search');
      expect((toolChunks[0] as StreamChunk).toolCall!.arguments).toBe('{"q":');
      expect((toolChunks[1] as StreamChunk).toolCall!.arguments).toBe('"test"}');
    });

    it('accumulates tool call id across delta chunks', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          // First chunk has id but no name
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'tc-1',
                  function: { name: 'search', arguments: '' },
                }],
              },
            }],
          };
          // Second chunk updates the same tool call index
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'tc-1',
                  function: { arguments: '{}' },
                }],
              },
            }],
          };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);
      // Second chunk should still have the accumulated id
      expect((toolChunks[1] as StreamChunk).toolCall!.id).toBe('tc-1');
    });

    it('emits done with usage and terminates stream on usage chunk', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
          // If the stream continued, this would be yielded — but it should not be
          yield { choices: [{ delta: { content: 'SHOULD NOT APPEAR' } }] };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      // The done chunk must carry usage data from the usage chunk
      const doneChunk = chunks.find((c: unknown) => (c as StreamChunk).type === 'done') as StreamChunk | undefined;
      expect(doneChunk).toBeDefined();
      expect(doneChunk!.usage).toEqual({ inputTokens: 7, outputTokens: 3 });

      // No text after the usage chunk should have been emitted
      const textChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'text_delta');
      expect(textChunks).toHaveLength(1);
      expect((textChunks[0] as StreamChunk).text).toBe('Hi');
    });

    it('always emits a final done event', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      // The last chunk should always be a 'done' event
      const lastChunk = chunks[chunks.length - 1] as StreamChunk;
      expect(lastChunk.type).toBe('done');
    });

    it('done event always includes usage even when no usage was captured from stream', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hello' } }] };
          yield { choices: [{ delta: { content: ' World' } }] };
          // No usage chunk at all
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const doneChunk = chunks.find((c: unknown) => (c as StreamChunk).type === 'done') as StreamChunk | undefined;
      expect(doneChunk).toBeDefined();
      // Must always have usage with zero-filled defaults
      expect(doneChunk!.usage).toBeDefined();
      expect(doneChunk!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('done event includes real usage when stream provides it', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 15, completion_tokens: 8 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const doneChunk = chunks.find((c: unknown) => (c as StreamChunk).type === 'done') as StreamChunk | undefined;
      expect(doneChunk).toBeDefined();
      expect(doneChunk!.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
    });

    it('passes temperature, topP, and stopSequences to stream API call', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        config: {
          temperature: 0.3,
          topP: 0.8,
          stopSequences: ['END'],
        },
      })) { /* consume */ }

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.3,
          top_p: 0.8,
          stop: ['END'],
        }),
        expect.any(Object),
      );
    });

    it('does not include temperature/topP/stop in stream call when not set', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) { /* consume */ }

      const calledArgs = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(calledArgs).not.toHaveProperty('temperature');
      expect(calledArgs).not.toHaveProperty('top_p');
      expect(calledArgs).not.toHaveProperty('stop');
    });

    it('passes maxTokens to stream API call', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        config: { maxTokens: 500 },
      })) { /* consume */ }

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 500 }),
        expect.any(Object),
      );
    });

    it('includes stream_options to request usage data', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hi' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) { /* consume */ }

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stream_options: { include_usage: true },
        }),
        expect.any(Object),
      );
    });

    it('passes responseFormat json_object to stream API call', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: '{"answer":42}' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: { type: 'json_object' },
      })) { /* consume */ }

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });

    it('passes responseFormat json_schema to stream API call', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: '{"name":"test"}' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      })) { /* consume */ }

      const calledArgs = mock.mocks.create.mock.calls[0][0];
      expect(calledArgs.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      });
    });

    it('generates fallback tool call ID from index when id is missing', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { name: 'search', arguments: '{}' },
                }],
              },
            }],
          };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(1);
      expect((toolChunks[0] as StreamChunk).toolCall!.id).toBe('tool_0');
    });

    it('accumulates tool calls by ID rather than index to handle shifted indices', async () => {
      // Simulate a scenario where a continuation chunk for a tool call arrives
      // with an ID that was previously seen at a different index. With index-based
      // keying, the continuation would create a new (wrong) accumulator entry.
      // With ID-based keying, it correctly appends to the existing entry.
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          // First chunk: tool call "tc-A" at index 0
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'tc-A',
                  function: { name: 'search', arguments: '{"q":' },
                }],
              },
            }],
          };
          // Second chunk: continuation of "tc-A" but arrives at index 1 (shifted)
          // AND carries the id field, so we can match by ID
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 1,
                  id: 'tc-A',
                  function: { arguments: '"hello"}' },
                }],
              },
            }],
          };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);

      // Both chunks should reference the same tool call ID
      expect((toolChunks[0] as StreamChunk).toolCall!.id).toBe('tc-A');
      expect((toolChunks[0] as StreamChunk).toolCall!.name).toBe('search');
      // The second chunk should have accumulated onto the SAME entry (same ID),
      // NOT created a new one. Verify it still carries the accumulated name.
      expect((toolChunks[1] as StreamChunk).toolCall!.id).toBe('tc-A');
      expect((toolChunks[1] as StreamChunk).toolCall!.name).toBe('search');
    });

    it('logs a warning when stream ends without usage data', async () => {
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hello' } }] };
          // No usage chunk
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stream ended without usage data'),
      );
      warnSpy.mockRestore();
    });

    it('skips new tool calls beyond MAX_TOOL_CALLS limit', async () => {
      // Generate 129 distinct tool call chunks — only the first 128 should be accumulated
      const toolCallChunks: unknown[] = [];
      for (let i = 0; i < 129; i++) {
        toolCallChunks.push({
          choices: [{
            delta: {
              tool_calls: [{
                index: i,
                id: `tc-${i}`,
                function: { name: `tool_${i}`, arguments: '{}' },
              }],
            },
          }],
        });
      }

      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          for (const chunk of toolCallChunks) {
            yield chunk;
          }
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      // The 129th tool call should be skipped
      expect(toolChunks).toHaveLength(128);
    });

    it('skips tool call arguments that would exceed MAX_TOOL_ARG_BYTES', async () => {
      // Create a tool call with arguments near the 1MB limit, then try to exceed it
      const largeArgs = 'x'.repeat(1_048_500); // just under 1MB
      const overflowArgs = 'y'.repeat(200); // would push over 1MB

      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'tc-big',
                  function: { name: 'big_tool', arguments: largeArgs },
                }],
              },
            }],
          };
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: overflowArgs },
                }],
              },
            }],
          };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      // First chunk has the large args; second chunk is skipped entirely (continue before yield)
      expect(toolChunks).toHaveLength(1);
      expect((toolChunks[0] as StreamChunk).toolCall!.arguments).toBe(largeArgs);
    });

    it('does not throw when consumer breaks early from stream (F8 resource cleanup)', async () => {
      const abortFn = vi.fn();
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'chunk1' } }] };
          yield { choices: [{ delta: { content: 'chunk2' } }] };
          yield { choices: [{ delta: { content: 'chunk3' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
        },
        controller: { abort: abortFn },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
        if ((chunk as StreamChunk).type === 'text_delta') break; // early return
      }

      // Should have collected only the first text chunk before breaking
      expect(chunks).toHaveLength(1);
      expect((chunks[0] as StreamChunk).type).toBe('text_delta');
      // The controller.abort() should have been called in the finally block
      expect(abortFn).toHaveBeenCalled();
    });

    it('correctly accumulates tool calls when continuation chunks lack id and use index for lookup', async () => {
      // This test verifies the ID-based keying with index fallback:
      // When a continuation chunk has no `tc.id` but has `tc.index`, the accumulator
      // must find the right entry by looking up the index-to-ID mapping.
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          // First chunk for tool call at index 0 with ID
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_abc123',
                  function: { name: 'get_weather', arguments: '{"city":' },
                }],
              },
            }],
          };
          // Continuation: same index 0, NO id field
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: '"NYC"}' },
                }],
              },
            }],
          };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'weather' }],
      })) {
        chunks.push(chunk);
      }

      const toolChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);

      // Both chunks should reference the same tool call ID
      expect((toolChunks[0] as StreamChunk).toolCall!.id).toBe('call_abc123');
      expect((toolChunks[0] as StreamChunk).toolCall!.name).toBe('get_weather');
      expect((toolChunks[1] as StreamChunk).toolCall!.id).toBe('call_abc123');
      // Arguments should accumulate: first '{"city":' then '"NYC"}'
      expect((toolChunks[0] as StreamChunk).toolCall!.arguments).toBe('{"city":');
      expect((toolChunks[1] as StreamChunk).toolCall!.arguments).toBe('"NYC"}');
    });
  });
});
