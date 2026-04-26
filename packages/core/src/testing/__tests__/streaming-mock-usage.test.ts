/**
 * Tests for the createStreamingMockAdapter usage-propagation contract
 * (showcase 01 FRICTION_LOG: 'createStreamingMockAdapter doesn't
 * auto-attach usage to done').
 */
import { describe, it, expect } from 'vitest';
import { createStreamingMockAdapter } from '../test-utils.js';
import type { StreamChunk, TokenUsage } from '../../core/types.js';

const PARAMS = { messages: [], model: 'm' };

async function consume(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe('createStreamingMockAdapter — usage propagation', () => {
  it('throws at construction when terminal done has no usage AND config.usage is missing', () => {
    expect(() =>
      createStreamingMockAdapter({
        chunks: [
          { type: 'text_delta', text: 'hi' },
          { type: 'done', reason: 'end_turn' },
        ],
      }),
    ).toThrow(/no `usage`/);
  });

  it('auto-attaches config.usage to the terminal done when the chunk omits it', async () => {
    const usage: TokenUsage = { inputTokens: 7, outputTokens: 3 };
    const adapter = createStreamingMockAdapter({
      usage,
      chunks: [
        { type: 'text_delta', text: 'x' },
        { type: 'done', reason: 'end_turn' },
      ],
    });
    const out = await consume(adapter.stream!(PARAMS));
    const done = out.find((c) => c.type === 'done') as StreamChunk & { usage?: TokenUsage };
    expect(done.usage).toEqual(usage);
  });

  it('does NOT overwrite per-chunk usage even when config.usage is set', async () => {
    const adapter = createStreamingMockAdapter({
      usage: { inputTokens: 99, outputTokens: 99 },
      chunks: [
        { type: 'text_delta', text: 'x' },
        { type: 'done', reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } },
      ],
    });
    const out = await consume(adapter.stream!(PARAMS));
    const done = out.find((c) => c.type === 'done') as StreamChunk & { usage?: TokenUsage };
    expect(done.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('chat() returns the same effective usage value', async () => {
    const usage: TokenUsage = { inputTokens: 7, outputTokens: 3 };
    const adapter = createStreamingMockAdapter({
      usage,
      chunks: [
        { type: 'text_delta', text: 'hi' },
        { type: 'done', reason: 'end_turn' },
      ],
    });
    const response = await adapter.chat(PARAMS);
    expect(response.usage).toEqual(usage);
  });

  it('chat() prefers per-chunk usage when present', async () => {
    const adapter = createStreamingMockAdapter({
      usage: { inputTokens: 999, outputTokens: 999 },
      chunks: [
        { type: 'done', reason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } },
      ],
    });
    const response = await adapter.chat(PARAMS);
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it('does not throw when the chunks list has no done chunk at all', () => {
    // Permitted: some tests model truncated streams or partial output.
    expect(() =>
      createStreamingMockAdapter({
        chunks: [{ type: 'text_delta', text: 'never finishes' }],
      }),
    ).not.toThrow();
  });

  it('passes non-done chunks through verbatim', async () => {
    const adapter = createStreamingMockAdapter({
      usage: { inputTokens: 1, outputTokens: 1 },
      chunks: [
        { type: 'text_delta', text: 'a' },
        { type: 'text_delta', text: 'b' },
        { type: 'done', reason: 'end_turn' },
      ],
    });
    const out = await consume(adapter.stream!(PARAMS));
    expect(out[0]).toEqual({ type: 'text_delta', text: 'a' });
    expect(out[1]).toEqual({ type: 'text_delta', text: 'b' });
  });

  it('records call params on both chat() and stream()', async () => {
    const adapter = createStreamingMockAdapter({
      usage: { inputTokens: 1, outputTokens: 1 },
      chunks: [{ type: 'done', reason: 'end_turn' }],
    });
    await adapter.chat(PARAMS);
    expect(adapter.calls).toHaveLength(1);
    await consume(adapter.stream!(PARAMS));
    expect(adapter.calls).toHaveLength(2);
  });
});
