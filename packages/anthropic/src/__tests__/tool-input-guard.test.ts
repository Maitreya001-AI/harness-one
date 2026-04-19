/**
 * Guards against silent corruption of tool_use input when the LLM produces
 * non-object JSON (or invalid JSON). Previously the adapter cast the raw
 * string to Record<string, unknown>, which lied to the type system and caused
 * downstream tool handlers to see `undefined` for every field instead of
 * failing loudly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicAdapter } from '../index.js';

describe('Anthropic adapter tool_use input narrowing', () => {
  // Default logger writes redacted JSON lines to console.log (via
  // core's createDefaultLogger singleton), not console.warn.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function makeClient(): Anthropic {
    // Minimal stub; we only need messages.create for chat() and we won't call it
    // in these tests (we're exercising message transformation instead).
    return { messages: { create: vi.fn() } } as unknown as Anthropic;
  }

  it('adapter name is "anthropic:<model>"', () => {
    const adapter = createAnthropicAdapter({ client: makeClient(), model: 'claude-opus-4-5' });
    expect(adapter.name).toBe('anthropic:claude-opus-4-5');
  });

  it('tool_use input is a valid object when LLM returns valid JSON', async () => {
    const client = makeClient();
    const create = vi.mocked(client.messages.create);
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message);

    const adapter = createAnthropicAdapter({ client });
    await adapter.chat({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'search', arguments: '{"q":"hello"}' }],
        },
      ],
    });

    const callArgs = create.mock.calls[0][0] as Record<string, unknown>;
    const assistantMsg = (callArgs.messages as Array<{ role: string; content: unknown }>)[1];
    const toolUse = (assistantMsg.content as Array<{ type: string; input: unknown }>)[0];
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.input).toEqual({ q: 'hello' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('tool_use input falls back to empty object on invalid JSON (with warning)', async () => {
    const client = makeClient();
    const create = vi.mocked(client.messages.create);
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message);

    const adapter = createAnthropicAdapter({ client });
    await adapter.chat({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-2', name: 'search', arguments: '{incomplete' }],
        },
      ],
    });

    const callArgs = create.mock.calls[0][0] as Record<string, unknown>;
    const assistantMsg = (callArgs.messages as Array<{ role: string; content: unknown }>)[1];
    const toolUse = (assistantMsg.content as Array<{ type: string; input: unknown }>)[0];
    expect(toolUse.input).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not valid JSON'),
    );
  });

  it('tool_use input falls back to empty object when JSON is not an object (array, string, null)', async () => {
    const client = makeClient();
    const create = vi.mocked(client.messages.create);
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message);

    const adapter = createAnthropicAdapter({ client });
    for (const bogus of ['"just-a-string"', '[1,2,3]', 'null', '42']) {
      await adapter.chat({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: `tc-${bogus}`, name: 'search', arguments: bogus }],
          },
        ],
      });
    }

    // Every call must have substituted an empty object
    for (const call of create.mock.calls) {
      const msg = (call[0] as { messages: Array<{ role: string; content: unknown }> }).messages[1];
      const toolUse = (msg.content as Array<{ type: string; input: unknown }>)[0];
      expect(toolUse.input).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
