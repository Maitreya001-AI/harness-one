/**
 * J7 · Property: `StreamAggregator` counts UTF-8 bytes identically to
 * `Buffer.byteLength(s, 'utf8')` across every unicode input, including:
 *
 *   - 4-byte supplementary codepoints (emoji, CJK extensions).
 *   - Pair-splitting chunk boundaries (high surrogate on chunk N, low
 *     surrogate on chunk N+1).
 *   - Lone surrogates that collapse to U+FFFD (3 bytes).
 *   - Mixed ASCII + multi-byte sequences.
 *
 * The aggregator's own docstring calls out behavioural parity with
 * `Buffer.byteLength`; this property is the high-value backstop for that
 * claim.
 *
 * Runs with `numRuns: 500` per the Track-J spec — unicode counting is one
 * of the two heavy properties in the suite.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  StreamAggregator,
  type StreamAggregatorChunk,
  type StreamAggregatorEvent,
} from '../stream-aggregator.js';

// Fast-check 4.x replaced `fc.fullUnicodeString()` with
// `fc.string({ unit: 'binary' })`, which emits the full BMP + surrogate
// range (including lone surrogates) — exactly the input class the
// aggregator's cross-chunk pendingHigh logic must survive.

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

function makeAggregator(): StreamAggregator {
  return new StreamAggregator({
    // Generous caps so size limits never fire and skew the byte count.
    maxStreamBytes: Number.MAX_SAFE_INTEGER,
    maxToolArgBytes: Number.MAX_SAFE_INTEGER,
    cumulativeStreamBytesSoFar: 0,
    maxCumulativeStreamBytes: Number.MAX_SAFE_INTEGER,
    maxToolCalls: 1024,
  });
}

function drainText(agg: StreamAggregator, text: string): void {
  const chunk: StreamAggregatorChunk = { type: 'text_delta', text };
  for (const ev of agg.handleChunk(chunk)) {
    // Surface any aggregation error loudly — should never happen under
    // the max-safe-int caps above.
    const e = ev as StreamAggregatorEvent;
    if (e.type === 'error') throw e.error;
  }
}

describe('J7 · StreamAggregator UTF-8 byte count (property)', () => {
  it('single-chunk byte count matches Buffer.byteLength for any unicode', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (text) => {
        const agg = makeAggregator();
        drainText(agg, text);
        expect(agg.bytesRead).toBe(Buffer.byteLength(text, 'utf8'));
      }),
      { numRuns: 500, ...(seed !== undefined && { seed }) },
    );
  });

  it('chunked stream: sum of chunks matches Buffer.byteLength of the join', () => {
    // Split the string at arbitrary UTF-16 code-unit positions — this can
    // land between a surrogate pair, which is the exact case the
    // aggregator's cross-chunk pendingHigh logic handles.
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 200 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 0, maxLength: 10 }),
        (text, splitPoints) => {
          const chunks: string[] = [];
          const sorted = [...splitPoints]
            .map((p) => Math.min(p, text.length))
            .sort((a, b) => a - b);
          let cursor = 0;
          for (const cut of sorted) {
            chunks.push(text.slice(cursor, cut));
            cursor = cut;
          }
          chunks.push(text.slice(cursor));

          const agg = makeAggregator();
          for (const chunk of chunks) {
            if (chunk.length > 0) drainText(agg, chunk);
          }
          expect(agg.bytesRead).toBe(Buffer.byteLength(text, 'utf8'));
        },
      ),
      { numRuns: 500, ...(seed !== undefined && { seed }) },
    );
  });

  it('explicit surrogate-pair-split edge case: high on chunk N, low on chunk N+1', () => {
    // Canonical worst case: supplementary codepoint split at the UTF-16
    // boundary. Must count 4 bytes total, not 6 or 7.
    const smiley = '😀'; // U+1F600 GRINNING FACE
    const agg = makeAggregator();
    drainText(agg, smiley[0]);
    drainText(agg, smiley[1]);
    expect(agg.bytesRead).toBe(4);
    expect(agg.bytesRead).toBe(Buffer.byteLength(smiley, 'utf8'));
  });

  it('lone surrogate collapses to U+FFFD (3 bytes)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('\uD83D'), // lone high
          fc.constant('\uDE00'), // lone low
        ),
        (loneSurrogate) => {
          const agg = makeAggregator();
          drainText(agg, loneSurrogate);
          // Force pending-high flush by emitting an ASCII char after.
          drainText(agg, 'x');
          const expected = Buffer.byteLength(loneSurrogate + 'x', 'utf8');
          expect(agg.bytesRead).toBe(expected);
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
