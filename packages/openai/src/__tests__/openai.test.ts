import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenAIAdapter, providers } from '../index.js';
import type { OpenAIAdapterConfig } from '../index.js';
import type { Message } from 'harness-one/core';
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

      // The OpenAI SDK accepts signal in the options parameter
      expect(mock.mocks.create).toHaveBeenCalledWith(
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

      // The OpenAI SDK accepts signal in the options parameter
      expect(mock.mocks.create).toHaveBeenCalledWith(
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

      const textChunks = chunks.filter((c: any) => c.type === 'text_delta');
      expect(textChunks).toHaveLength(2);
      expect((textChunks[0] as any).text).toBe('Hello');
      expect((textChunks[1] as any).text).toBe(' World');

      const doneChunks = chunks.filter((c: any) => c.type === 'done');
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

      const textChunks = chunks.filter((c: any) => c.type === 'text_delta');
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

      const toolChunks = chunks.filter((c: any) => c.type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);
      expect((toolChunks[0] as any).toolCall.id).toBe('tc-1');
      expect((toolChunks[0] as any).toolCall.name).toBe('search');
      expect((toolChunks[0] as any).toolCall.arguments).toBe('{"q":');
      expect((toolChunks[1] as any).toolCall.arguments).toBe('"test"}');
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

      const toolChunks = chunks.filter((c: any) => c.type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);
      // Second chunk should still have the accumulated id
      expect((toolChunks[1] as any).toolCall.id).toBe('tc-1');
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
      const lastChunk = chunks[chunks.length - 1] as any;
      expect(lastChunk.type).toBe('done');
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
      );
    });
  });
});
