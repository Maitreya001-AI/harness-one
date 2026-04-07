import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenAIAdapter } from '../index.js';
import type { Message } from 'harness-one/core';

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
    } as any,
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

    it('throws when no choices returned', async () => {
      mock.mocks.create.mockResolvedValue({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });

      const adapter = createOpenAIAdapter({ client: mock.client });
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
});
