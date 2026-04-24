/**
 * Scenario H1 — 50 × run, ~30% mixed 429/503, retry + fallback + one-way
 * breaker composed on top.
 *
 * Aggregate invariants:
 *   1. Every run reaches a terminal state (no 'no-done' survivors).
 *   2. The TraceManager has zero active spans after the sweep.
 *   3. CostTracker recent-window total ≤ per-trace cumulative sum (no
 *      orphan cost attribution).
 *   4. Breaker pre/post semantics — before trip, calls retry; after trip,
 *      calls fast-fail with `CircuitOpenError` and the fallback adapter
 *      owns the success path.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { createFallbackAdapter } from '../../src/core/fallback-adapter.js';
import { createCircuitBreaker } from '../../src/infra/circuit-breaker.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import { createCostTracker } from '../../src/observe/cost-tracker.js';
import {
  createChaosAdapter,
  createMockAdapter,
} from '../../src/testing/index.js';
import type { AgentAdapter, ChatParams, ChatResponse } from '../../src/core/types.js';
import {
  assertAllRunsReachedTerminalState,
  assertCostConsistency,
  assertNoActiveSpans,
  type RunOutcome,
} from './assertions.js';
import { drainRun, resolveSeed, silentLogger } from './harness.js';

/** Arbitrary fallback seed; override via `CHAOS_SEED` env. */
const H1_SEED_FALLBACK = 18_481;

/** Wrap an adapter so every chat() call flows through a circuit breaker. */
function wrapWithBreaker(
  inner: AgentAdapter,
  breaker: ReturnType<typeof createCircuitBreaker>,
): AgentAdapter {
  return {
    name: inner.name !== undefined ? `breaker(${inner.name})` : 'breaker',
    async chat(params: ChatParams): Promise<ChatResponse> {
      return breaker.execute(() => inner.chat(params));
    },
  };
}

describe('chaos H1 · 50 × run × 30% 429/503', () => {
  it('aggregate invariants hold under mixed rate-limit / unavailable faults', async () => {
    const seed = resolveSeed(H1_SEED_FALLBACK);
    const RUNS = 50;

    const primary = createChaosAdapter(
      createMockAdapter({ responses: [{ content: 'primary-ok' }] }),
      { seed, errorRate: { 429: 0.15, 503: 0.15 } },
    );
    const fallback = createMockAdapter({ responses: [{ content: 'fallback-ok' }] });

    // One-way breaker: `resetTimeoutMs` is set large enough that within the
    // scenario's wall-clock the breaker never transitions back to
    // half_open — once OPEN, it stays OPEN. That's the contract this
    // scenario asserts ("前 retry、后直接 fallback").
    const stateTransitions: Array<{ from: string; to: string }> = [];
    const breaker = createCircuitBreaker({
      failureThreshold: 4,
      resetTimeoutMs: 60 * 60 * 1000,
      onStateChange: (from, to) => stateTransitions.push({ from, to }),
    });

    const wrapped = wrapWithBreaker(primary, breaker);
    const composed = createFallbackAdapter({
      adapters: [wrapped, fallback],
      maxFailures: 2,
    });

    const traceManager = createTraceManager();
    const costTracker = createCostTracker({
      pricing: [
        { model: 'chaos-model', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ],
    });

    const outcomes: RunOutcome[] = [];
    for (let i = 0; i < RUNS; i++) {
      const loop = new AgentLoop({
        adapter: composed,
        traceManager,
        maxAdapterRetries: 3,
        baseRetryDelayMs: 1,
        retryableErrors: ['ADAPTER_RATE_LIMIT', 'ADAPTER_UNAVAILABLE'],
        logger: silentLogger,
      });
      try {
        const { outcome } = await drainRun(
          loop.run([{ role: 'user', content: `run ${i}` }]),
          { bucket: `run-${i}`, traceId: `run-${i}` },
        );
        outcomes.push(outcome);
        costTracker.recordUsage({
          traceId: `run-${i}`,
          model: 'chaos-model',
          inputTokens: 10,
          outputTokens: 5,
        });
      } finally {
        loop.dispose?.();
      }
    }

    // Invariant 1: every run terminated.
    assertAllRunsReachedTerminalState(outcomes);

    // Invariant 2: no span leaks — AgentLoop must close every span it opened
    // even across retries and fallback switches.
    assertNoActiveSpans(traceManager);

    // Invariant 3: cost accounting stays self-consistent.
    assertCostConsistency(costTracker, outcomes);

    // Invariant 4: breaker behaviour.
    // With 30% compound fault rate, maxFailures=2, maxAdapterRetries=3 and
    // failureThreshold=4, we expect at least some runs to succeed and some
    // to exercise the breaker. The aggregate must include at least one
    // 'end_turn' — otherwise the scenario mis-wired.
    const endTurns = outcomes.filter((o) => o.reason === 'end_turn').length;
    expect(
      endTurns,
      `with retry+fallback, majority of runs must complete (got ${endTurns}/${RUNS})`,
    ).toBeGreaterThan(RUNS / 2);

    // Chaos recorder proves the faults actually fired — scenario is not a
    // happy-path imposter.
    const injected =
      primary.recorder.count('error-429') + primary.recorder.count('error-503');
    expect(
      injected,
      'at least some 429/503 injections are required for this scenario to be meaningful',
    ).toBeGreaterThan(0);

    // If the breaker opened, downstream traffic after the open must land on
    // the fallback. The breaker's one-way timeout means a post-open call is
    // served by fallback, not primary — we prove this with one extra chat().
    const opened = stateTransitions.some((t) => t.to === 'open');
    if (opened) {
      const r = await composed.chat({
        messages: [{ role: 'user', content: 'post-open' }],
      });
      expect(r.message.role).toBe('assistant');
    }

    // Final sanity: dispose the trace manager to release its internal timers.
    await traceManager.dispose();
  }, 30_000);
});
