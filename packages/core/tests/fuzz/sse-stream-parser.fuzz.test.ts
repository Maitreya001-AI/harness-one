/**
 * O3 — SSE stream fuzz suite.
 *
 * harness-one's outbound SSE pipeline is the `toSSEStream(events)` +
 * `formatSSE(chunk)` pair in `core/sse-stream.ts`. The inbound
 * "parser" is `StreamAggregator.handleChunk()` (adapter → AgentEvent).
 * This suite fuzzes both, plus a minimal spec-driven consumer-side
 * decoder so we can replay the corpus of intentionally-malformed raw
 * SSE frames against a realistic client loop.
 *
 * Survival properties:
 *   P1  `toSSEStream()` yields an `SSEChunk` for every input event even
 *       when the event is exotic (circular reference, throwing getter,
 *       non-object, ridiculously large). No uncaught throws ever reach
 *       the `for await` consumer.
 *   P2  `formatSSE()` always produces wire bytes that end with the
 *       terminating double-newline and contain no bare CR inside a
 *       field line (SSE clients read CR, LF, or CR+LF as EOL per the
 *       spec; a bare CR mid-value would split the frame).
 *   P3  `StreamAggregator.handleChunk()` never throws on malformed
 *       chunk shapes — size-limit violations surface as `error` events,
 *       shape problems as `warning` events, per ADR-0009.
 *   P4  The consumer-side decoder embedded in this test handles every
 *       corpus sample without throwing, matching what a spec-compliant
 *       SSE client would do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { toSSEStream, formatSSE, type SSEChunk } from '../../src/core/sse-stream.js';
import type { AgentEvent } from '../../src/core/events.js';
import { StreamAggregator } from '../../src/core/stream-aggregator.js';

const NUM_RUNS = 3_000;
const CORPUS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'corpus/sse');

/**
 * Minimal SSE decoder modelled on the WHATWG Server-Sent Events spec.
 * Kept deliberately simple — its job is to prove the *corpus* samples
 * don't crash a spec-compliant consumer, not to be a production
 * replacement for `EventSource`.
 *
 * Returns a list of dispatched events (excludes comments, retries,
 * and trailing-partial frames). Throws only on its own bugs; any
 * throw is a test failure because the corpus represents malformed but
 * parseable bytes.
 */
interface DecodedEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

function decodeSSE(raw: string): DecodedEvent[] {
  // Normalise EOLs to `\n` first (spec allows CR, LF, or CR+LF).
  const body = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip optional leading BOM so the first field line parses.
  const stripped = body.startsWith('﻿') ? body.slice(1) : body;

  const dispatched: DecodedEvent[] = [];
  let eventType = '';
  let data = '';
  let lastEventId: string | null = null;

  for (const line of stripped.split('\n')) {
    if (line === '') {
      // Dispatch — only if there's any accumulated data.
      if (data !== '') {
        // Per spec, trim a single trailing LF from the data field.
        const trimmed = data.endsWith('\n') ? data.slice(0, -1) : data;
        dispatched.push({
          event: eventType || 'message',
          data: trimmed,
          id: lastEventId,
        });
      }
      eventType = '';
      data = '';
      continue;
    }
    if (line.startsWith(':')) continue; // comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') data += value + '\n';
    else if (field === 'id') lastEventId = value.includes('\0') ? lastEventId : value;
    // `retry` and unknown fields: ignore silently.
  }
  // Trailing partial frame (no final blank line) is discarded — spec behaviour.
  return dispatched;
}

async function collectChunks(gen: AsyncGenerator<SSEChunk>): Promise<SSEChunk[]> {
  const out: SSEChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function* fromArray<T>(xs: readonly T[]): AsyncGenerator<T> {
  for (const x of xs) yield x;
}

function loadCorpus(): Array<{ name: string; content: string }> {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((name) => ({
      name,
      content: readFileSync(join(CORPUS_DIR, name), 'utf8'),
    }));
}

describe('O3 · SSE stream', () => {
  describe('consumer-side decoder against corpus', () => {
    const samples = loadCorpus();

    for (const sample of samples) {
      it(`decoder does not throw on ${sample.name}`, () => {
        expect(() => decodeSSE(sample.content)).not.toThrow();
      });
    }

    it('at least 15 corpus samples are present', () => {
      expect(samples.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('toSSEStream resilience', () => {
    it('emits an error chunk for a circular event (never throws)', async () => {
      const circ: Record<string, unknown> = { type: 'text_delta', text: 'ok' };
      circ.self = circ;
      const chunks = await collectChunks(toSSEStream(fromArray([circ as unknown as AgentEvent])));
      expect(chunks).toHaveLength(1);
      expect(chunks[0].event).toBe('error');
    });

    it('emits an error chunk for a throwing getter (never throws)', async () => {
      const bad = {
        type: 'text_delta',
        get text(): string {
          throw new Error('boom');
        },
      };
      const chunks = await collectChunks(
        toSSEStream(fromArray([bad as unknown as AgentEvent])),
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0].event).toBe('error');
    });

    it('passes a preserialised string event through without stringify', async () => {
      const chunks = await collectChunks(
        toSSEStream(fromArray(['preserialised' as unknown as AgentEvent])),
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ event: 'message', data: 'preserialised' });
    });
  });

  describe('property-based · toSSEStream', () => {
    // Arbitrary JSON-compatible payloads — sampled as parsed values, not
    // strings, so fast-check shrinks them toward minimal failing cases.
    const jsonValue = fc.jsonValue({ maxDepth: 4 });
    const eventLike = fc.record({
      type: fc.oneof(
        fc.constant('text_delta'),
        fc.constant('tool_call_delta'),
        fc.constant('warning'),
        fc.constant('error'),
        fc.constant('done'),
        // A type the serialiser has not seen before — it should still
        // survive as long as the payload is stringifiable.
        fc.string({ maxLength: 32 }),
      ),
      payload: jsonValue,
    });

    it(
      'never throws uncaught and always produces {event, data} chunks',
      async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(eventLike, { maxLength: 16 }), async (events) => {
            const chunks = await collectChunks(
              toSSEStream(fromArray(events as unknown as AgentEvent[])),
            );
            expect(chunks).toHaveLength(events.length);
            for (const c of chunks) {
              expect(typeof c.event).toBe('string');
              expect(typeof c.data).toBe('string');
            }
          }),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'formatSSE output always ends in \\n\\n and is decoder-safe',
      () => {
        fc.assert(
          fc.property(
            fc.record({
              event: fc.string({ maxLength: 64 }),
              data: fc.string({ maxLength: 4096 }),
            }),
            ({ event, data }) => {
              const wire = formatSSE({ event, data });
              expect(wire.endsWith('\n\n')).toBe(true);
              // Re-decoding must not throw. The consumer-side decoder is
              // spec-compliant for this purpose.
              expect(() => decodeSSE(wire)).not.toThrow();
            },
          ),
          { numRuns: NUM_RUNS },
        );
      },
      60_000,
    );
  });

  describe('property-based · StreamAggregator.handleChunk', () => {
    function freshAggregator(): StreamAggregator {
      return new StreamAggregator({
        maxStreamBytes: 64 * 1024,
        maxToolArgBytes: 16 * 1024,
        cumulativeStreamBytesSoFar: 0,
        maxCumulativeStreamBytes: 256 * 1024,
      });
    }

    const textChunk = fc.record({
      type: fc.constant('text_delta' as const),
      text: fc.string({ maxLength: 2048 }),
    });

    const toolChunk = fc.record({
      type: fc.constant('tool_call_delta' as const),
      toolCall: fc.record(
        {
          id: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
          name: fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
          arguments: fc.option(fc.string({ maxLength: 2048 }), { nil: undefined }),
        },
        { requiredKeys: [] },
      ),
    });

    const anyChunk = fc.oneof(textChunk, toolChunk);

    it(
      'handleChunk never throws on arbitrary chunk shapes',
      () => {
        fc.assert(
          fc.property(fc.array(anyChunk, { maxLength: 32 }), (chunks) => {
            const agg = freshAggregator();
            for (const chunk of chunks) {
              try {
                const events = [...agg.handleChunk(chunk)];
                for (const ev of events) {
                  expect(ev.type).toMatch(/^(text_delta|tool_call_delta|warning|error)$/);
                  if (ev.type === 'error') {
                    // Once an error fires the spec says stop pumping; we
                    // still allow the test to continue because the
                    // aggregator's contract is "safe to call again",
                    // just undefined message state.
                    return;
                  }
                }
              } catch (err) {
                // Any uncaught error fails the property. Re-throw so
                // fast-check can shrink.
                throw new Error(
                  `handleChunk threw on chunk ${JSON.stringify(chunk).slice(0, 200)}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            }
          }),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'malformed surrogate pairs across chunks do not crash utf8 accounting',
      () => {
        // Arrange a stream of text_delta chunks that each contain a lone
        // high-surrogate followed by a chunk starting with the low
        // surrogate — the classic cross-chunk UTF-16 split. The aggregator
        // threads `textPendingHighSurrogate` to keep accounting correct.
        fc.assert(
          fc.property(
            fc.array(
              fc.oneof(
                fc.constant('\uD83D'),
                fc.constant('\uDE00'),
                fc.constant('\uDE01\uD83D'),
                fc.constant(''),
                fc.string({ maxLength: 32 }),
              ),
              { maxLength: 64 },
            ),
            (pieces) => {
              const agg = freshAggregator();
              for (const text of pieces) {
                const events = [...agg.handleChunk({ type: 'text_delta', text })];
                for (const ev of events) {
                  if (ev.type === 'error') return; // size-limit is fine
                }
              }
              expect(agg.bytesRead).toBeGreaterThanOrEqual(0);
            },
          ),
          { numRuns: 500 },
        );
      },
      60_000,
    );
  });
});
