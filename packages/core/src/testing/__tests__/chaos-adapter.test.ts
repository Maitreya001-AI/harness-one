/**
 * Unit tests for the chaos adapter.
 *
 * Each fault mode has a dedicated test proving the injection actually
 * happens. These tests are deliberately mechanical — the correctness
 * proof for aggregate invariants lives in `packages/core/tests/chaos/`.
 */
import { describe, it, expect } from 'vitest';
import { createChaosAdapter } from '../chaos/chaos-adapter.js';
import { createSeededRng } from '../chaos/prng.js';
import {
  createMockAdapter,
  createStreamingMockAdapter,
} from '../test-utils.js';
import type { AgentAdapter, ChatParams } from '../../core/types.js';

describe('createSeededRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('differs across seeds', () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    expect(a.next()).not.toEqual(b.next());
  });

  it('chance(0) never returns true; chance(1) always returns true', () => {
    const rng = createSeededRng(5);
    for (let i = 0; i < 50; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('chance(p) converges toward p over many samples', () => {
    const rng = createSeededRng(99);
    const N = 5000;
    let hits = 0;
    for (let i = 0; i < N; i++) if (rng.chance(0.3)) hits++;
    const ratio = hits / N;
    expect(ratio).toBeGreaterThan(0.27);
    expect(ratio).toBeLessThan(0.33);
  });
});

describe('createChaosAdapter · pre-call error injection', () => {
  it('injects 429 when errorRate[429] = 1', async () => {
    const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
    const chaos = createChaosAdapter(inner, { seed: 1, errorRate: { 429: 1 } });
    await expect(chaos.chat({ messages: [] })).rejects.toThrow(/429/);
    expect(chaos.recorder.count('error-429')).toBe(1);
    expect(inner.calls).toHaveLength(0);
  });

  it('injects 503 when errorRate[503] = 1', async () => {
    const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
    const chaos = createChaosAdapter(inner, { seed: 1, errorRate: { 503: 1 } });
    await expect(chaos.chat({ messages: [] })).rejects.toThrow(/503/);
    expect(chaos.recorder.count('error-503')).toBe(1);
  });

  it('injects network errors when errorRate.network = 1', async () => {
    const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
    const chaos = createChaosAdapter(inner, { seed: 1, errorRate: { network: 1 } });
    await expect(chaos.chat({ messages: [] })).rejects.toThrow(/ECONNREFUSED|network/);
    expect(chaos.recorder.count('error-network')).toBe(1);
  });

  it('never injects when all rates are 0', async () => {
    const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
    const chaos = createChaosAdapter(inner, {
      seed: 1,
      errorRate: { 429: 0, 503: 0, network: 0 },
      streamBreakRate: 0,
      toolArgBloatRate: 0,
      hangRate: 0,
      invalidJsonRate: 0,
    });
    const r = await chaos.chat({ messages: [] });
    expect(r.message.content).toBe('ok');
    expect(chaos.recorder.count('clean')).toBe(1);
  });

  it('is deterministic across identical seeds', async () => {
    const makeInner = (): AgentAdapter => ({
      async chat() {
        return { message: { role: 'assistant', content: 'hi' }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
    const seedKinds = async (seed: number) => {
      const chaos = createChaosAdapter(makeInner(), { seed, errorRate: { 429: 0.5 } });
      const kinds: string[] = [];
      for (let i = 0; i < 20; i++) {
        try { await chaos.chat({ messages: [] }); kinds.push('ok'); }
        catch { kinds.push('err'); }
      }
      return kinds;
    };
    const a = await seedKinds(123);
    const b = await seedKinds(123);
    expect(a).toEqual(b);
  });
});

describe('createChaosAdapter · hang injection', () => {
  it('blocks until the abort signal fires', async () => {
    const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
    const chaos = createChaosAdapter(inner, { seed: 1, hangRate: 1 });
    const ac = new AbortController();
    const promise = chaos.chat({ messages: [], signal: ac.signal });
    // Let one microtask tick so the chaos adapter registers the listener.
    await Promise.resolve();
    ac.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
    expect(chaos.recorder.count('hang')).toBe(1);
  });
});

describe('createChaosAdapter · stream mid-break injection', () => {
  it('throws a network-looking error after at least one chunk', async () => {
    const inner = createStreamingMockAdapter({
      usage: { inputTokens: 1, outputTokens: 1 },
      chunks: [
        { type: 'text_delta', text: 'hi' },
        { type: 'text_delta', text: ' there' },
        { type: 'done' },
      ],
    });
    const chaos = createChaosAdapter(inner, { seed: 1, streamBreakRate: 1 });
    const params: ChatParams = { messages: [] };
    const chunks: string[] = [];
    await expect(async () => {
      for await (const c of chaos.stream!(params)) {
        chunks.push(c.type);
      }
    }).rejects.toThrow(/stream|network|reset/i);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chaos.recorder.count('stream-break')).toBe(1);
  });
});

describe('createChaosAdapter · tool-arg bloat injection', () => {
  it('inflates the first args-bearing tool_call_delta past bloatBytes', async () => {
    const inner = createStreamingMockAdapter({
      usage: { inputTokens: 1, outputTokens: 1 },
      chunks: [
        // First delta: establish the tool call without args so the
        // aggregator creates an entry. Bloat targets the second delta.
        { type: 'tool_call_delta', toolCall: { id: 't1', name: 'search' } },
        {
          type: 'tool_call_delta',
          toolCall: { id: 't1', arguments: '{' },
        },
        { type: 'done' },
      ],
    });
    const chaos = createChaosAdapter(inner, {
      seed: 7,
      toolArgBloatRate: 1,
      bloatBytes: 1024,
    });
    const emitted: Array<{ argsLen: number | undefined }> = [];
    for await (const c of chaos.stream!({ messages: [] })) {
      if (c.type === 'tool_call_delta') {
        emitted.push({ argsLen: c.toolCall?.arguments?.length });
      }
    }
    // First delta has no args (unchanged); second is bloated past 1 KiB.
    expect(emitted).toHaveLength(2);
    expect(emitted[0].argsLen).toBeUndefined();
    expect(emitted[1].argsLen ?? 0).toBeGreaterThanOrEqual(1024);
    expect(chaos.recorder.count('tool-arg-bloat')).toBe(1);
  });
});

describe('createChaosAdapter · invalid JSON injection', () => {
  it('rewrites chat-path tool call arguments', async () => {
    const inner = createMockAdapter({
      responses: [
        {
          content: '',
          toolCalls: [{ id: 't1', name: 'search', arguments: '{"q":"ok"}' }],
        },
      ],
    });
    const chaos = createChaosAdapter(inner, { seed: 3, invalidJsonRate: 1 });
    const r = await chaos.chat({ messages: [] });
    if (r.message.role !== 'assistant' || !r.message.toolCalls) {
      throw new Error('expected tool-calling assistant message');
    }
    expect(() => JSON.parse(r.message.toolCalls![0].arguments)).toThrow();
    expect(chaos.recorder.count('invalid-json')).toBe(1);
  });

  it('rewrites stream-path tool call arguments', async () => {
    const inner = createStreamingMockAdapter({
      usage: { inputTokens: 1, outputTokens: 1 },
      chunks: [
        {
          type: 'tool_call_delta',
          toolCall: { id: 't1', name: 'search', arguments: '{"q":"ok"}' },
        },
        { type: 'done' },
      ],
    });
    const chaos = createChaosAdapter(inner, { seed: 4, invalidJsonRate: 1 });
    let args: string | undefined;
    for await (const c of chaos.stream!({ messages: [] })) {
      if (c.type === 'tool_call_delta') args = c.toolCall?.arguments;
    }
    expect(args).toBeDefined();
    expect(() => JSON.parse(args!)).toThrow();
    expect(chaos.recorder.count('invalid-json')).toBe(1);
  });
});

describe('createChaosAdapter · recorder', () => {
  it('counts calls across chat and stream paths', async () => {
    const inner = createStreamingMockAdapter({
      usage: { inputTokens: 1, outputTokens: 1 },
      chunks: [{ type: 'text_delta', text: 'x' }, { type: 'done' }],
    });
    const chaos = createChaosAdapter(inner, { seed: 1 });
    await chaos.chat({ messages: [] });
    for await (const _ of chaos.stream!({ messages: [] })) { /* drain */ }
    await chaos.chat({ messages: [] });
    expect(chaos.recorder.totalCalls).toBe(3);
    expect(chaos.recorder.records.map((r) => r.path)).toEqual(['chat', 'stream', 'chat']);
  });

  it('reset() clears records and resets the call counter', async () => {
    const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
    const chaos = createChaosAdapter(inner, { seed: 1 });
    await chaos.chat({ messages: [] });
    await chaos.chat({ messages: [] });
    expect(chaos.recorder.totalCalls).toBe(2);
    chaos.recorder.reset();
    expect(chaos.recorder.totalCalls).toBe(0);
    await chaos.chat({ messages: [] });
    expect(chaos.recorder.records[0].callNumber).toBe(1);
  });
});
