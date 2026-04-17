/**
 * Wave-13 Track H — Anthropic adapter fixes.
 *
 * Covers:
 *  - H-1: 'throw' policy preview uses head+tail for payloads over 400 chars.
 *  - H-2: onMalformedToolUse callback semantics: null → empty object,
 *         undefined → defer to default 'throw' policy.
 */

import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicAdapter } from '../index.js';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';

function makeClient(): Anthropic {
  return { messages: { create: vi.fn() } } as unknown as Anthropic;
}

function okResponse(): Anthropic.Message {
  return {
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

// ---------------------------------------------------------------------------
// H-1: throw preview uses head+tail for long raw strings
// ---------------------------------------------------------------------------

describe('Wave-13 H-1: onMalformedToolUse throw preview shows head + tail', () => {
  it('short raw (<400 chars) preview is the raw string verbatim', async () => {
    const client = makeClient();
    vi.mocked(client.messages.create).mockResolvedValue(okResponse());
    const adapter = createAnthropicAdapter({ client, onMalformedToolUse: 'throw' });

    try {
      await adapter.chat({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-short', name: 'search', arguments: 'not-json' }],
          },
        ],
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      const he = err as HarnessError;
      expect(he.code).toBe(HarnessErrorCode.ADAPTER_ERROR);
      // Short path: preview contains the raw string as-is, and no " ... " delimiter.
      expect(he.message).toContain('not-json');
    }
  });

  it('long raw (>400 chars) preview contains a head + " ... " + tail', async () => {
    const client = makeClient();
    vi.mocked(client.messages.create).mockResolvedValue(okResponse());
    const adapter = createAnthropicAdapter({ client, onMalformedToolUse: 'throw' });

    // Construct 600 chars: 200 'H' + 200 'M' + 200 'T'. The head will show
    // 'HHH...', the tail will show 'TTT...', but never any 'M' (middle).
    const head = 'H'.repeat(200);
    const middle = 'M'.repeat(200);
    const tail = 'T'.repeat(200);
    const arg = head + middle + tail;

    try {
      await adapter.chat({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-long', name: 'search', arguments: arg }],
          },
        ],
      });
      throw new Error('should have thrown');
    } catch (err) {
      const he = err as HarnessError;
      expect(he.message).toContain(head.slice(0, 200));
      expect(he.message).toContain(tail.slice(-200));
      expect(he.message).toContain(' ... ');
      // Tail of the raw is now observable — regression sentinel for the
      // head-only truncation that Wave-13 H-1 replaced.
      expect(he.message).toContain('TTT');
      // Middle is not shown.
      expect(he.message).not.toContain(middle);
      expect(he.message).toContain('length=600');
    }
  });

  it('boundary: exactly 400 chars uses head-only (not head+tail)', async () => {
    const client = makeClient();
    vi.mocked(client.messages.create).mockResolvedValue(okResponse());
    const adapter = createAnthropicAdapter({ client, onMalformedToolUse: 'throw' });

    const arg = 'X'.repeat(400);

    try {
      await adapter.chat({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-boundary', name: 'search', arguments: arg }],
          },
        ],
      });
      throw new Error('should have thrown');
    } catch (err) {
      const he = err as HarnessError;
      // 400 is NOT > 400, so no "  ...  " delimiter.
      expect(he.message).not.toContain(' ... ');
    }
  });
});

// ---------------------------------------------------------------------------
// H-2: onMalformedToolUse null vs undefined semantics
// ---------------------------------------------------------------------------

describe('Wave-13 H-2: onMalformedToolUse callback null vs undefined', () => {
  it('returning null produces the empty-object fallback (no throw)', async () => {
    const client = makeClient();
    const create = vi.mocked(client.messages.create);
    create.mockResolvedValue(okResponse());
    const callback = vi.fn((_raw: string, _err: Error) => null);
    const adapter = createAnthropicAdapter({ client, onMalformedToolUse: callback });

    await adapter.chat({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-null', name: 'search', arguments: 'not-json' }],
        },
      ],
    });

    expect(callback).toHaveBeenCalledOnce();
    const callArgs = create.mock.calls[0]?.[0] as { messages: Array<{ content: Array<{ input: unknown }> }> };
    const assistantMsg = callArgs.messages[1];
    const toolUse = assistantMsg?.content[0];
    // Empty object (no enumerable keys).
    expect(toolUse?.input).toEqual({});
  });

  it('returning an object substitutes it verbatim', async () => {
    const client = makeClient();
    const create = vi.mocked(client.messages.create);
    create.mockResolvedValue(okResponse());
    const callback = vi.fn((_raw: string, _err: Error) => ({ recovered: true }));
    const adapter = createAnthropicAdapter({ client, onMalformedToolUse: callback });

    await adapter.chat({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-obj', name: 'search', arguments: 'not-json' }],
        },
      ],
    });

    expect(callback).toHaveBeenCalledOnce();
    const callArgs = create.mock.calls[0]?.[0] as { messages: Array<{ content: Array<{ input: unknown }> }> };
    const toolUse = callArgs.messages[1]?.content[0];
    expect(toolUse?.input).toEqual({ recovered: true });
  });

  it('returning undefined defers to the default throw policy', async () => {
    const client = makeClient();
    vi.mocked(client.messages.create).mockResolvedValue(okResponse());
    // Callback explicitly returns undefined — per Wave-13 H-2 this means
    // "I couldn't decide; throw as if the policy were 'throw'".
    const callback = vi.fn((_raw: string, _err: Error): Record<string, unknown> | null | undefined => undefined);
    const adapter = createAnthropicAdapter({ client, onMalformedToolUse: callback });

    try {
      await adapter.chat({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-undef', name: 'search', arguments: 'not-json' }],
          },
        ],
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      const he = err as HarnessError;
      expect(he.code).toBe(HarnessErrorCode.ADAPTER_ERROR);
      expect(he.message).toContain('returned undefined');
      expect(callback).toHaveBeenCalledOnce();
    }
  });
});
