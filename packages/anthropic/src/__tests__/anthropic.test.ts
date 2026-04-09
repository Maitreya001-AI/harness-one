import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import type { Message } from 'harness-one/core';

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
      const doneChunks = chunks.filter((c: any) => c.type === 'done');
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

      const textChunks = chunks.filter((c: any) => c.type === 'text_delta');
      expect(textChunks).toHaveLength(2);
      expect((textChunks[0] as any).text).toBe('Hello');
      expect((textChunks[1] as any).text).toBe(' World');
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

      const toolChunks = chunks.filter((c: any) => c.type === 'tool_call_delta');
      expect(toolChunks).toHaveLength(2);
      expect((toolChunks[0] as any).toolCall.id).toBe('tc-1');
      expect((toolChunks[0] as any).toolCall.name).toBe('search');
      expect((toolChunks[0] as any).toolCall.arguments).toBe('{"q":');
      expect((toolChunks[1] as any).toolCall.arguments).toBe('"test"}');
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

      const doneChunk = chunks.find((c: any) => c.type === 'done') as any;
      expect(doneChunk).toBeDefined();
      expect(doneChunk.usage.inputTokens).toBe(15);
      expect(doneChunk.usage.outputTokens).toBe(8);
      expect(doneChunk.usage.cacheReadTokens).toBe(5);
      expect(doneChunk.usage.cacheWriteTokens).toBe(2);
    });
  });
});
