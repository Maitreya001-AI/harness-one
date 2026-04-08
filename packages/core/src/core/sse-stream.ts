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
 * Convert an async iterable of AgentEvents into SSE chunks.
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
    yield {
      event: event.type,
      data: JSON.stringify(event),
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
