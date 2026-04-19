/**
 * Example: `toSSEStream` / `formatSSE` — expose AgentLoop events over HTTP.
 *
 * Server-Sent Events is the standard for server→browser streaming in AI
 * chat UIs. harness-one ships `toSSEStream()` which wraps any
 * `AsyncIterable<AgentEvent>` (including `loop.run(messages)`) into
 * `SSEChunk`s you can feed straight to your HTTP response writer.
 *
 * Resilience:
 *   - Circular-reference / throwing-getter events fall back to an error
 *     envelope; the stream is never broken by one bad event.
 *   - `formatSSE` produces the wire-format string — no hidden
 *     re-allocations, works under Bun / Node / Deno / edge runtimes.
 */
import { createAgentLoop } from 'harness-one';
import { toSSEStream, formatSSE } from 'harness-one/advanced';
import type { SSEChunk } from 'harness-one/advanced';
import { createMockAdapter } from 'harness-one/testing';

async function main(): Promise<void> {
  const adapter = createMockAdapter({
    responses: [{ content: 'Hello via SSE!' }],
  });
  const loop = createAgentLoop({ adapter });

  // ── Pretend we're inside an HTTP handler. Typical shape with Fetch API: ─
  //
  //   return new Response(readable, {
  //     headers: { 'Content-Type': 'text/event-stream' },
  //   });
  //
  // Here we just print to stdout so the demo is self-contained.

  const chunks: SSEChunk[] = [];
  for await (const sse of toSSEStream(loop.run([{ role: 'user', content: 'hi' }]))) {
    chunks.push(sse);
    process.stdout.write(formatSSE(sse));
  }
  console.log(`\nEmitted ${chunks.length} SSE chunk(s)`);

  // ── formatSSE output shape ───────────────────────────────────────────────
  // event: text_delta
  // data: {"type":"text_delta","text":"Hello via SSE!"}
  //
  // event: done
  // data: {"type":"done","reason":"end_turn","totalUsage":{...}}

  // ── Hand-craft an SSE chunk — e.g. to emit a keepalive / retry hint ────
  const keepalive: SSEChunk = { event: 'message', data: '{"type":"ping"}' };
  process.stdout.write(formatSSE(keepalive));

  loop.dispose();
}

main().catch(console.error);
