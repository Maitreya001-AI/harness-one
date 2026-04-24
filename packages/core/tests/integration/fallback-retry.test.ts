/**
 * D4 — Fallback adapter × AgentLoop adapter retry × one-way breaker.
 *
 * Two distinct composition layers both need to work together:
 *
 *  (a) Loop-level retry: when the outer adapter throws a retryable error,
 *      AgentLoop honours `maxAdapterRetries` + `baseRetryDelayMs`, emits
 *      `adapter_retry` span events, and sleeps delays drawn from the same
 *      formula as `createBackoffSchedule`.
 *
 *  (b) Fallback adapter breaker: `createFallbackAdapter` trips a one-way
 *      switch once the primary has accumulated `maxFailures`, and every
 *      subsequent `chat()` call goes straight to the fallback without
 *      re-probing the primary.
 *
 * The two scenarios are separated so a regression in one surface doesn't
 * mask the other.
 */

import { describe, it, expect } from 'vitest';
import { createAgentLoop } from '../../src/core/agent-loop.js';
import { createFallbackAdapter } from '../../src/core/fallback-adapter.js';
import { createMockAdapter, createFailingAdapter } from '../../src/testing/test-utils.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import {
  computeBackoffMs,
  ADAPTER_RETRY_JITTER_FRACTION,
} from '../../src/infra/backoff.js';
import type { AgentEvent } from '../../src/core/events.js';
import type { Trace, TraceExporter } from '../../src/observe/types.js';

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('integration/D4 · fallback adapter + retry + backoff', () => {
  it('retries a retryable 429 up to maxAdapterRetries with delays bounded by createBackoffSchedule', async () => {
    const baseRetryDelayMs = 5;
    const maxAdapterRetries = 2;

    // Fails with a 429-shaped message the first three attempts (initial + 2
    // retries), succeeds on the fourth.
    let callIndex = 0;
    const adapter = {
      name: 'flaky',
      async chat() {
        callIndex++;
        if (callIndex <= maxAdapterRetries) {
          throw new Error('HTTP 429: rate limit reached, too many requests');
        }
        return {
          message: { role: 'assistant' as const, content: 'finally' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const captured: Trace[] = [];
    const collector: TraceExporter = {
      name: 'd4-collector',
      async exportTrace(trace) {
        captured.push(trace);
      },
      async exportSpan() { /* snapshot read from exportTrace */ },
      async flush() { /* no-op */ },
    };
    const tracer = createTraceManager({ exporters: [collector] });

    const loop = createAgentLoop({
      adapter,
      traceManager: tracer,
      maxAdapterRetries,
      baseRetryDelayMs,
      retryableErrors: ['ADAPTER_RATE_LIMIT'],
    });

    const events = await drain(loop.run([{ role: 'user', content: 'go' }]));
    await tracer.flush();

    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(done?.reason).toBe('end_turn');
    // Initial attempt + 2 retries = 3 total adapter invocations.
    expect(callIndex).toBe(maxAdapterRetries + 1);

    // Trace snapshot holds the adapter_retry events — one per retry.
    expect(captured).toHaveLength(1);
    const iterationSpan = captured[0].spans.find((s) => s.name === 'iteration-1');
    expect(iterationSpan).toBeDefined();
    const retryEvents = iterationSpan!.events.filter((ev) => ev.name === 'adapter_retry');
    expect(retryEvents).toHaveLength(maxAdapterRetries);

    // Every retry's reported backoff_ms must fall within the bounds
    // createBackoffSchedule would derive from the same (attempt, baseMs,
    // jitterFraction) triple. Lower bound = baseMs * 2^attempt * (1 - jitter).
    // Upper bound = baseMs * 2^attempt (jitter pulls the jitter amount down
    // toward zero, never up). Tolerate one floor()-induced millisecond on the
    // lower side.
    for (let i = 0; i < retryEvents.length; i++) {
      const backoffMs = retryEvents[i].attributes!['backoff_ms'] as number;
      const expectedMax = computeBackoffMs(i, {
        baseMs: baseRetryDelayMs,
        jitterFraction: 0,
      });
      const jitteredMin = Math.floor(
        expectedMax * (1 - ADAPTER_RETRY_JITTER_FRACTION),
      );
      expect(backoffMs).toBeGreaterThanOrEqual(jitteredMin);
      expect(backoffMs).toBeLessThanOrEqual(expectedMax);
    }
  });

  it('fallback adapter flips to the backup after maxFailures and stays there on subsequent runs (one-way breaker)', async () => {
    const primary = createFailingAdapter(new Error('HTTP 429: too many requests'));
    const fallback = createMockAdapter({
      responses: [{ content: 'fallback-response-1' }, { content: 'fallback-response-2' }],
    });
    const composite = createFallbackAdapter({
      adapters: [primary, fallback],
      // One failure on primary is enough to flip the switch so the same
      // chat() call can resolve via the backup — matches the prompt's
      // "breaker 触发后后续 run 直接走 fallback" requirement.
      maxFailures: 1,
    });

    // --- Run 1 — primary fails once, fallback serves within the same call ---
    const loop1 = createAgentLoop({ adapter: composite });
    const events1 = await drain(loop1.run([{ role: 'user', content: 'go1' }]));
    const done1 = events1.find(
      (e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(done1?.reason).toBe('end_turn');
    const msg1 = events1.find(
      (e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message',
    );
    expect(msg1?.message.content).toBe('fallback-response-1');

    // Primary attempted once, fallback served once.
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);

    // --- Run 2 — breaker stays tripped; primary is NOT re-probed ---
    const loop2 = createAgentLoop({ adapter: composite });
    const events2 = await drain(loop2.run([{ role: 'user', content: 'go2' }]));
    const msg2 = events2.find(
      (e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message',
    );
    expect(msg2?.message.content).toBe('fallback-response-2');

    // Primary count UNCHANGED (still 1 from run 1), fallback incremented.
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(2);
  });
});
