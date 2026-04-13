/**
 * Direct unit tests for StreamAggregator (ARCH-001).
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
});
