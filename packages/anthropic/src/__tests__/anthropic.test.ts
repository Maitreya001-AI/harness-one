import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import type { Message, StreamChunk } from 'harness-one/core';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

// ---------------------------------------------------------------------------
// Mock Anthropic client
// ---------------------------------------------------------------------------

function createMockAnthropicClient() {
  const createFn = vi.fn();
  const streamFn = vi.fn();

  return {
    client: {
      messages: {
        create: createFn,
        stream: streamFn,
      },
    } as unknown as AnthropicAdapterConfig['client'],
    mocks: {
      create: createFn,
      stream: streamFn,
    },
  };
}

describe('createAnthropicAdapter', () => {
  let mock: ReturnType<typeof createMockAnthropicClient>;

  beforeEach(() => {
    mock = createMockAnthropicClient();
  });

  describe('chat()', () => {
    it('sends messages and returns response', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Hello!' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [
          { role: 'user', content: 'Hi' },
        ],
      });

      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toBe('Hello!');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
    });

    it('extracts system message into system parameter', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 20, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hi' },
        ],
      });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are helpful',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        expect.any(Object),
      );
    });

    it('handles tool_use response', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [
          { type: 'text', text: 'Let me search.' },
          { type: 'tool_use', id: 'tc-1', name: 'web_search', input: { query: 'test' } },
        ],
        usage: { input_tokens: 30, output_tokens: 15 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Search for test' }],
      });

      expect(result.message.toolCalls).toHaveLength(1);
      expect(result.message.toolCalls![0].id).toBe('tc-1');
      expect(result.message.toolCalls![0].name).toBe('web_search');
      expect(JSON.parse(result.message.toolCalls![0].arguments)).toEqual({ query: 'test' });
    });

    it('converts tool result messages', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Got it' }],
        usage: { input_tokens: 25, output_tokens: 5 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [
          { role: 'user', content: 'Search' },
          { role: 'tool', content: 'result data', toolCallId: 'tc-1' },
        ],
      });

      const calledMessages = mock.mocks.create.mock.calls[0][0].messages;
      expect(calledMessages[1]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'result data' }],
      });
    });

    it('converts tool schemas to Anthropic format', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
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
        name: 'search',
        description: 'Search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      });
    });

    it('maps all JsonSchema fields to Anthropic input_schema without double assertions', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
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
      const schema = calledTools[0].input_schema;
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.required).toEqual(['name']);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.description).toBe('The input schema');
    });

    it('omits undefined JsonSchema fields from Anthropic input_schema', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'simple_tool',
          description: 'Minimal schema',
          parameters: { type: 'object' },
        }],
      });

      const calledTools = mock.mocks.create.mock.calls[0][0].tools;
      const schema = calledTools[0].input_schema;
      // Only 'type' should be present; no extra undefined keys
      expect(Object.keys(schema)).toEqual(['type']);
    });

    it('uses default model claude-sonnet-4-20250514', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-20250514' }),
        expect.any(Object),
      );
    });

    it('uses custom model', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client, model: 'claude-3-haiku' });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-haiku' }),
        expect.any(Object),
      );
    });

    it('maps cache tokens from usage', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.usage.cacheReadTokens).toBe(80);
      expect(result.usage.cacheWriteTokens).toBe(20);
    });

    it('propagates abort signal to SDK client.messages.create()', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const controller = new AbortController();
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      });

      // The Anthropic SDK accepts signal in the second options argument
      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('handles invalid JSON in tool call arguments gracefully', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 50, output_tokens: 5 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: 'not valid json' }],
        },
        { role: 'tool', content: 'results', toolCallId: 'tc-1' },
      ];

      // Should not throw even though arguments is not valid JSON
      await expect(adapter.chat({ messages })).resolves.toBeDefined();
    });

    it('safely reads cache tokens without unsafe type assertions', async () => {
      // Usage with NO cache fields at all (not just undefined)
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheWriteTokens).toBe(0);
    });

    it('throws HarnessError when Anthropic API returns empty content', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow(HarnessError);
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('Anthropic API returned empty content');
    });

    it('throws HarnessError when Anthropic API returns null content', async () => {
      mock.mocks.create.mockResolvedValue({
        content: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow(HarnessError);
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('Anthropic API returned empty content');
    });

    it('throws HarnessError when Anthropic API returns undefined content', async () => {
      mock.mocks.create.mockResolvedValue({
        content: undefined,
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow(HarnessError);
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow('Anthropic API returned empty content');
    });

    it('extracts cache tokens safely even when cache fields are completely absent from usage', async () => {
      // Usage object with NO cache fields at all (neither undefined nor number)
      const usageWithoutCacheFields = Object.create(null);
      usageWithoutCacheFields.input_tokens = 50;
      usageWithoutCacheFields.output_tokens = 25;

      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: usageWithoutCacheFields,
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      // Should default to 0 without throwing
      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheWriteTokens).toBe(0);
      expect(result.usage.inputTokens).toBe(50);
      expect(result.usage.outputTokens).toBe(25);
    });

    it('extracts cache tokens safely when cache fields are non-number types', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 'not a number',
          cache_creation_input_tokens: null,
        },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      const result = await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      // Non-number values should default to 0
      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheWriteTokens).toBe(0);
    });

    it('passes maxTokens, temperature, topP, and stopSequences config to chat call', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        config: {
          maxTokens: 2048,
          temperature: 0.7,
          topP: 0.95,
          stopSequences: ['STOP'],
        },
      });

      expect(mock.mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          max_tokens: 2048,
          temperature: 0.7,
          top_p: 0.95,
          stop_sequences: ['STOP'],
        }),
        expect.any(Object),
      );
    });

    it('maps all remaining JsonSchema fields (items, enum, default, min/max, pattern, oneOf, anyOf, allOf, const, format) to Anthropic input_schema', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'full_schema_tool',
          description: 'Tool with all schema fields at top level',
          parameters: {
            type: 'object',
            items: { type: 'string' },
            enum: ['a', 'b', 'c'],
            default: 'a',
            minimum: 0,
            maximum: 100,
            minLength: 1,
            maxLength: 50,
            pattern: '^[a-z]+$',
            oneOf: [{ type: 'string' }, { type: 'number' }],
            anyOf: [{ type: 'boolean' }],
            allOf: [{ type: 'object' }],
            const: 'fixed',
            format: 'email',
          },
        }],
      });

      const calledTools = mock.mocks.create.mock.calls[0][0].tools;
      const schema = calledTools[0].input_schema;
      expect(schema.type).toBe('object');
      expect(schema.items).toEqual({ type: 'string' });
      expect(schema.enum).toEqual(['a', 'b', 'c']);
      expect(schema.default).toBe('a');
      expect(schema.minimum).toBe(0);
      expect(schema.maximum).toBe(100);
      expect(schema.minLength).toBe(1);
      expect(schema.maxLength).toBe(50);
      expect(schema.pattern).toBe('^[a-z]+$');
      expect(schema.oneOf).toEqual([{ type: 'string' }, { type: 'number' }]);
      expect(schema.anyOf).toEqual([{ type: 'boolean' }]);
      expect(schema.allOf).toEqual([{ type: 'object' }]);
      expect(schema.const).toBe('fixed');
      expect(schema.format).toBe('email');
    });

    it('handles assistant message with tool calls in input', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 50, output_tokens: 5 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
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
      expect(calledMessages[1].content).toEqual([
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'tc-1', name: 'search', input: { q: 'test' } },
      ]);
    });
  });

  describe('stream()', () => {
    function createMockStream(events: unknown[]) {
      const asyncIter = {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event;
          }
        },
        finalMessage: vi.fn(),
      };
      return asyncIter;
    }

    it('propagates abort signal to SDK client.messages.stream()', async () => {
      const mockStream = createMockStream([]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const controller = new AbortController();
      const adapter = createAnthropicAdapter({ client: mock.client });

      // Consume the stream
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      })) {
        chunks.push(chunk);
      }

      // The Anthropic SDK stream() accepts signal in the second options argument
      expect(mock.mocks.stream).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('passes topP and stopSequences to stream call', async () => {
      const mockStream = createMockStream([]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        config: { topP: 0.9, stopSequences: ['STOP', 'END'] },
      })) {
        chunks.push(chunk);
      }

      expect(mock.mocks.stream).toHaveBeenCalledWith(
        expect.objectContaining({
          top_p: 0.9,
          stop_sequences: ['STOP', 'END'],
        }),
        expect.any(Object),
      );
    });

    it('emits only one done event (from finalMessage, not message_delta)', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        {
          type: 'message_delta',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      // Should have exactly one done event (from finalMessage), not two
      const doneChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'done');
      expect(doneChunks).toHaveLength(1);
    });

    it('yields text_delta chunks from stream', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' World' } },
      ]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
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
    });

    it('yields tool_call_delta chunks for tool_use streaming', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tc-1', name: 'search' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"test"}' } },
      ]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 20, output_tokens: 10 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Search for test' }],
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

    it('passes system message, tools, and temperature to stream call', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } },
      ]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hi' },
        ],
        tools: [{
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        }],
        config: { temperature: 0.5 },
      })) {
        chunks.push(chunk);
      }

      expect(mock.mocks.stream).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'Be helpful',
          messages: [{ role: 'user', content: 'Hi' }],
          tools: [expect.objectContaining({ name: 'search' })],
          temperature: 0.5,
        }),
        expect.any(Object),
      );
    });

    it('rethrows finalMessage() error as HarnessError with cause when no abort signal aborted (CQ-003)', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      ]);
      const rootCause = new Error('Network broke');
      mockStream.finalMessage.mockRejectedValue(rootCause);
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });

      async function drain(): Promise<unknown[]> {
        const chunks: unknown[] = [];
        for await (const chunk of adapter.stream!({
          messages: [{ role: 'user', content: 'Hi' }],
        })) {
          chunks.push(chunk);
        }
        return chunks;
      }

      await expect(drain()).rejects.toBeInstanceOf(HarnessError);
      try {
        await drain();
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe(HarnessErrorCode.ADAPTER_ERROR);
        // cause must be preserved so operators can trace the real failure
        expect((err as HarnessError).cause).toBe(rootCause);
      }
    });

    it('yields terminal zero-usage done chunk when signal was aborted (CQ-003)', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } },
      ]);
      mockStream.finalMessage.mockRejectedValue(new Error('aborted by caller'));
      mock.mocks.stream.mockReturnValue(mockStream);

      const controller = new AbortController();
      // Abort BEFORE we start consuming so the post-iteration check sees aborted=true.
      controller.abort();

      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      })) {
        chunks.push(chunk);
      }

      const doneChunks = chunks.filter((c: unknown) => (c as StreamChunk).type === 'done');
      expect(doneChunks).toHaveLength(1);
      const done = doneChunks[0] as StreamChunk;
      expect(done.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('yields done chunk with usage from finalMessage', async () => {
      const mockStream = createMockStream([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      ]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 15, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks: unknown[] = [];
      for await (const chunk of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      const doneChunk = chunks.find((c: unknown) => (c as StreamChunk).type === 'done') as StreamChunk | undefined;
      expect(doneChunk).toBeDefined();
      expect(doneChunk!.usage!.inputTokens).toBe(15);
      expect(doneChunk!.usage!.outputTokens).toBe(8);
      expect(doneChunk!.usage!.cacheReadTokens).toBe(5);
      expect(doneChunk!.usage!.cacheWriteTokens).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // SPEC-005 / SPEC-014: LLMConfig.extra must be forwarded to provider
  //
  // T05 (Wave-5A): As of T05, only keys in the Anthropic allow-list
  // (`temperature`, `top_k`, `top_p`, `stop_sequences`, `thinking`, `metadata`,
  // `system`) are forwarded by default; unknown keys are filtered with a warn.
  // These tests therefore assert forwarding semantics using allow-listed keys.
  // See `extra-allow-list.test.ts` for the full T05 contract (filter + strict).
  // -------------------------------------------------------------------------
  describe('LLMConfig.extra forwarding (SPEC-005)', () => {
    it('forwards allow-listed config.extra keys into chat() request body', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        config: { extra: { metadata: { userId: 'u' }, thinking: { budget_tokens: 1024 } } },
      });

      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.metadata).toEqual({ userId: 'u' });
      expect(body.thinking).toEqual({ budget_tokens: 1024 });
    });

    it('forwards allow-listed config.extra keys into stream() request body', async () => {
      function createMockStream(events: unknown[]) {
        const asyncIter = {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
          finalMessage: vi.fn(),
        };
        return asyncIter;
      }
      const mockStream = createMockStream([]);
      mockStream.finalMessage.mockResolvedValue({
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      mock.mocks.stream.mockReturnValue(mockStream);

      const adapter = createAnthropicAdapter({ client: mock.client });
      for await (const _c of adapter.stream!({
        messages: [{ role: 'user', content: 'Hi' }],
        config: { extra: { top_k: 42 } },
      })) { /* consume */ }

      const body = mock.mocks.stream.mock.calls[0][0] as Record<string, unknown>;
      expect(body.top_k).toBe(42);
    });

    it('extra overrides conflicting base params (extra merged last)', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        config: {
          temperature: 0.2,
          extra: { temperature: 0.99 },
        },
      });

      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.temperature).toBe(0.99);
    });
  });

  // -------------------------------------------------------------------------
  // CQ-027: logger injection routes warnings away from console.warn
  // -------------------------------------------------------------------------
  describe('logger config (CQ-027)', () => {
    it('routes tool_use malformed JSON warning through custom logger', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fakeLogger = { warn: vi.fn(), error: vi.fn() };

      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const adapter = createAnthropicAdapter({ client: mock.client, logger: fakeLogger });
      await adapter.chat({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-1', name: 'search', arguments: 'not json' }],
          },
        ],
      });

      expect(fakeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not valid JSON'),
      );
      // console.warn should NOT be called when logger is injected
      const consoleMatches = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].includes('not valid JSON'),
      );
      expect(consoleMatches.length).toBe(0);
      warnSpy.mockRestore();
    });
  });
});
