/**
 * Anthropic adapter RFC-0001 content blocks: extended-thinking + image
 * round-trip and streaming (Task #12).
 *
 * Covers:
 *   - Response parsing (chat): thinking / redacted_thinking → Message.blocks,
 *     text projection invariant (content === blocksText(blocks)).
 *   - Verbatim replay (toAnthropicMessage): assistant blocks replayed with
 *     signatures intact, thinking before tool_use.
 *   - Images: user messages + tool results carrying base64 / url images.
 *   - Streaming: thinking_delta / signature_delta / redacted_thinking events.
 *   - Interaction with promptCaching.lastMessage (cache_control skips thinking).
 *   - The `thinking` adapter option request shape + maxTokens validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import type { Message, StreamChunk } from 'harness-one/core';
import { HarnessError, HarnessErrorCode, blocksText } from 'harness-one/core';

function createMockAnthropicClient() {
  const createFn = vi.fn();
  const streamFn = vi.fn();
  return {
    client: {
      messages: { create: createFn, stream: streamFn },
    } as unknown as AnthropicAdapterConfig['client'],
    mocks: { create: createFn, stream: streamFn },
  };
}

function createMockStream(events: unknown[], usage = { input_tokens: 10, output_tokens: 5 }) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: vi.fn().mockResolvedValue({ usage }),
  };
}

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('Anthropic adapter: content blocks (RFC-0001)', () => {
  let mock: ReturnType<typeof createMockAnthropicClient>;

  beforeEach(() => {
    mock = createMockAnthropicClient();
  });

  // ---- Response parsing (chat) --------------------------------------------
  describe('response parsing', () => {
    it('parses thinking + text into Message.blocks with the text projection', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'let me reason', signature: 'sig-abc' },
          { type: 'text', text: 'The answer is 42.' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const adapter = createAnthropicAdapter({ client: mock.client });
      const { message } = await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });

      expect(message.content).toBe('The answer is 42.');
      expect(message.blocks).toEqual([
        { type: 'thinking', thinking: 'let me reason', signature: 'sig-abc' },
        { type: 'text', text: 'The answer is 42.' },
      ]);
      // Text-projection invariant.
      expect(blocksText(message.blocks!)).toBe(message.content);
    });

    it('parses a thinking block without a signature', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'ok' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const adapter = createAnthropicAdapter({ client: mock.client });
      const { message } = await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });
      expect(message.blocks![0]).toEqual({ type: 'thinking', thinking: 'hmm' });
      expect('signature' in (message.blocks![0] as object)).toBe(false);
    });

    it('parses redacted_thinking blocks', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [
          { type: 'redacted_thinking', data: 'opaque==' },
          { type: 'text', text: 'done' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const adapter = createAnthropicAdapter({ client: mock.client });
      const { message } = await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });
      expect(message.blocks).toEqual([
        { type: 'redacted_thinking', data: 'opaque==' },
        { type: 'text', text: 'done' },
      ]);
    });

    it('parses thinking + tool_use (blocks + toolCalls together)', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'need a tool', signature: 's1' },
          { type: 'tool_use', id: 'tc-1', name: 'search', input: { q: 'x' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const adapter = createAnthropicAdapter({ client: mock.client });
      const { message } = await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });

      // No text → no text block; blocks = [thinking] only.
      expect(message.content).toBe('');
      expect(message.blocks).toEqual([{ type: 'thinking', thinking: 'need a tool', signature: 's1' }]);
      expect(message.toolCalls).toHaveLength(1);
      expect(message.toolCalls![0].id).toBe('tc-1');
    });

    it('leaves plain text responses block-free (no regression)', async () => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'plain' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const adapter = createAnthropicAdapter({ client: mock.client });
      const { message } = await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });
      expect(message.blocks).toBeUndefined();
      expect(message.content).toBe('plain');
    });
  });

  // ---- Verbatim replay (toAnthropicMessage) -------------------------------
  describe('verbatim replay', () => {
    beforeEach(() => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    function sentMessages(): Array<{ role: string; content: unknown }> {
      return mock.mocks.create.mock.calls[0][0].messages;
    }

    it('replays assistant thinking + text blocks verbatim (signature intact)', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: 'answer',
          blocks: [
            { type: 'thinking', thinking: 'reasoning', signature: 'sig-xyz' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'user', content: 'follow-up' },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[1].content).toEqual([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-xyz' },
        { type: 'text', text: 'answer' },
      ]);
    });

    it('replays thinking BEFORE tool_use blocks', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: '',
          blocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }],
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{"q":"y"}' }],
        },
        { role: 'tool', content: 'result', toolCallId: 'tc-1' },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[1].content).toEqual([
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'tool_use', id: 'tc-1', name: 'search', input: { q: 'y' } },
      ]);
    });

    it('replays redacted_thinking blocks verbatim', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: 'x',
          blocks: [
            { type: 'redacted_thinking', data: 'REDACTED==' },
            { type: 'text', text: 'x' },
          ],
        },
        { role: 'user', content: 'more' },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[1].content).toEqual([
        { type: 'redacted_thinking', data: 'REDACTED==' },
        { type: 'text', text: 'x' },
      ]);
    });

    it('round-trips a parsed response back to the provider unchanged', async () => {
      // Parse a thinking+text+tool response, then replay it.
      mock.mocks.create.mockResolvedValueOnce({
        content: [
          { type: 'thinking', thinking: 'r', signature: 'S' },
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tc-9', name: 'f', input: { a: 1 } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const adapter = createAnthropicAdapter({ client: mock.client });
      const { message } = await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });

      await adapter.chat({ messages: [{ role: 'user', content: 'Q' }, message, { role: 'tool', content: 'r', toolCallId: 'tc-9' }] });
      const replayed = mock.mocks.create.mock.calls[1][0].messages[1].content;
      expect(replayed).toEqual([
        { type: 'thinking', thinking: 'r', signature: 'S' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tc-9', name: 'f', input: { a: 1 } },
      ]);
    });
  });

  // ---- Images -------------------------------------------------------------
  describe('images', () => {
    beforeEach(() => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    function sentMessages(): Array<{ role: string; content: unknown }> {
      return mock.mocks.create.mock.calls[0][0].messages;
    }

    it('maps a user message with text + base64 image blocks', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: 'look at this',
          blocks: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
          ],
        },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[0].content).toEqual([
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]);
    });

    it('maps a url image source', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: '',
          blocks: [{ type: 'image', source: { kind: 'url', url: 'https://ex.com/i.png' } }],
        },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[0].content).toEqual([
        { type: 'image', source: { type: 'url', url: 'https://ex.com/i.png' } },
      ]);
    });

    it('maps a tool result with text + image into a tool_result content array', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'screenshot the page' },
        {
          role: 'tool',
          content: 'screenshot captured',
          toolCallId: 'tc-1',
          blocks: [
            { type: 'text', text: 'screenshot captured' },
            { type: 'image', source: { kind: 'base64', mediaType: 'image/jpeg', data: 'BBBB' } },
          ],
        },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[1].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'tc-1',
          content: [
            { type: 'text', text: 'screenshot captured' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
          ],
        },
      ]);
    });

    it('keeps the string projection for a tool result with no image blocks', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'go' },
        { role: 'tool', content: 'plain result', toolCallId: 'tc-1' },
      ];
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages });

      expect(sentMessages()[1].content).toEqual([
        { type: 'tool_result', tool_use_id: 'tc-1', content: 'plain result' },
      ]);
    });
  });

  // ---- Streaming ----------------------------------------------------------
  describe('streaming thinking', () => {
    it('emits thinking_delta and signature chunks in order', async () => {
      mock.mocks.stream.mockReturnValue(
        createMockStream([
          { type: 'content_block_start', content_block: { type: 'thinking' } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'step 1 ' } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'step 2' } },
          { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig-final' } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
        ]),
      );
      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks = await drain(adapter.stream!({ messages: [{ role: 'user', content: 'Q' }] }));

      const thinking = chunks.filter((c) => c.type === 'thinking_delta');
      // 2 thinking fragments + 1 signature.
      expect(thinking.map((c) => c.thinking)).toEqual(['step 1 ', 'step 2', undefined]);
      expect(thinking[2].signature).toBe('sig-final');
      // Text still flows.
      expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text)).toEqual(['answer']);
    });

    it('emits a redactedData thinking_delta from a redacted_thinking start block', async () => {
      mock.mocks.stream.mockReturnValue(
        createMockStream([
          { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'ENC==' } },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        ]),
      );
      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks = await drain(adapter.stream!({ messages: [{ role: 'user', content: 'Q' }] }));

      const redacted = chunks.filter(
        (c) => c.type === 'thinking_delta' && (c as { redactedData?: string }).redactedData !== undefined,
      );
      expect(redacted).toHaveLength(1);
      expect((redacted[0] as { redactedData?: string }).redactedData).toBe('ENC==');
    });

    it('does not disturb tool-call streaming when thinking precedes it', async () => {
      mock.mocks.stream.mockReturnValue(
        createMockStream([
          { type: 'content_block_start', content_block: { type: 'thinking' } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'plan' } },
          { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tc-1', name: 'search' } },
          { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q":"z"}' } },
        ]),
      );
      const adapter = createAnthropicAdapter({ client: mock.client });
      const chunks = await drain(adapter.stream!({ messages: [{ role: 'user', content: 'Q' }] }));

      const tool = chunks.filter((c) => c.type === 'tool_call_delta');
      expect(tool).toHaveLength(1);
      expect(tool[0].toolCall!.id).toBe('tc-1');
      expect(tool[0].toolCall!.arguments).toBe('{"q":"z"}');
    });
  });

  // ---- thinking option: request shape + validation ------------------------
  describe('thinking option', () => {
    beforeEach(() => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    it('sends thinking: { type: enabled, budget_tokens } on chat()', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client, thinking: { budgetTokens: 2000 } });
      await adapter.chat({ messages: [{ role: 'user', content: 'Q' }], config: { maxTokens: 8000 } });
      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
    });

    it('sends thinking on stream() too', async () => {
      mock.mocks.stream.mockReturnValue(createMockStream([]));
      const adapter = createAnthropicAdapter({ client: mock.client, thinking: { budgetTokens: 1024 } });
      await drain(adapter.stream!({ messages: [{ role: 'user', content: 'Q' }], config: { maxTokens: 4096 } }));
      const body = mock.mocks.stream.mock.calls[0][0] as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    });

    it('omits thinking entirely when the option is not set (off by default)', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages: [{ role: 'user', content: 'Q' }] });
      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect('thinking' in body).toBe(false);
    });

    it('throws CORE_INVALID_CONFIG when maxTokens <= budgetTokens (before any network call)', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client, thinking: { budgetTokens: 5000 } });
      await expect(
        adapter.chat({ messages: [{ role: 'user', content: 'Q' }], config: { maxTokens: 4096 } }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.CORE_INVALID_CONFIG });
      expect(mock.mocks.create).not.toHaveBeenCalled();
    });

    it('the validation error is a HarnessError with an actionable suggestion', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client, thinking: { budgetTokens: 5000 } });
      try {
        await adapter.chat({ messages: [{ role: 'user', content: 'Q' }], config: { maxTokens: 5000 } });
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).suggestion).toMatch(/maxTokens/);
      }
    });

    it('does not validate when maxTokens is unset (default applies)', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client, thinking: { budgetTokens: 1000 } });
      await expect(adapter.chat({ messages: [{ role: 'user', content: 'Q' }] })).resolves.toBeDefined();
      const body = mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1000 });
    });
  });

  // ---- thinking + promptCaching interaction -------------------------------
  describe('thinking + promptCaching.lastMessage', () => {
    beforeEach(() => {
      mock.mocks.create.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    it('places the cache breakpoint on the last NON-thinking block', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: 'answer',
          blocks: [
            { type: 'thinking', thinking: 'reason', signature: 'S' },
            { type: 'text', text: 'answer' },
          ],
        },
      ];
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { lastMessage: true },
      });
      await adapter.chat({ messages });

      const last = mock.mocks.create.mock.calls[0][0].messages[1].content as Array<Record<string, unknown>>;
      // thinking block untouched; text block (last non-thinking) carries it.
      expect(last[0].cache_control).toBeUndefined();
      expect(last[1]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    });

    it('emits no breakpoint when the last message is all thinking blocks', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Q' },
        {
          role: 'assistant',
          content: '',
          blocks: [{ type: 'thinking', thinking: 'only reasoning', signature: 'S' }],
        },
      ];
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { lastMessage: true },
      });
      await adapter.chat({ messages });

      const body = mock.mocks.create.mock.calls[0][0];
      expect(JSON.stringify(body)).not.toContain('cache_control');
    });
  });
});
