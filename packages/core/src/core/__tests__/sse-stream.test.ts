import { describe, it, expect } from 'vitest';
import { toSSEStream, formatSSE } from '../sse-stream.js';
import type { SSEChunk } from '../sse-stream.js';
import type { AgentEvent } from '../events.js';

/** Helper: collect all chunks from an async generator. */
async function collectChunks(gen: AsyncGenerator<SSEChunk>): Promise<SSEChunk[]> {
  const chunks: SSEChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Helper: create an async iterable from an array of events. */
async function* fromArray(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('toSSEStream', () => {
  it('converts a single AgentEvent into an SSEChunk', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
    ];
    const chunks = await collectChunks(toSSEStream(fromArray(events)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('iteration_start');
    expect(JSON.parse(chunks[0].data)).toEqual({ type: 'iteration_start', iteration: 1 });
  });

  it('converts multiple events preserving order', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'message', message: { role: 'assistant', content: 'Hi' }, usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'done', reason: 'end_turn', totalUsage: { inputTokens: 10, outputTokens: 5 } },
    ];
    const chunks = await collectChunks(toSSEStream(fromArray(events)));

    expect(chunks).toHaveLength(3);
    expect(chunks[0].event).toBe('iteration_start');
    expect(chunks[1].event).toBe('message');
    expect(chunks[2].event).toBe('done');
  });

  it('handles empty event stream', async () => {
    const chunks = await collectChunks(toSSEStream(fromArray([])));
    expect(chunks).toHaveLength(0);
  });

  it('preserves all event data in JSON serialization', async () => {
    const toolCallEvent: AgentEvent = {
      type: 'tool_call',
      toolCall: { id: 'tc-1', name: 'search', arguments: '{"q":"test"}' },
      iteration: 2,
    };
    const chunks = await collectChunks(toSSEStream(fromArray([toolCallEvent])));

    const parsed = JSON.parse(chunks[0].data);
    expect(parsed.type).toBe('tool_call');
    expect(parsed.toolCall.id).toBe('tc-1');
    expect(parsed.toolCall.name).toBe('search');
    expect(parsed.iteration).toBe(2);
  });

  it('handles text_delta events', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
    ];
    const chunks = await collectChunks(toSSEStream(fromArray(events)));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].event).toBe('text_delta');
    expect(JSON.parse(chunks[0].data).text).toBe('Hello');
    expect(JSON.parse(chunks[1].data).text).toBe(' world');
  });

  it('handles error events', async () => {
    const error = new Error('test error');
    const events: AgentEvent[] = [
      { type: 'error', error },
    ];
    const chunks = await collectChunks(toSSEStream(fromArray(events)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('error');
  });

  it('handles warning events', async () => {
    const events: AgentEvent[] = [
      { type: 'warning', message: 'some warning' },
    ];
    const chunks = await collectChunks(toSSEStream(fromArray(events)));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('warning');
    expect(JSON.parse(chunks[0].data).message).toBe('some warning');
  });
});

// ---------------------------------------------------------------------------
// Wave-12 P1-24 / P2-6: guarded JSON.stringify + reusable fallback.
// ---------------------------------------------------------------------------
describe('toSSEStream — guarded serialization (Wave-12 P1-24)', () => {
  it('does not crash on circular references; emits an error SSE chunk', async () => {
    const cyclic: Record<string, unknown> = { type: 'custom' };
    cyclic.loop = cyclic;
    // Cast via unknown so we can feed a non-AgentEvent to probe the
    // resilience path without loosening the public type signature.
    async function* poisoned(): AsyncGenerator<AgentEvent> {
      yield cyclic as unknown as AgentEvent;
    }
    const chunks = await collectChunks(toSSEStream(poisoned()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('error');
    const parsed = JSON.parse(chunks[0].data);
    expect(parsed.error).toBe('Event serialization failed');
    expect(typeof parsed.reason).toBe('string');
  });

  it('does not crash on a throwing getter; emits an error SSE chunk', async () => {
    const poisonEvent = {
      type: 'custom',
      get data() {
        throw new Error('getter explosion');
      },
    };
    async function* poisoned(): AsyncGenerator<AgentEvent> {
      yield poisonEvent as unknown as AgentEvent;
    }
    const chunks = await collectChunks(toSSEStream(poisoned()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('error');
    expect(chunks[0].data).toContain('Event serialization failed');
  });

  it('continues emitting subsequent events after a poisoned one (P1-24)', async () => {
    const cyclic: Record<string, unknown> = { type: 'bad' };
    cyclic.loop = cyclic;
    async function* mixed(): AsyncGenerator<AgentEvent> {
      yield cyclic as unknown as AgentEvent;
      yield { type: 'iteration_start', iteration: 42 };
    }
    const chunks = await collectChunks(toSSEStream(mixed()));
    expect(chunks).toHaveLength(2);
    expect(chunks[0].event).toBe('error');
    expect(chunks[1].event).toBe('iteration_start');
    expect(JSON.parse(chunks[1].data).iteration).toBe(42);
  });

  it('P2-6: pre-serialized string events skip JSON.stringify', async () => {
    // Non-object input (string) is short-circuited into a `message`
    // event without invoking JSON.stringify — this shaves a full
    // stringify call per chunk on the SSE hot path.
    async function* preSerialized(): AsyncGenerator<AgentEvent> {
      yield 'pre-serialized-payload' as unknown as AgentEvent;
    }
    const chunks = await collectChunks(toSSEStream(preSerialized()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].event).toBe('message');
    expect(chunks[0].data).toBe('pre-serialized-payload');
  });
});

describe('formatSSE', () => {
  it('formats a chunk into SSE wire format', () => {
    const chunk: SSEChunk = { event: 'message', data: '{"type":"message"}' };
    const result = formatSSE(chunk);
    expect(result).toBe('event: message\ndata: {"type":"message"}\n\n');
  });

  it('ends with double newline', () => {
    const chunk: SSEChunk = { event: 'done', data: '{}' };
    expect(formatSSE(chunk)).toMatch(/\n\n$/);
  });

  it('includes event and data fields', () => {
    const chunk: SSEChunk = { event: 'iteration_start', data: '{"iteration":1}' };
    const formatted = formatSSE(chunk);
    expect(formatted).toContain('event: iteration_start');
    expect(formatted).toContain('data: {"iteration":1}');
  });

  it('handles empty data', () => {
    const chunk: SSEChunk = { event: 'ping', data: '' };
    const result = formatSSE(chunk);
    expect(result).toBe('event: ping\ndata: \n\n');
  });

  it('handles data with special characters', () => {
    const chunk: SSEChunk = { event: 'test', data: '{"text":"line1\\nline2"}' };
    const result = formatSSE(chunk);
    expect(result).toContain('data: {"text":"line1\\nline2"}');
  });
});
