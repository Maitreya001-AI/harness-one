/**
 * I4 · `StreamAggregator` throughput on a 10MB mock SSE stream.
 *
 * We synthesize a deterministic 10MB text payload split into 4KB chunks
 * (the stock size many streaming LLM providers emit) and feed it through
 * `handleChunk` start-to-`done`, then call `getMessage` to realise the
 * final message. Total wall-clock is the reported metric.
 *
 * Fixed seed + fixed chunk size ⇒ the same byte-for-byte payload on every
 * run, so the only thing varying between samples is timer noise.
 *
 * @module
 */

import {
  StreamAggregator,
  type StreamAggregatorChunk,
} from '../../../src/core/stream-aggregator.js';

import type { PerfCase, PerfSample } from '../types.js';
import { createRng, nowIso } from '../helpers.js';

const TARGET_BYTES = 10 * 1024 * 1024; // 10 MB
const CHUNK_BYTES = 4 * 1024; // 4 KB
const ITERATIONS = 5; // 5 × 10MB stream runs, min is published
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz 0123456789';

function buildChunks(): StreamAggregatorChunk[] {
  const rng = createRng(0xf00dbabe);
  const total = Math.ceil(TARGET_BYTES / CHUNK_BYTES);
  const chunks: StreamAggregatorChunk[] = new Array(total + 1);
  for (let i = 0; i < total; i++) {
    // Build each chunk with seeded random ASCII — cheap to generate,
    // representative of a real text-heavy model response.
    let text = '';
    for (let j = 0; j < CHUNK_BYTES; j++) {
      text += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    }
    chunks[i] = { type: 'text_delta', text };
  }
  chunks[total] = { type: 'done' };
  return chunks;
}

export const streamAggregatorCase: PerfCase = {
  id: 'I4',
  description: 'StreamAggregator aggregate 10MB text stream (min of 5 runs, ms)',

  async run(): Promise<PerfSample[]> {
    const chunks = buildChunks();
    // One untimed warmup run so JIT compilation of `handleChunk`, the
    // UTF-8 measurement helper, and the text-parts join are all done
    // before we sample. Without this the first sample is always 40-50 %
    // slower than the steady-state, skewing `min()`.
    {
      const agg = new StreamAggregator({
        maxStreamBytes: 32 * 1024 * 1024,
        maxToolArgBytes: 1024 * 1024,
        cumulativeStreamBytesSoFar: 0,
        maxCumulativeStreamBytes: 128 * 1024 * 1024,
      });
      for (const chunk of chunks) {
        for (const _event of agg.handleChunk(chunk)) {
          // nothing
        }
      }
      agg.getMessage({ inputTokens: 0, outputTokens: 0 });
    }
    const samples: number[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
      const agg = new StreamAggregator({
        // Inflate the caps above the payload so size-limit checks don't
        // fire mid-run. 32 MB per stream and 128 MB cumulative are generous
        // but still bounded — we're measuring aggregation, not rejection.
        maxStreamBytes: 32 * 1024 * 1024,
        maxToolArgBytes: 1024 * 1024,
        cumulativeStreamBytesSoFar: 0,
        maxCumulativeStreamBytes: 128 * 1024 * 1024,
      });
      const t0 = performance.now();
      for (const chunk of chunks) {
        // handleChunk is a generator — drain each yield so the aggregator
        // runs its full state machine per chunk (same path AgentLoop takes).
        for (const _event of agg.handleChunk(chunk)) {
          // nothing
        }
      }
      agg.getMessage({ inputTokens: 0, outputTokens: 0 });
      const ms = performance.now() - t0;
      samples.push(ms);
    }
    samples.sort((a, b) => a - b);
    return [
      {
        metric: 'stream_aggregator_10mb_total_ms',
        unit: 'ms',
        value: Number(samples[0].toFixed(3)),
        iterations: ITERATIONS,
        timestamp: nowIso(),
      },
    ];
  },
};
