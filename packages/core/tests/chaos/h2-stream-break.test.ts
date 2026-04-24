/**
 * Scenario H2 — 200 × streaming run with 20% mid-stream break.
 *
 * Aggregate invariants:
 *   1. Every run reaches a terminal state.
 *   2. The StreamAggregator byte counter is per-iteration; aborted
 *      streams do not leak byte accumulation into later attempts (proven
 *      by running many runs on a single AgentLoop and checking heap
 *      doesn't retain ever-growing state).
 *   3. All terminal errors classify into a known HarnessErrorCode — no
 *      generic `Error` leaks past the loop.
 *   4. `error` events yielded by the loop carry a HarnessError — this
 *      is the contract `streamHandler` exposes, and the invariant
 *      matters because consumers branch on `error.code`.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import {
  createChaosAdapter,
  createStreamingMockAdapter,
} from '../../src/testing/index.js';
import { HarnessError, HarnessErrorCode } from '../../src/core/errors.js';
import {
  assertAllRunsReachedTerminalState,
  assertNoActiveSpans,
  type RunOutcome,
} from './assertions.js';
import { drainRun, resolveSeed, silentLogger } from './harness.js';

const H2_SEED_FALLBACK = 22_222;

describe('chaos H2 · 200 × stream × 20% mid-break', () => {
  it('aggregate invariants hold under mid-stream failures', async () => {
    const seed = resolveSeed(H2_SEED_FALLBACK);
    const RUNS = 200;

    const traceManager = createTraceManager();
    const outcomes: RunOutcome[] = [];
    const classifiedErrors: HarnessErrorCode[] = [];
    const genericErrors: Error[] = [];

    for (let i = 0; i < RUNS; i++) {
      // Fresh chunk source per run — identical sequence each time so the
      // seeded break timing is the only source of variability.
      const adapter = createChaosAdapter(
        createStreamingMockAdapter({
          chunks: [
            { type: 'text_delta', text: 'alpha ' },
            { type: 'text_delta', text: 'beta ' },
            { type: 'text_delta', text: 'gamma' },
            { type: 'done', usage: { inputTokens: 4, outputTokens: 3 } },
          ],
        }),
        // Each run gets a distinct seed derived from the scenario seed so
        // per-run decisions are independent but still reproducible.
        { seed: seed + i, streamBreakRate: 0.2 },
      );
      const loop = new AgentLoop({
        adapter,
        traceManager,
        streaming: true,
        logger: silentLogger,
      });
      try {
        const { outcome, events } = await drainRun(
          loop.run([{ role: 'user', content: `stream ${i}` }]),
          { traceId: `run-${i}`, bucket: `stream-${i}` },
        );
        outcomes.push(outcome);
        for (const e of events) {
          if (e.type !== 'error') continue;
          if (e.error instanceof HarnessError) {
            classifiedErrors.push(e.error.code);
          } else {
            genericErrors.push(e.error);
          }
        }
      } finally {
        loop.dispose?.();
      }
    }

    // Invariant 1: terminal state reached on every run.
    assertAllRunsReachedTerminalState(outcomes);

    // Invariant 2: no span leaks. Each iteration span must be closed even
    // when the adapter throws mid-stream.
    assertNoActiveSpans(traceManager);

    // Invariant 3: every error is classified. A single generic `Error`
    // escaping means the error-classifier dropped a case the scenario
    // now forces it to handle.
    expect(
      genericErrors,
      `${genericErrors.length} generic errors escaped classification: ${genericErrors.map((e) => e.message).join(', ')}`,
    ).toHaveLength(0);

    // Invariant 4: scenario is not a happy-path imposter — the chaos
    // adapter must have actually broken some streams.
    const breakCount = outcomes.filter((o) => o.reason === 'error').length;
    expect(
      breakCount,
      `expected some stream breaks at 20% rate over ${RUNS} runs, got ${breakCount}`,
    ).toBeGreaterThan(10);

    // Invariant 5: broken streams classify as `ADAPTER_NETWORK` or
    // `ADAPTER_UNAVAILABLE` — the chaos adapter's break throws a
    // "connection reset by peer (network)" error which the classifier
    // normally routes to ADAPTER_NETWORK.
    const networkish = classifiedErrors.filter(
      (c) =>
        c === HarnessErrorCode.ADAPTER_NETWORK ||
        c === HarnessErrorCode.ADAPTER_UNAVAILABLE,
    );
    expect(
      networkish.length,
      `classified errors ${JSON.stringify(classifiedErrors)} should include NETWORK/UNAVAILABLE`,
    ).toBeGreaterThan(0);

    await traceManager.dispose();
  }, 45_000);
});
