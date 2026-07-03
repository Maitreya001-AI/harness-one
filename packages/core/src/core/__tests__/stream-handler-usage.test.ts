/**
 * StreamHandler usage-fallback contract.
 *
 * A streaming adapter that never reports usage (no terminal `done` chunk,
 * or a zeroed one) previously left `usage = {0, 0}`, so the loop's
 * cumulative `maxTotalTokens` budget could never trip — silently
 * unenforceable. The handler now estimates via the token-estimator
 * heuristic (provider-spec: "estimate rather than report zeros") and
 * yields a warning event so the adapter bug is visible.
 */

import { describe, it, expect } from 'vitest';
import { createStreamHandler } from '../stream-handler.js';
import type { StreamResult } from '../stream-handler.js';
import { createTokenizerRegistry } from '../../infra/token-estimator.js';
import type { AgentAdapter, Message, StreamChunk, TokenUsage } from '../types.js';
import type { AgentEvent } from '../events.js';

const LIMITS = {
  maxStreamBytes: 1024 * 1024,
  maxToolArgBytes: 1024 * 1024,
  maxCumulativeStreamBytes: 10 * 1024 * 1024,
} as const;

function streamingAdapter(chunks: StreamChunk[], name = 'mock:streamer'): AgentAdapter {
  return {
    name,
    chat: async () => {
      throw new Error('chat() not used in these tests');
    },
     
    stream: async function* () {
      yield* chunks;
    },
  };
}

async function drainWithReturn(
  gen: AsyncGenerator<AgentEvent, StreamResult>,
): Promise<{ events: AgentEvent[]; result: StreamResult }> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

const CONVERSATION: readonly Message[] = [
  { role: 'user', content: 'Summarise the design document in two sentences.' },
];

describe('StreamHandler usage fallback', () => {
  it('estimates usage and warns when the stream has no done chunk', async () => {
    const handler = createStreamHandler({
      adapter: streamingAdapter([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
      ]),
      signal: new AbortController().signal,
      ...LIMITS,
    });

    const { events, result } = await drainWithReturn(handler.handle(CONVERSATION, 0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    }
    const warnings = events.filter(
      (e) => e.type === 'warning' && /reported no token usage/i.test(e.message),
    );
    expect(warnings).toHaveLength(1);
  });

  it('estimates usage and warns when the done chunk carries zeroed usage', async () => {
    const zeroUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const handler = createStreamHandler({
      adapter: streamingAdapter([
        { type: 'text_delta', text: 'Hi' },
        { type: 'done', usage: zeroUsage },
      ]),
      signal: new AbortController().signal,
      ...LIMITS,
    });

    const { events, result } = await drainWithReturn(handler.handle(CONVERSATION, 0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    }
    expect(events.some((e) => e.type === 'warning' && /estimated/i.test(e.message))).toBe(true);
  });

  it('passes real adapter usage through untouched, with no warning', async () => {
    const realUsage: TokenUsage = { inputTokens: 42, outputTokens: 17 };
    const handler = createStreamHandler({
      adapter: streamingAdapter([
        { type: 'text_delta', text: 'Hi' },
        { type: 'done', usage: realUsage },
      ]),
      signal: new AbortController().signal,
      ...LIMITS,
    });

    const { events, result } = await drainWithReturn(handler.handle(CONVERSATION, 0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual(realUsage);
    }
    expect(events.some((e) => e.type === 'warning' && /token usage/i.test(e.message))).toBe(false);
  });

  it('respects partially-reported usage (only one side zero) without estimating', async () => {
    // An adapter reporting inputTokens but a legitimately-zero output (e.g.
    // an empty completion) must not be second-guessed.
    const partial: TokenUsage = { inputTokens: 10, outputTokens: 0 };
    const handler = createStreamHandler({
      adapter: streamingAdapter([{ type: 'done', usage: partial }]),
      signal: new AbortController().signal,
      ...LIMITS,
    });

    const { events, result } = await drainWithReturn(handler.handle(CONVERSATION, 0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual(partial);
    }
    expect(events.some((e) => e.type === 'warning' && /token usage/i.test(e.message))).toBe(false);
  });

  it('includes tool-call arguments in the output estimate', async () => {
    const withToolCall = createStreamHandler({
      adapter: streamingAdapter([
        {
          type: 'tool_call_delta',
          toolCall: { id: 'tc-1', name: 'search', arguments: '{"query":"a very long query string to inflate the estimate"}' },
        },
      ]),
      signal: new AbortController().signal,
      ...LIMITS,
    });
    const bare = createStreamHandler({
      adapter: streamingAdapter([]),
      signal: new AbortController().signal,
      ...LIMITS,
    });

    const withTool = await drainWithReturn(withToolCall.handle(CONVERSATION, 0));
    const withoutTool = await drainWithReturn(bare.handle(CONVERSATION, 0));

    expect(withTool.result.ok && withoutTool.result.ok).toBe(true);
    if (withTool.result.ok && withoutTool.result.ok) {
      expect(withTool.result.usage.outputTokens).toBeGreaterThan(
        withoutTool.result.usage.outputTokens,
      );
    }
  });

  it('uses an injected tokenizerRegistry for the fallback estimate (B7)', async () => {
    // Register a tokenizer under the adapter name (the model used for the
    // estimate) that returns a fixed length, so the fallback is deterministic
    // and provably routed through the injected registry, not the global one.
    const reg = createTokenizerRegistry();
    reg.register('mock:streamer', { encode: () => ({ length: 7 }) });
    const handler = createStreamHandler({
      adapter: streamingAdapter([{ type: 'text_delta', text: 'Hello' }]),
      signal: new AbortController().signal,
      tokenizerRegistry: reg,
      ...LIMITS,
    });

    const { result } = await drainWithReturn(handler.handle(CONVERSATION, 0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.inputTokens).toBe(7);
      expect(result.usage.outputTokens).toBe(7);
    }
  });
});
