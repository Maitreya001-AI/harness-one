/**
 * Direct unit tests for StreamAggregator.
 *
 * Behavioural parity with the historical inline `handleStream` is covered
 * indirectly by the existing `agent-loop.test.ts` and `streaming-errors.test.ts`
 * suites; this file pins the StreamAggregator's standalone contract so it
 * can be reused outside the AgentLoop without drift.
 */

import { describe, it, expect } from 'vitest';
import { StreamAggregator, type StreamAggregatorChunk, type StreamAggregatorEvent } from '../stream-aggregator.js';

function drain(agg: StreamAggregator, chunks: StreamAggregatorChunk[]): StreamAggregatorEvent[] {
  const out: StreamAggregatorEvent[] = [];
  for (const c of chunks) {
    for (const e of agg.handleChunk(c)) out.push(e);
  }
  return out;
}

const DEFAULT_OPTS = {
  maxStreamBytes: 1024,
  maxToolArgBytes: 256,
  cumulativeStreamBytesSoFar: 0,
  maxCumulativeStreamBytes: 10_000,
};

describe('StreamAggregator', () => {
  it('accumulates text deltas into the final assistant message', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    const events = drain(agg, [
      { type: 'text_delta', text: 'Hello, ' },
      { type: 'text_delta', text: 'world' },
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello, ' },
      { type: 'text_delta', text: 'world' },
    ]);
    const result = agg.getMessage({ inputTokens: 1, outputTokens: 2 });
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toBe('Hello, world');
    expect(result.message.toolCalls).toBeUndefined();
    expect(result.bytesRead).toBe('Hello, world'.length);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('accumulates tool_call deltas, mutating in place by id', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    drain(agg, [
      { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'search', arguments: '{"q":"hel' } },
      { type: 'tool_call_delta', toolCall: { id: 'tc-1', arguments: 'lo"}' } },
    ]);
    const result = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
    expect(result.message.toolCalls).toEqual([
      { id: 'tc-1', name: 'search', arguments: '{"q":"hello"}' },
    ]);
  });

  it('id-less tool deltas append to the most recent tool call', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    drain(agg, [
      { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'echo', arguments: 'a' } },
      { type: 'tool_call_delta', toolCall: { arguments: 'b' } },
      { type: 'tool_call_delta', toolCall: { arguments: 'c' } },
    ]);
    const result = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
    expect(result.message.toolCalls).toEqual([
      { id: 'tc-1', name: 'echo', arguments: 'abc' },
    ]);
  });

  it('emits warning when first tool delta has no id', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    const events = drain(agg, [
      { type: 'tool_call_delta', toolCall: { arguments: 'a' } },
    ]);
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });

  it('errors when per-iteration stream byte limit is exceeded', () => {
    const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxStreamBytes: 5 });
    const events = drain(agg, [
      { type: 'text_delta', text: '12345' },
      { type: 'text_delta', text: '6' }, // exceeds at this chunk
    ]);
    const errEvent = events.find((e): e is { type: 'error'; error: Error } => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.error.message).toContain('exceeded maximum size');
  });

  it('errors when cumulative stream byte limit is exceeded', () => {
    const agg = new StreamAggregator({
      ...DEFAULT_OPTS,
      cumulativeStreamBytesSoFar: 9,
      maxCumulativeStreamBytes: 10,
    });
    const events = drain(agg, [{ type: 'text_delta', text: 'ab' }]);
    const errEvent = events.find((e): e is { type: 'error'; error: Error } => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.error.message).toContain('Cumulative stream size');
  });

  it('errors when per-tool-call argument byte cap is exceeded (with id, on append)', () => {
    // Per-tool-call cap is checked only when an existing tool call's
    // arguments grow beyond the cap (the historical behaviour). The first
    // delta that creates the entry passes through without a cap check; the
    // second delta — which appends `arguments` via the existing-entry path
    // — triggers the limit.
    const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxToolArgBytes: 3 });
    const events = drain(agg, [
      { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'big', arguments: 'ab' } },
      { type: 'tool_call_delta', toolCall: { id: 'tc-1', arguments: 'cd' } },
    ]);
    const errEvent = events.find((e): e is { type: 'error'; error: Error } => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.error.message).toContain('exceeded maximum size');
  });

  it('errors when per-tool-call argument byte cap is exceeded (no id, appended)', () => {
    const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxToolArgBytes: 3 });
    const events = drain(agg, [
      { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'big', arguments: 'ab' } },
      { type: 'tool_call_delta', toolCall: { arguments: 'cd' } },
    ]);
    const errEvent = events.find((e): e is { type: 'error'; error: Error } => e.type === 'error');
    expect(errEvent).toBeDefined();
  });

  it('reset() discards state and lets the instance be reused', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    drain(agg, [{ type: 'text_delta', text: 'first' }]);
    expect(agg.bytesRead).toBe(5);
    agg.reset();
    expect(agg.bytesRead).toBe(0);
    drain(agg, [{ type: 'text_delta', text: 'next' }]);
    const out = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
    expect(out.message.content).toBe('next');
    expect(out.bytesRead).toBe(4);
  });

  it('omits toolCalls when only text was streamed', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    drain(agg, [{ type: 'text_delta', text: 'hi' }]);
    const out = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
    expect('toolCalls' in out.message).toBe(false);
  });

  it('ignores unknown chunk types without throwing', () => {
    const agg = new StreamAggregator(DEFAULT_OPTS);
    const events = drain(agg, [{ type: 'mystery' as 'text_delta', text: undefined }]);
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Regression: string[] buffer for text + tool-call args.
  // ---------------------------------------------------------------------
  describe('string[] buffer avoids O(n²) concatenation', () => {
    it('correctly reassembles N text chunks without dropping content', () => {
      const agg = new StreamAggregator(DEFAULT_OPTS);
      // Pick N such that naive string concatenation would be visible in
      // results (e.g. 1000 chunks of 1 char each = 1000 chars).
      const N = 1000;
      for (let i = 0; i < N; i++) {
        drain(agg, [{ type: 'text_delta', text: String.fromCharCode(97 + (i % 26)) }]);
      }
      const out = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
      expect(out.message.content).toHaveLength(N);
      // Deterministic reconstruction — first/last letter should line up
      // with the index modulo 26.
      expect(out.message.content[0]).toBe('a');
      expect(out.message.content[N - 1]).toBe(String.fromCharCode(97 + ((N - 1) % 26)));
      expect(out.bytesRead).toBe(N);
    });

    it('correctly reassembles multi-delta tool-call arguments via id append', () => {
      const agg = new StreamAggregator(DEFAULT_OPTS);
      // 100 deltas building up a large JSON tool-call argument.
      const deltas: StreamAggregatorChunk[] = [];
      for (let i = 0; i < 100; i++) {
        deltas.push({
          type: 'tool_call_delta',
          toolCall: i === 0 ? { id: 'tc-1', name: 't', arguments: 'a' } : { id: 'tc-1', arguments: 'a' },
        });
      }
      drain(agg, deltas);
      const out = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
      expect(out.message.toolCalls).toHaveLength(1);
      expect(out.message.toolCalls![0].arguments).toBe('a'.repeat(100));
    });

    it('correctly reassembles id-less appended deltas', () => {
      const agg = new StreamAggregator(DEFAULT_OPTS);
      drain(agg, [
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 't', arguments: '' } },
      ]);
      for (let i = 0; i < 50; i++) {
        drain(agg, [{ type: 'tool_call_delta', toolCall: { arguments: 'z' } }]);
      }
      const out = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
      expect(out.message.toolCalls![0].arguments).toBe('z'.repeat(50));
    });
  });

  describe('maxToolCalls limit', () => {
    it('errors when distinct tool calls exceed maxToolCalls', () => {
      const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxToolCalls: 2 });
      const chunks: StreamAggregatorChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'a', arguments: '{}' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-2', name: 'b', arguments: '{}' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-3', name: 'c', arguments: '{}' } },
      ];
      const events = drain(agg, chunks);
      const errEvent = events.find((e): e is { type: 'error'; error: Error } => e.type === 'error');
      expect(errEvent).toBeDefined();
      expect(errEvent!.error.message).toContain('Exceeded maximum number of tool calls');
      expect(errEvent!.error.message).toContain('2');
    });

    it('allows tool calls up to maxToolCalls without error', () => {
      const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxToolCalls: 3 });
      const chunks: StreamAggregatorChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'a', arguments: '{}' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-2', name: 'b', arguments: '{}' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-3', name: 'c', arguments: '{}' } },
      ];
      const events = drain(agg, chunks);
      const errEvent = events.find((e) => e.type === 'error');
      expect(errEvent).toBeUndefined();
    });

    it('defaults to 128 when maxToolCalls is not set', () => {
      const agg = new StreamAggregator(DEFAULT_OPTS);
      // Creating 128 tool calls should be fine (under default limit)
      const chunks: StreamAggregatorChunk[] = [];
      for (let i = 0; i < 128; i++) {
        chunks.push({ type: 'tool_call_delta', toolCall: { id: `tc-${i}`, name: `tool${i}`, arguments: '{}' } });
      }
      const events = drain(agg, chunks);
      const errEvent = events.find((e) => e.type === 'error');
      expect(errEvent).toBeUndefined();
    });

    it('count limit fires BEFORE allocating the new entry', () => {
      // After the error the set size must equal the cap (the rejected
      // tool call MUST NOT have been added to the map/array). Previously
      // the check fired after allocation, briefly exposing a (cap+1)-sized
      // accumulator to consumers reading `getMessage()` post-error.
      const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxToolCalls: 2 });
      const events = drain(agg, [
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'a', arguments: '{}' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-2', name: 'b', arguments: '{}' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-3', name: 'c', arguments: '{}' } },
      ]);
      expect(events.some((e) => e.type === 'error')).toBe(true);
      const out = agg.getMessage({ inputTokens: 0, outputTokens: 0 });
      // Only the first two tool calls survived; the third was rejected
      // BEFORE allocation (no partial-entry leak).
      expect(out.message.toolCalls).toHaveLength(2);
      expect(out.message.toolCalls!.map((t) => t.id)).toEqual(['tc-1', 'tc-2']);
    });

    it('appending arguments to existing tool does not count as new tool', () => {
      const agg = new StreamAggregator({ ...DEFAULT_OPTS, maxToolCalls: 1 });
      const chunks: StreamAggregatorChunk[] = [
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', name: 'a', arguments: '{"x":' } },
        { type: 'tool_call_delta', toolCall: { id: 'tc-1', arguments: '"y"}' } },
      ];
      const events = drain(agg, chunks);
      const errEvent = events.find((e) => e.type === 'error');
      expect(errEvent).toBeUndefined();
    });
  });

  describe('UTF-8 byte accounting', () => {
    // The aggregator previously counted `string.length` (UTF-16 code units),
    // so a CJK-heavy stream appeared to be about half its real wire size.
    // These tests pin the current UTF-8 accounting so the byte budget matches
    // what downstream readers of the serialized JSON actually see.
    const UTF8_OPTS = {
      maxStreamBytes: 1_000_000,
      maxToolArgBytes: 1_000_000,
      cumulativeStreamBytesSoFar: 0,
      maxCumulativeStreamBytes: 10_000_000,
    };

    it('counts ASCII as 1 byte per char', () => {
      const agg = new StreamAggregator(UTF8_OPTS);
      drain(agg, [{ type: 'text_delta', text: 'hello' }]);
      expect(agg.bytesRead).toBe(5);
    });

    it('counts CJK characters as 3 bytes each', () => {
      const agg = new StreamAggregator(UTF8_OPTS);
      drain(agg, [{ type: 'text_delta', text: '你好世界' }]);
      expect(agg.bytesRead).toBe(12); // 4 chars × 3 bytes
    });

    it('counts emoji (surrogate pairs) as 4 bytes each', () => {
      const agg = new StreamAggregator(UTF8_OPTS);
      drain(agg, [{ type: 'text_delta', text: '🎉🚀' }]);
      expect(agg.bytesRead).toBe(8); // 2 emoji × 4 bytes
    });

    it('enforces maxStreamBytes using UTF-8 bytes, not code units', () => {
      const agg = new StreamAggregator({ ...UTF8_OPTS, maxStreamBytes: 20 });
      // 8 CJK chars = 24 UTF-8 bytes; only 16 UTF-16 code units — should
      // overflow under UTF-8 accounting.
      const events = drain(agg, [{ type: 'text_delta', text: '你好世界你好世界' }]);
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
    });

    it('counts tool-call argument bytes in UTF-8', () => {
      const agg = new StreamAggregator({ ...UTF8_OPTS, maxToolArgBytes: 10 });
      // Per-tool-call overflow is only detected on the APPEND path (second
      // chunk onward) — the first chunk just seeds the entry. Feed two
      // CJK chunks so the existing-entry branch fires: 3+6 bytes total exceeds
      // the 10-byte cap once we add 5 more bytes.
      const events = drain(agg, [
        { type: 'tool_call_delta', toolCall: { id: 'tc', name: 'n', arguments: '一' } }, // 3B
        { type: 'tool_call_delta', toolCall: { id: 'tc', arguments: '二三四' } }, // +9B → 12B > 10
      ]);
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
    });

    describe('cross-chunk surrogate-pair handling', () => {
      // A single emoji like '🎉' (U+1F389) is 4 UTF-8 bytes AND two UTF-16
      // code units — a high surrogate (0xd83c) + low surrogate (0xdf89).
      // An adapter that splits streaming text at arbitrary JS string
      // positions can land the chunk boundary between the two halves. The
      // aggregator must still produce 4 bytes total (not 7) for the
      // completed pair across chunks.
      const EMOJI_HIGH = '\ud83c'; // high surrogate of 🎉
      const EMOJI_LOW = '\udf89'; // low surrogate of 🎉

      it('counts a surrogate pair split across two text_delta chunks as 4 bytes', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [
          { type: 'text_delta', text: EMOJI_HIGH },
          { type: 'text_delta', text: EMOJI_LOW },
        ]);
        expect(agg.bytesRead).toBe(4);
      });

      it('counts surrounding ASCII + split pair correctly', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [
          { type: 'text_delta', text: `ab${EMOJI_HIGH}` }, // 2 ASCII + pending
          { type: 'text_delta', text: `${EMOJI_LOW}cd` }, // completes pair + 2 ASCII
        ]);
        // 2 + 4 (completed pair) + 2 = 8
        expect(agg.bytesRead).toBe(8);
      });

      it('completes multiple consecutive split pairs', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [
          { type: 'text_delta', text: EMOJI_HIGH },
          { type: 'text_delta', text: `${EMOJI_LOW}${EMOJI_HIGH}` },
          { type: 'text_delta', text: EMOJI_LOW },
        ]);
        // Two completed surrogate pairs = 8 bytes.
        expect(agg.bytesRead).toBe(8);
      });

      it('charges 3 bytes (U+FFFD) when a trailing high is orphan at end of stream', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [{ type: 'text_delta', text: `a${EMOJI_HIGH}` }]);
        // utf8ByteLength (pending flush on single-string) charges
        // 1 (ASCII 'a') + 3 (lone high → U+FFFD) = 4, because the chunk
        // is processed in isolation and no follow-up low arrives. BUT the
        // aggregator leaves the pending-high state set; bytesRead reflects
        // the in-flight accounting (1 byte for 'a', high held back for
        // potential pair completion on the next chunk).
        expect(agg.bytesRead).toBe(1);
        // Now flush with a non-low follow-up: the orphan high resolves as
        // 3 bytes, then the ASCII 'b' adds 1.
        drain(agg, [{ type: 'text_delta', text: 'b' }]);
        expect(agg.bytesRead).toBe(1 + 3 + 1);
      });

      it('charges 3 bytes when a chunk starts with a lone low surrogate (no pending high)', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [{ type: 'text_delta', text: EMOJI_LOW }]);
        // Lone low surrogate with no prior pending → U+FFFD (3 bytes).
        expect(agg.bytesRead).toBe(3);
      });

      it('charges 3 bytes for a high followed by a non-low in the same chunk', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [{ type: 'text_delta', text: `${EMOJI_HIGH}x` }]);
        // 3 (lone high → U+FFFD) + 1 (ASCII 'x') = 4
        expect(agg.bytesRead).toBe(4);
      });

      it('resets pending-high-surrogate state on reset()', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [{ type: 'text_delta', text: EMOJI_HIGH }]);
        agg.reset();
        // After reset, a standalone low surrogate must NOT complete a
        // stale pair — it should count as 3 bytes (U+FFFD).
        drain(agg, [{ type: 'text_delta', text: EMOJI_LOW }]);
        expect(agg.bytesRead).toBe(3);
      });

      it('does not cross-contaminate pending state between text and tool-call streams', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [
          { type: 'text_delta', text: EMOJI_HIGH },
          // A tool_call_delta arriving with a low surrogate in its args
          // MUST NOT consume the text stream's pending high — they are
          // separate logical streams.
          { type: 'tool_call_delta', toolCall: { id: 'tc', name: 'n', arguments: EMOJI_LOW } },
          { type: 'text_delta', text: EMOJI_LOW },
        ]);
        // text stream: high + low (completed across the interleaving) = 4 bytes
        // tool args: lone low in isolation = 3 bytes
        expect(agg.bytesRead).toBe(4 + 3);
      });

      it('completes tool-call arg pair split across two deltas on same id', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [
          { type: 'tool_call_delta', toolCall: { id: 'tc', name: 'n', arguments: EMOJI_HIGH } },
          { type: 'tool_call_delta', toolCall: { id: 'tc', arguments: EMOJI_LOW } },
        ]);
        // Pair completes across the two tool-call deltas with the same id:
        // 0 (pending) + 4 (complete) = 4 bytes total charged against the
        // stream (and against the tool's argsBytes accounting).
        expect(agg.bytesRead).toBe(4);
      });

      it('completes tool-call arg pair split across two deltas on no-id-append path', () => {
        const agg = new StreamAggregator(UTF8_OPTS);
        drain(agg, [
          { type: 'tool_call_delta', toolCall: { id: 'tc', name: 'n', arguments: '{' } },
          { type: 'tool_call_delta', toolCall: { arguments: EMOJI_HIGH } }, // no id → append to last
          { type: 'tool_call_delta', toolCall: { arguments: EMOJI_LOW } },
        ]);
        // 1 ({) + 0 (pending) + 4 (complete pair) = 5 bytes.
        expect(agg.bytesRead).toBe(5);
      });
    });
  });
});
