/**
 * SSE (Server-Sent Events) streaming helper.
 *
 * Wraps an AgentEvent AsyncIterable into SSE-formatted chunks for
 * server-to-client streaming over HTTP.
 *
 * @module
 */

import type { AgentEvent } from './events.js';

/** A single SSE chunk ready to be serialized and sent to the client. */
export interface SSEChunk {
  event: string;
  data: string;
}

/**
 * Last-resort hardcoded SSE chunk returned when both the primary
 * `JSON.stringify(event)` and the fallback error-envelope
 * `JSON.stringify` throw. Kept as a module-level constant so the hot
 * path doesn't allocate a new object on each double-failure.
 */
const SSE_SERIALIZATION_FAILURE_FALLBACK: SSEChunk = Object.freeze({
  event: 'error',
  data: '{"error":"Event serialization failed"}',
});

/**
 * Convert an async iterable of AgentEvents into SSE chunks.
 *
 * `JSON.stringify(event)` is wrapped in try/catch so a single poisoned
 * event (circular reference, throwing getter) cannot crash the whole
 * stream. On first-level failure we emit an SSE `error` chunk carrying
 * the failure reason; on double-failure (the fallback JSON also throws)
 * we yield a pre-frozen minimal byte constant.
 *
 * @example
 * ```ts
 * for await (const chunk of toSSEStream(loop.run(messages))) {
 *   response.write(formatSSE(chunk));
 * }
 * ```
 */
export async function* toSSEStream(events: AsyncIterable<AgentEvent>): AsyncGenerator<SSEChunk> {
  for await (const event of events) {
    // P2-6: short-circuit when the consumer already pre-serialized the
    // payload (e.g. a server-side middleware). We still allocate a
    // per-chunk `SSEChunk` literal because it's part of the public shape,
    // but we skip the JSON.stringify cost in that case.
    if (typeof event === 'string') {
      yield { event: 'message', data: event };
      continue;
    }
    let data: string;
    try {
      data = JSON.stringify(event);
    } catch (err) {
      // Primary stringify failed — common for circular refs or throwing
      // getters. Fall back to an `error` envelope. If the fallback also
      // throws (exotic), yield the pre-computed hardcoded byte constant.
      //
      // Clamp the reason string defensively. `String(err)` can throw
      // (exotic `.toString()` throwers) — we pre-coerce inside a try and
      // slice to 200 chars so a maliciously large error message cannot
      // blow up the SSE envelope. The outer try/catch still covers the
      // pathological `String()` throw case by falling through to the
      // hardcoded fallback chunk.
      let reason: string;
      try {
        reason = String(err).slice(0, 200);
      } catch {
        reason = 'unserializable error';
      }
      try {
        yield {
          event: 'error',
          data: JSON.stringify({
            error: 'Event serialization failed',
            reason,
          }),
        };
      } catch {
        yield SSE_SERIALIZATION_FAILURE_FALLBACK;
      }
      continue;
    }
    yield {
      event: event.type,
      data,
    };
  }
}

/**
 * Format an SSEChunk into the wire format specified by the SSE protocol.
 *
 * @returns A string like `event: message\ndata: {...}\n\n`
 */
export function formatSSE(chunk: SSEChunk): string {
  return `event: ${chunk.event}\ndata: ${chunk.data}\n\n`;
}
