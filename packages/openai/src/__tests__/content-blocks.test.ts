/**
 * Tests for RFC-0001 content-block handling in the OpenAI adapter.
 *
 * Covers: user image blocks → OpenAI content-parts (base64 data URL + direct
 * URL), the no-image fast path (plain-string content shape unchanged),
 * assistant thinking-block drop with warn-once, and tool-result image
 * degradation to a text marker with warn-once.
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
import type { Message } from 'harness-one/core';
import { createMockOpenAIClient } from './openai-test-fixtures.js';

const CHAT_OK = {
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
};

/** Return the `messages` array that was sent to the SDK on the first call. */
function sentMessages(mock: ReturnType<typeof createMockOpenAIClient>): any[] {
  return mock.mocks.create.mock.calls[0][0].messages;
}

describe('OpenAI adapter — RFC-0001 content blocks', () => {
  let mock: ReturnType<typeof createMockOpenAIClient>;

  beforeEach(() => {
    mock = createMockOpenAIClient();
    mock.mocks.create.mockResolvedValue(CHAT_OK);
  });

  // -------------------------------------------------------------------------
  // User image blocks → content parts
  // -------------------------------------------------------------------------
  describe('user image blocks', () => {
    it('maps a base64 image block to an image_url data URL content part', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const msg: Message = {
        role: 'user',
        content: 'look at this',
        blocks: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
        ],
      };
      await adapter.chat({ messages: [msg] });

      expect(sentMessages(mock)[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      });
    });

    it('maps a url image block to a direct image_url', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const msg: Message = {
        role: 'user',
        content: '',
        blocks: [{ type: 'image', source: { kind: 'url', url: 'https://ex.com/a.png' } }],
      };
      await adapter.chat({ messages: [msg] });

      expect(sentMessages(mock)[0]).toEqual({
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://ex.com/a.png' } }],
      });
    });

    it('preserves order across interleaved text and image blocks', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const msg: Message = {
        role: 'user',
        content: 'beforeafter',
        blocks: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { kind: 'url', url: 'https://ex.com/x.jpg' } },
          { type: 'text', text: 'after' },
        ],
      };
      await adapter.chat({ messages: [msg] });

      const parts = sentMessages(mock)[0].content;
      expect(parts.map((p: { type: string }) => p.type)).toEqual([
        'text',
        'image_url',
        'text',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // No-blocks / no-image fast path — plain string content shape unchanged
  // -------------------------------------------------------------------------
  describe('plain-string fast path', () => {
    it('keeps plain-string content when the user message has no blocks', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      await adapter.chat({ messages: [{ role: 'user', content: 'just text' }] });

      const sent = sentMessages(mock)[0];
      expect(sent).toEqual({ role: 'user', content: 'just text' });
      expect(typeof sent.content).toBe('string');
    });

    it('keeps plain-string content when the user message has only text blocks (no image)', async () => {
      const adapter = createOpenAIAdapter({ client: mock.client });
      const msg: Message = {
        role: 'user',
        content: 'hello world',
        blocks: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      };
      await adapter.chat({ messages: [msg] });

      const sent = sentMessages(mock)[0];
      expect(typeof sent.content).toBe('string');
      expect(sent.content).toBe('hello world');
    });
  });

  // -------------------------------------------------------------------------
  // Assistant thinking blocks → dropped + warn once
  // -------------------------------------------------------------------------
  describe('assistant thinking blocks', () => {
    it('drops thinking blocks (content is the text projection) and warns once', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const adapter = createOpenAIAdapter({ client: mock.client, logger });
      const messages: Message[] = [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'Answer',
          blocks: [
            { type: 'thinking', thinking: 'secret reasoning', signature: 'sig-1' },
            { type: 'text', text: 'Answer' },
          ],
        },
        { role: 'user', content: 'more' },
      ];
      await adapter.chat({ messages });

      // The assistant message goes out as plain text with no reasoning leaked.
      expect(sentMessages(mock)[1]).toEqual({ role: 'assistant', content: 'Answer' });
      expect(JSON.stringify(sentMessages(mock))).not.toContain('secret reasoning');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('reasoning blocks'),
      );
    });

    it('drops redacted_thinking blocks too, and still preserves tool calls', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const adapter = createOpenAIAdapter({ client: mock.client, logger });
      const messages: Message[] = [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'calling',
          blocks: [
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'calling' },
          ],
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{"q":"x"}' }],
        },
        { role: 'tool', content: 'result', toolCallId: 'tc-1' },
      ];
      await adapter.chat({ messages });

      const asst = sentMessages(mock)[1];
      expect(asst.role).toBe('assistant');
      expect(asst.tool_calls).toHaveLength(1);
      expect(asst.tool_calls[0].function.name).toBe('search');
      expect(JSON.stringify(asst)).not.toContain('opaque');
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('warns only once per adapter instance across multiple chat() calls', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const adapter = createOpenAIAdapter({ client: mock.client, logger });
      const thinkingTurn: Message = {
        role: 'assistant',
        content: 'A',
        blocks: [
          { type: 'thinking', thinking: 't', signature: 's' },
          { type: 'text', text: 'A' },
        ],
      };
      await adapter.chat({ messages: [{ role: 'user', content: '1' }, thinkingTurn] });
      await adapter.chat({ messages: [{ role: 'user', content: '2' }, thinkingTurn] });

      const thinkingWarns = logger.warn.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('reasoning blocks'),
      );
      expect(thinkingWarns).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tool-result images → text marker + warn once
  // -------------------------------------------------------------------------
  describe('tool-result image degradation', () => {
    const MARKER = '[image omitted: not representable in OpenAI tool results]';

    it('appends a text marker for a tool result image and warns once', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const adapter = createOpenAIAdapter({ client: mock.client, logger });
      const messages: Message[] = [
        { role: 'user', content: 'screenshot it' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'shot', arguments: '{}' }] },
        {
          role: 'tool',
          content: 'captured',
          toolCallId: 'tc-1',
          blocks: [
            { type: 'text', text: 'captured' },
            { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'ZZZ' } },
          ],
        },
      ];
      await adapter.chat({ messages });

      expect(sentMessages(mock)[2]).toEqual({
        role: 'tool',
        tool_call_id: 'tc-1',
        content: `captured\n${MARKER}`,
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('text-only'));
    });

    it('emits one marker per image and works with empty text content', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const adapter = createOpenAIAdapter({ client: mock.client, logger });
      const messages: Message[] = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'shot', arguments: '{}' }] },
        {
          role: 'tool',
          content: '',
          toolCallId: 'tc-1',
          blocks: [
            { type: 'image', source: { kind: 'url', url: 'https://ex.com/1.png' } },
            { type: 'image', source: { kind: 'url', url: 'https://ex.com/2.png' } },
          ],
        },
      ];
      await adapter.chat({ messages });

      expect(sentMessages(mock)[1].content).toBe(`${MARKER}\n${MARKER}`);
    });

    it('leaves text-only tool results untouched (no warn)', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const adapter = createOpenAIAdapter({ client: mock.client, logger });
      const messages: Message[] = [
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc-1', name: 'x', arguments: '{}' }] },
        { role: 'tool', content: 'plain result', toolCallId: 'tc-1' },
      ];
      await adapter.chat({ messages });

      expect(sentMessages(mock)[1]).toEqual({
        role: 'tool',
        tool_call_id: 'tc-1',
        content: 'plain result',
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // The two degrade warnings are independent keys
  // -------------------------------------------------------------------------
  it('warns separately for thinking-drop and tool-image degrade', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const adapter = createOpenAIAdapter({ client: mock.client, logger });
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'A',
        blocks: [
          { type: 'thinking', thinking: 't', signature: 's' },
          { type: 'text', text: 'A' },
        ],
        toolCalls: [{ id: 'tc-1', name: 'shot', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: 'r',
        toolCallId: 'tc-1',
        blocks: [
          { type: 'text', text: 'r' },
          { type: 'image', source: { kind: 'url', url: 'https://ex.com/a.png' } },
        ],
      },
    ];
    await adapter.chat({ messages });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    const joined = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(joined).toContain('reasoning blocks');
    expect(joined).toContain('text-only');
  });
});
