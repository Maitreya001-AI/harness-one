import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
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
    } as any,
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
});
