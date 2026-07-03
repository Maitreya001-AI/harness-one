/**
 * Anthropic adapter opt-in prompt caching (C3).
 *
 * `convert.ts` builds content blocks with no `cache_control`, so Anthropic
 * prompt caching never activates and `cacheReadTokens` / `cacheWriteTokens`
 * stay 0. The `promptCaching` config option opts in to `cache_control`
 * breakpoints:
 *   - `system: true`      → the system prompt becomes a content-block array
 *     with `cache_control: { type: 'ephemeral' }` on the last (only) block.
 *   - `lastMessage: true` → the last content block of the final message gets
 *     a `cache_control` breakpoint, making the whole conversation prefix
 *     cacheable in an agent loop.
 *
 * Default (option omitted) is OFF — the request shape is byte-for-byte
 * unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAnthropicAdapter } from '../index.js';
import type { AnthropicAdapterConfig } from '../index.js';
import type { Message } from 'harness-one/core';

const EPHEMERAL = { type: 'ephemeral' };

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

function createMockStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: vi.fn().mockResolvedValue({ usage: { input_tokens: 1, output_tokens: 1 } }),
  };
}

const SYS_AND_USER: Message[] = [
  { role: 'system', content: 'You are helpful' },
  { role: 'user', content: 'Hi' },
];

describe('Anthropic adapter: prompt caching', () => {
  let mock: ReturnType<typeof createMockAnthropicClient>;

  beforeEach(() => {
    mock = createMockAnthropicClient();
    mock.mocks.create.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  function bodyOf(): Record<string, unknown> {
    return mock.mocks.create.mock.calls[0][0] as Record<string, unknown>;
  }

  describe('off by default', () => {
    it('emits a plain string system and string message content (no cache_control)', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client });
      await adapter.chat({ messages: SYS_AND_USER });

      const body = bodyOf();
      expect(body.system).toBe('You are helpful');
      const messages = body.messages as Array<{ content: unknown }>;
      expect(messages[0].content).toBe('Hi');
      // No cache_control anywhere in the serialized request.
      expect(JSON.stringify(body)).not.toContain('cache_control');
    });

    it('is off when promptCaching is an empty object', async () => {
      const adapter = createAnthropicAdapter({ client: mock.client, promptCaching: {} });
      await adapter.chat({ messages: SYS_AND_USER });
      expect(JSON.stringify(bodyOf())).not.toContain('cache_control');
    });
  });

  describe('system: true', () => {
    it('emits the system prompt as a cacheable content-block array', async () => {
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { system: true },
      });
      await adapter.chat({ messages: SYS_AND_USER });

      const body = bodyOf();
      expect(body.system).toEqual([
        { type: 'text', text: 'You are helpful', cache_control: EPHEMERAL },
      ]);
      // The last message stays a plain string (lastMessage caching is off).
      const messages = body.messages as Array<{ content: unknown }>;
      expect(messages[0].content).toBe('Hi');
    });

    it('caches the composed system when combined with responseFormat', async () => {
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { system: true },
      });
      await adapter.chat({
        messages: SYS_AND_USER,
        responseFormat: { type: 'json_object' },
      });

      const system = bodyOf().system as Array<{ text: string; cache_control: unknown }>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toBe('You are helpful\n\nRespond with a single JSON object.');
      expect(system[0].cache_control).toEqual(EPHEMERAL);
    });

    it('emits no system field when there is no system message', async () => {
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { system: true },
      });
      await adapter.chat({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(bodyOf().system).toBeUndefined();
    });
  });

  describe('lastMessage: true', () => {
    it('promotes a trailing string message to a cacheable text block', async () => {
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { lastMessage: true },
      });
      await adapter.chat({ messages: SYS_AND_USER });

      const body = bodyOf();
      // System caching is off → plain string.
      expect(body.system).toBe('You are helpful');
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'Hi', cache_control: EPHEMERAL },
      ]);
    });

    it('marks the last block of a trailing content-array message', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          content: 'Searching...',
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{"q":"test"}' }],
        },
      ];
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { lastMessage: true },
      });
      await adapter.chat({ messages });

      const outMessages = bodyOf().messages as Array<{ content: Array<Record<string, unknown>> }>;
      const lastBlocks = outMessages[outMessages.length - 1].content;
      // text block untouched, tool_use (last) block carries the breakpoint.
      expect(lastBlocks[0].cache_control).toBeUndefined();
      expect(lastBlocks[lastBlocks.length - 1]).toMatchObject({
        type: 'tool_use',
        cache_control: EPHEMERAL,
      });
    });

    it('leaves the system prompt uncached', async () => {
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { lastMessage: true },
      });
      await adapter.chat({ messages: SYS_AND_USER });
      expect(typeof bodyOf().system).toBe('string');
    });
  });

  describe('both breakpoints', () => {
    it('sets cache_control on both the system prompt and the last message', async () => {
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { system: true, lastMessage: true },
      });
      await adapter.chat({ messages: SYS_AND_USER });

      const body = bodyOf();
      expect(body.system).toEqual([
        { type: 'text', text: 'You are helpful', cache_control: EPHEMERAL },
      ]);
      const messages = body.messages as Array<{ content: unknown }>;
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'Hi', cache_control: EPHEMERAL },
      ]);
      // At most two breakpoints — well under Anthropic's cap of four.
      const count = (JSON.stringify(body).match(/cache_control/g) ?? []).length;
      expect(count).toBe(2);
    });
  });

  describe('streaming path', () => {
    it('applies the same breakpoints to stream() requests', async () => {
      mock.mocks.stream.mockReturnValue(
        createMockStream([
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } },
        ]),
      );
      const adapter = createAnthropicAdapter({
        client: mock.client,
        promptCaching: { system: true, lastMessage: true },
      });
      for await (const _c of adapter.stream!({ messages: SYS_AND_USER })) {
        /* consume */
      }

      const body = mock.mocks.stream.mock.calls[0][0] as Record<string, unknown>;
      expect(body.system).toEqual([
        { type: 'text', text: 'You are helpful', cache_control: EPHEMERAL },
      ]);
      const messages = body.messages as Array<{ content: unknown }>;
      expect(messages[0].content).toEqual([
        { type: 'text', text: 'Hi', cache_control: EPHEMERAL },
      ]);
    });
  });
});
