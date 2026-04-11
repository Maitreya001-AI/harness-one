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

import { createOpenAIAdapter, providers } from '../index.js';
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

    it('can be spread into adapter config', async () => {
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
});
