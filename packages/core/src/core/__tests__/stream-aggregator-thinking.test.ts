/**
 * StreamAggregator extended-thinking accumulation (RFC-0001).
 *
 * `thinking_delta` chunks coalesce into a single ThinkingBlock (last
 * signature wins), redacted payloads become one block each, and
 * `Message.content` stays the text projection — thinking contributes
 * nothing to it.
 */

import { describe, it, expect } from 'vitest';
import { StreamAggregator } from '../stream-aggregator.js';
import type { StreamAggregatorEvent } from '../stream-aggregator.js';
import { HarnessErrorCode, HarnessError } from '../errors.js';

const OPTS = {
  maxStreamBytes: 10_000,
  maxToolArgBytes: 10_000,
  cumulativeStreamBytesSoFar: 0,
  maxCumulativeStreamBytes: 100_000,
};

const USAGE = { inputTokens: 1, outputTokens: 1 };

function drain(agg: StreamAggregator, chunks: Parameters<StreamAggregator['handleChunk']>[0][]): StreamAggregatorEvent[] {
  const events: StreamAggregatorEvent[] = [];
  for (const chunk of chunks) {
    for (const evt of agg.handleChunk(chunk)) events.push(evt);
  }
  return events;
}

describe('StreamAggregator thinking accumulation', () => {
  it('coalesces thinking deltas into one ThinkingBlock and keeps content as the text projection', () => {
    const agg = new StreamAggregator(OPTS);
    const events = drain(agg, [
      { type: 'thinking_delta', thinking: 'Let me ' },
      { type: 'thinking_delta', thinking: 'reason about this.' },
      { type: 'text_delta', text: 'The answer is 42.' },
    ]);

    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(2);

    const { message } = agg.getMessage(USAGE);
    expect(message.content).toBe('The answer is 42.');
    expect(message.blocks).toEqual([
      { type: 'thinking', thinking: 'Let me reason about this.' },
      { type: 'text', text: 'The answer is 42.' },
    ]);
  });

  it('keeps the last signature, including from a signature-only chunk', () => {
    const agg = new StreamAggregator(OPTS);
    drain(agg, [
      { type: 'thinking_delta', thinking: 'hmm', signature: 'sig-early' },
      { type: 'thinking_delta', thinking: ' more' },
      { type: 'thinking_delta', signature: 'sig-final' }, // signature-only
    ]);

    const { message } = agg.getMessage(USAGE);
    expect(message.blocks?.[0]).toEqual({
      type: 'thinking',
      thinking: 'hmm more',
      signature: 'sig-final',
    });
  });

  it('turns each redactedData payload into its own RedactedThinkingBlock in order', () => {
    const agg = new StreamAggregator(OPTS);
    drain(agg, [
      { type: 'thinking_delta', thinking: 'visible' },
      { type: 'thinking_delta', redactedData: 'opaque-1' },
      { type: 'thinking_delta', redactedData: 'opaque-2' },
      { type: 'text_delta', text: 'done' },
    ]);

    const { message } = agg.getMessage(USAGE);
    expect(message.blocks).toEqual([
      { type: 'thinking', thinking: 'visible' },
      { type: 'redacted_thinking', data: 'opaque-1' },
      { type: 'redacted_thinking', data: 'opaque-2' },
      { type: 'text', text: 'done' },
    ]);
  });

  it('omits the text block when no text accumulated (thinking + tool calls only)', () => {
    const agg = new StreamAggregator(OPTS);
    drain(agg, [
      { type: 'thinking_delta', thinking: 'plan the call' },
      { type: 'tool_call_delta', toolCall: { id: 't1', name: 'search', arguments: '{}' } },
    ]);

    const { message } = agg.getMessage(USAGE);
    expect(message.content).toBe('');
    expect(message.blocks).toEqual([{ type: 'thinking', thinking: 'plan the call' }]);
    expect(message.role === 'assistant' && message.toolCalls).toHaveLength(1);
  });

  it('omits blocks entirely when no reasoning content accumulated (backward compat)', () => {
    const agg = new StreamAggregator(OPTS);
    drain(agg, [{ type: 'text_delta', text: 'plain' }]);

    const { message } = agg.getMessage(USAGE);
    expect(message.blocks).toBeUndefined();
  });

  it('counts thinking bytes toward maxStreamBytes', () => {
    const agg = new StreamAggregator({ ...OPTS, maxStreamBytes: 10 });
    const events = drain(agg, [
      { type: 'thinking_delta', thinking: 'x'.repeat(11) },
    ]);

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') {
      expect((err.error as HarnessError).code).toBe(HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED);
    }
  });

  it('counts redacted payload bytes toward maxStreamBytes', () => {
    const agg = new StreamAggregator({ ...OPTS, maxStreamBytes: 10 });
    const events = drain(agg, [
      { type: 'thinking_delta', redactedData: 'y'.repeat(11) },
    ]);

    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('reset() clears thinking state for instance reuse', () => {
    const agg = new StreamAggregator(OPTS);
    drain(agg, [
      { type: 'thinking_delta', thinking: 'stale', signature: 'stale-sig' },
      { type: 'thinking_delta', redactedData: 'stale-opaque' },
    ]);
    agg.reset();
    drain(agg, [{ type: 'text_delta', text: 'fresh' }]);

    const { message } = agg.getMessage(USAGE);
    expect(message.blocks).toBeUndefined();
    expect(message.content).toBe('fresh');
  });

  it('empty thinking fragments produce no event but still register signatures', () => {
    const agg = new StreamAggregator(OPTS);
    const events = drain(agg, [
      { type: 'thinking_delta', thinking: 'body' },
      { type: 'thinking_delta', thinking: '', signature: 'sig' },
    ]);

    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(1);
    const { message } = agg.getMessage(USAGE);
    expect(message.blocks?.[0]).toEqual({ type: 'thinking', thinking: 'body', signature: 'sig' });
  });
});
