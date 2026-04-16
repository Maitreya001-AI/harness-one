import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOpenAIConstructor } = vi.hoisted(() => {
  const mockCreateFn = vi.fn();
  const mockOpenAIConstructor = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreateFn,
      },
    },
    _mockCreate: mockCreateFn,
  }));
  return { mockOpenAIConstructor };
});

vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
}));

import { createOpenAIAdapter, providers, registerProvider, _resetOpenAIWarnState } from '../index.js';
import type { OpenAIAdapterConfig } from '../index.js';
import type { Message, StreamChunk } from 'harness-one/core';
import { HarnessError } from 'harness-one/core';

// ---------------------------------------------------------------------------
// Mock OpenAI client
// ---------------------------------------------------------------------------

function createMockOpenAIClient() {
  const createFn = vi.fn();

  return {
    client: {
      chat: {
        completions: {
          create: createFn,
        },
      },
    } as unknown as NonNullable<OpenAIAdapterConfig['client']>,
    mocks: {
      create: createFn,
    },
  };
}

describe('createOpenAIAdapter', () => {
  let mock: ReturnType<typeof createMockOpenAIClient>;

  beforeEach(() => {
    mock = createMockOpenAIClient();
  });

  describe('chat()', () => {
    it('sends messages and returns response', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{
          message: { role: 'assistant', content: 'Hello!', tool_calls: undefined },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toBe('Hello!');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });

    it('uses default model gpt-4o', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' }),
        expect.any(Object),
      );
    });

    it('uses custom model', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client, model: 'gpt-3.5-turbo' });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-3.5-turbo' }),
        expect.any(Object),
      );
    });

    it('handles tool_calls response', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Let me search.',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"test"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Search for test' }],
      });

      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0].id).toBe('tc-1');
      expect(result.message.toolCalls![0].name).toBe('web_search');
    });

    it('converts tool result messages', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Got it' } }],
        usage: { prompt_tokens: 25, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [
          { role: 'user', content: 'Search' },
          { role: 'tool', content: 'result data', toolCallId: 'tc-1' },
        ],
      });

      const calledMessages = mock.mocks.create.mock.calls[0][0].messages;
      expect(calledMessages[1]).toEqual({
        role: 'tool',
        tool_call_id: 'tc-1',
        content: 'result data',
      });
    });

    it('converts tool schemas to OpenAI format', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        }],
      });

      const calledTools = mock.mocks.create.mock.calls[0][0].tools;
      expect(calledTools[0]).toEqual({
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      });
    });

    it('maps all JsonSchema fields to OpenAI parameters without double assertions', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'advanced_tool',
          description: 'A tool with many schema fields',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z]+$' },
              count: { type: 'integer', minimum: 0, maximum: 10 },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['name'],
            additionalProperties: false,
            description: 'The input schema',
          },
        }],
      });

      const calledTools = mock.mocks.create.mock.calls[0][0].tools;
      const params = calledTools[0].function.parameters;
      expect(params.type).toBe('object');
      expect(params.properties).toBeDefined();
      expect(params.required).toEqual(['name']);
      expect(params.additionalProperties).toBe(false);
      expect(params.description).toBe('The input schema');
      // Verify nested schema fields are preserved
      expect(params.properties.name.minLength).toBe(1);
      expect(params.properties.name.maxLength).toBe(100);
      expect(params.properties.name.pattern).toBe('^[a-z]+$');
      expect(params.properties.count.minimum).toBe(0);
      expect(params.properties.count.maximum).toBe(10);
      expect(params.properties.tags.items).toEqual({ type: 'string' });
    });

    it('omits undefined JsonSchema fields from OpenAI parameters', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'simple_tool',
          description: 'Minimal schema',
          parameters: { type: 'object' },
        }],
      });

      const calledTools = mock.mocks.create.mock.calls[0][0].tools;
      const params = calledTools[0].function.parameters;
      // Only 'type' should be present; no extra undefined keys
      expect(Object.keys(params)).toEqual(['type']);
    });

    it('throws HarnessError when no choices returned', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow(HarnessError);
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('OpenAI returned no choices');
    });

    it('handles missing usage gracefully', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: undefined,
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });

    it('passes system message through directly', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hi' },
        ],
      });

      const calledMessages = mock.mocks.create.mock.calls[0][0].messages;
      expect(calledMessages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    });

    it('propagates abort signal to SDK client.chat.completions.create()', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });

      const controller = new AbortController();
      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      });

      // The OpenAI SDK accepts signal in the second options parameter
      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('handles assistant messages with tool calls in conversation', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Done' } }],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const messages: Message[] = [
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          content: 'Searching...',
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{"q":"test"}' }],
        },
        { role: 'tool', content: 'results', toolCallId: 'tc-1' },
      ];

      await adapter.chat({ messages });

      const calledMessages = mock.mocks.create.mock.calls[0][0].messages;
      expect(calledMessages[1].role).toBe('assistant');
      expect(calledMessages[1].tool_calls).toHaveLength(1);
      expect(calledMessages[1].tool_calls[0].function.name).toBe('search');
    });

    it('converts plain assistant messages (no tool calls) correctly', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Plain response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [
          { role: 'user', content: 'Ask' },
          { role: 'assistant', content: 'Previous response' },
          { role: 'user', content: 'Follow up' },
        ],
      });

      const calledMessages = mock.mocks.create.mock.calls[0][0].messages;
      // The plain assistant message (no tool calls) should map to role: 'assistant'
      expect(calledMessages[1]).toEqual({ role: 'assistant', content: 'Previous response' });
    });

    it('handles null content in response message', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: { name: 'search', arguments: '{}' },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      // content should default to empty string when null
      expect(result.message.content).toBe('');
      expect(result.message.toolCalls).toHaveLength(1);
    });

    it('passes config options to SDK (temperature, topP, maxTokens, stopSequences)', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        config: {
          temperature: 0.5,
          topP: 0.9,
          maxTokens: 100,
          stopSequences: ['STOP'],
        },
      });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          top_p: 0.9,
          max_tokens: 100,
          stop: ['STOP'],
        }),
        expect.any(Object),
      );
    });

    it('passes responseFormat json_object to SDK', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: '{"answer": 42}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: { type: 'json_object' },
      });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });

    it('passes responseFormat json_schema to SDK', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: '{"name":"test"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          strict: true,
        },
      });

      const calledArgs = mock.mocks.create.mock.calls[0][0];
      expect(calledArgs.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          strict: true,
        },
      });
    });

    it('passes responseFormat json_schema without strict when undefined', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: '{"name":"test"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      });

      const calledArgs = mock.mocks.create.mock.calls[0][0];
      expect(calledArgs.response_format.json_schema).not.toHaveProperty('strict');
    });

    it('does not pass response_format when responseFormat is text', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        responseFormat: { type: 'text' },
      });

      const calledArgs = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(calledArgs).not.toHaveProperty('response_format');
    });

    it('does not pass response_format when responseFormat is not set', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'Hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const calledArgs = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(calledArgs).not.toHaveProperty('response_format');
    });
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

  describe('client creation', () => {
    it('creates OpenAI client with apiKey, baseURL, defaultHeaders, and maxRetries when no client provided', () => {
      mockOpenAIConstructor.mockClear();

      createOpenAIAdapter({
        apiKey: 'test-key',
        baseURL: 'https://custom.api.com',
        defaultHeaders: { 'X-Custom': 'header' },
        maxRetries: 5,
        model: 'gpt-4',
      });

      expect(mockOpenAIConstructor).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: 'https://custom.api.com',
        defaultHeaders: { 'X-Custom': 'header' },
        maxRetries: 5,
      });
    });
  });

  describe('providers', () => {
    it('contains base URLs for known providers', () => {
      expect(providers.openrouter.baseURL).toBe('https://openrouter.ai/api/v1');
      expect(providers.groq.baseURL).toBe('https://api.groq.com/openai/v1');
      expect(providers.deepseek.baseURL).toBe('https://api.deepseek.com');
      expect(providers.together.baseURL).toBe('https://api.together.xyz/v1');
      expect(providers.fireworks.baseURL).toBe('https://api.fireworks.ai/inference/v1');
      expect(providers.perplexity.baseURL).toBe('https://api.perplexity.ai');
      expect(providers.mistral.baseURL).toBe('https://api.mistral.ai/v1');
      expect(providers.ollama.baseURL).toBe('http://localhost:11434/v1');
    });

    it('registerProvider adds a new provider that is accessible via providers', () => {
      registerProvider('custom-provider', { baseURL: 'https://custom.example.com/v1' });
      expect(providers['custom-provider']).toEqual({ baseURL: 'https://custom.example.com/v1' });
    });

    it('registerProvider overwrites an existing non-built-in provider', () => {
      // ollama is a convenience entry, not a reserved built-in
      registerProvider('ollama', { baseURL: 'http://127.0.0.1:11434/v1' });
      expect(providers.ollama).toEqual({ baseURL: 'http://127.0.0.1:11434/v1' });
      // Restore for other tests
      registerProvider('ollama', { baseURL: 'http://localhost:11434/v1' });
    });

    it('registerProvider rejects malformed baseURL', () => {
      expect(() =>
        registerProvider('broken', { baseURL: 'not a url' }),
      ).toThrow(HarnessError);
      expect(() =>
        registerProvider('broken', { baseURL: 'not a url' }),
      ).toThrow(/not a valid URL/);
    });

    it('registerProvider rejects plain http:// for non-localhost hosts', () => {
      expect(() =>
        registerProvider('insecure', { baseURL: 'http://evil.example.com/v1' }),
      ).toThrow(HarnessError);
      expect(() =>
        registerProvider('insecure', { baseURL: 'http://evil.example.com/v1' }),
      ).toThrow(/non-HTTPS/);
    });

    it('registerProvider allows http:// for localhost and 127.0.0.1', () => {
      expect(() =>
        registerProvider('local-dev-a', { baseURL: 'http://localhost:8080/v1' }),
      ).not.toThrow();
      expect(() =>
        registerProvider('local-dev-b', { baseURL: 'http://127.0.0.1:9090/v1' }),
      ).not.toThrow();
    });

    it('registerProvider rejects re-registering built-in name "openai" without force', () => {
      expect(() =>
        registerProvider('openai', { baseURL: 'https://attacker.example.com/v1' }),
      ).toThrow(HarnessError);
      expect(() =>
        registerProvider('openai', { baseURL: 'https://attacker.example.com/v1' }),
      ).toThrow(/reserved built-in/);
    });

    it('registerProvider rejects re-registering built-in name "anthropic" without force', () => {
      expect(() =>
        registerProvider('anthropic', { baseURL: 'https://attacker.example.com/v1' }),
      ).toThrow(/reserved built-in/);
    });

    it('registerProvider allows overriding built-in name when { force: true }', () => {
      // Side-effect: this mutates the shared registry. We restore in the next line.
      registerProvider(
        'openai',
        { baseURL: 'https://proxy.example.com/v1' },
        { force: true },
      );
      expect(providers.openai).toEqual({ baseURL: 'https://proxy.example.com/v1' });
      // Clean up: remove the override so later tests don't see it
      // (no removeProvider API; just overwrite back to undefined via delete-like by
      // re-registering a benign HTTPS value that callers would only use intentionally)
      registerProvider(
        'openai',
        { baseURL: 'https://api.openai.com/v1' },
        { force: true },
      );
    });

    it('registerProvider rejects empty name', () => {
      expect(() =>
        registerProvider('', { baseURL: 'https://example.com' }),
      ).toThrow(/non-empty string/);
    });

    it('can be spread into adapter config (localhost allowed)', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      // When client is provided, baseURL from providers is ignored (client takes precedence)
      const adapter = createOpenAIAdapter({
        client: mock.client,
        ...providers.groq,
        model: 'llama-3.3-70b-versatile',
      });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'llama-3.3-70b-versatile' }),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // F15: countTokens()
  // -------------------------------------------------------------------------
  describe('countTokens()', () => {
    it('returns a reasonable heuristic count without custom tokenizer', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const count = await adapter.countTokens!([
        { role: 'user', content: 'Hello world' },
      ]);
      // "Hello world" = 11 chars / 4 ≈ 3, + 1 message * 4 overhead = 7
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(100);
    });

    it('uses injected tokenizer when provided', async () => {
      const customTokenizer = vi.fn().mockReturnValue(42);
      const adapter = createOpenAIAdapter({ client: mock.client, countTokens: customTokenizer });
      const count = await adapter.countTokens!([
        { role: 'user', content: 'Hello world' },
      ]);
      expect(count).toBe(42);
      expect(customTokenizer).toHaveBeenCalledWith('Hello world');
    });

    it('handles multiple messages', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const count = await adapter.countTokens!([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ]);
      // "You are helpfulHi" = 17 chars / 4 ≈ 5, + 2 messages * 4 = 13
      expect(count).toBeGreaterThan(0);
    });

    it('handles empty messages', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const count = await adapter.countTokens!([]);
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // SPEC-004: cacheReadTokens population from OpenAI prompt_tokens_details
  // -------------------------------------------------------------------------
  describe('toTokenUsage cache tokens', () => {
    it('populates cacheReadTokens from usage.prompt_tokens_details.cached_tokens (chat)', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const result = await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.usage.cacheReadTokens).toBe(40);
    });

    it('omits cacheReadTokens when prompt_tokens_details is absent (chat)', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      const result = await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(result.usage.cacheReadTokens).toBeUndefined();
    });

    it('populates cacheReadTokens from stream usage chunk', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'hi' } }] };
          yield {
            choices: [{ delta: {} }],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 30,
              prompt_tokens_details: { cached_tokens: 150 },
            },
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

      const doneChunk = chunks.find((c: unknown) => (c as StreamChunk).type === 'done') as StreamChunk | undefined;
      expect(doneChunk).toBeDefined();
      expect(doneChunk!.usage!.cacheReadTokens).toBe(150);
    });
  });

  // -------------------------------------------------------------------------
  // SPEC-005 / SPEC-014: LLMConfig.extra must be forwarded to provider
  // T06 (Wave-5A): extra is now filtered against OPENAI_EXTRA_ALLOW_LIST.
  // These tests use allow-listed keys to validate the forwarding contract;
  // see __tests__/extra-allow-list.test.ts for the full filter/strict behavior.
  // -------------------------------------------------------------------------
  describe('LLMConfig.extra forwarding (SPEC-005)', () => {
    it('forwards config.extra keys into chat() request body', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        config: { extra: { user: 'tenant-v', seed: 42 } },
      });

      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.user).toBe('tenant-v');
      expect(body.seed).toBe(42);
    });

    it('forwards config.extra keys into stream() request body', async () => {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'ok' } }] };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client });
      for await (const _c of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        config: { extra: { parallel_tool_calls: true } },
      })) { /* consume */ }

      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.parallel_tool_calls).toBe(true);
    });

    it('extra overrides conflicting base params (extra merged last)', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        config: {
          temperature: 0.2,
          extra: { temperature: 0.99 }, // caller explicitly asked for this
        },
      });

      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.temperature).toBe(0.99);
    });

    it('no-op when config.extra is not provided', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      // Ensure no surprise keys leaked in
      expect(body).not.toHaveProperty('customKey');
    });
  });

  // -------------------------------------------------------------------------
  // SPEC-015: zero-token warn (chat/non-stream path)
  // -------------------------------------------------------------------------
  describe('zero-token non-stream warn (SPEC-015)', () => {
    beforeEach(() => {
      _resetOpenAIWarnState();
    });

    it('warns once per model when chat response lacks prompt/completion tokens', async () => {
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: undefined,
      });

      const adapter = createOpenAIAdapter({ client: mock.client, model: 'gpt-spec-015' });
      await adapter.chat({ messages: [{ role: 'user', content: 'a' }] });
      await adapter.chat({ messages: [{ role: 'user', content: 'b' }] });
      await adapter.chat({ messages: [{ role: 'user', content: 'c' }] });

      const matching = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('missing prompt/completion token counts'),
      );
      expect(matching.length).toBe(1);
      warnSpy.mockRestore();
    });

    it('warns separately for each distinct model', async () => {
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: null, completion_tokens: null },
      });

      const a = createOpenAIAdapter({ client: mock.client, model: 'model-A' });
      const b = createOpenAIAdapter({ client: mock.client, model: 'model-B' });
      await a.chat({ messages: [{ role: 'user', content: 'x' }] });
      await b.chat({ messages: [{ role: 'user', content: 'y' }] });
      await a.chat({ messages: [{ role: 'user', content: 'z' }] });

      const matching = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('missing prompt/completion token counts'),
      );
      expect(matching.length).toBe(2);
      warnSpy.mockRestore();
    });

    it('does NOT warn when usage fully populated', async () => {
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client, model: 'model-ok' });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      const matching = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('missing prompt/completion token counts'),
      );
      expect(matching.length).toBe(0);
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // CQ-027: logger injection routes warnings away from console.warn
  // -------------------------------------------------------------------------
  describe('logger config (CQ-027)', () => {
    beforeEach(() => {
      _resetOpenAIWarnState();
    });

    it('routes stream-missing-usage warning through custom logger, not console', async () => {
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fakeLogger = { warn: vi.fn(), error: vi.fn() };

      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'hi' } }] };
          // no usage chunk
        },
      };
      mock.mocks.create.mockResolvedValue(asyncIter);

      const adapter = createOpenAIAdapter({ client: mock.client, logger: fakeLogger });
      for await (const _c of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) { /* consume */ }

      expect(fakeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Stream ended without usage data'),
      );
      // console.warn must NOT receive the adapter warning when a logger is injected
      const consoleMatches = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('Stream ended without usage data'),
      );
      expect(consoleMatches.length).toBe(0);
      warnSpy.mockRestore();
    });

    it('routes chat zero-usage warning through custom logger', async () => {
      const fakeLogger = { warn: vi.fn(), error: vi.fn() };
      mock.mocks.create.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: undefined,
      });

      const adapter = createOpenAIAdapter({
        client: mock.client,
        model: 'model-logger',
        logger: fakeLogger,
      });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(fakeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('missing prompt/completion token counts'),
      );
    });
  });
});
