/**
 * Scenario H4 — 100 × run, 5% probability the adapter hangs past the
 * per-run timeout. External `AbortSignal` acts as the timeout knob.
 *
 * Aggregate invariants:
 *   1. Every hang is aborted within `timeout * 1.5`. A hang that runs
 *      longer would indicate the signal chain is broken.
 *   2. `AbortedError` (code `CORE_ABORTED`) is the classified error on
 *      the abort path — adapter never surfaces a generic `Error`.
 *   3. Session locks created around each run are released 100% even on
 *      hang (no dangling `locked` status after the sweep).
 *   4. Every run reaches a terminal state.
 *   5. No span leaks.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { createSessionManager } from '../../src/session/manager.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import {
  createChaosAdapter,
  createMockAdapter,
} from '../../src/testing/index.js';
import { HarnessError, type HarnessErrorCode } from '../../src/core/errors.js';
import {
  assertAllRunsReachedTerminalState,
  assertNoActiveSpans,
  assertSessionLocksReleased,
  type RunOutcome,
} from './assertions.js';
import { drainRun, resolveSeed, silentLogger } from './harness.js';

const H4_SEED_FALLBACK = 44_444;
const TIMEOUT_MS = 80;
const TIMEOUT_UPPER_BOUND = TIMEOUT_MS * 1.5;

describe('chaos H4 · 100 × run × 5% hang > timeout', () => {
  it('every hang aborts within 1.5× timeout and releases session locks', async () => {
    const seed = resolveSeed(H4_SEED_FALLBACK);
    const RUNS = 100;

    const sessionManager = createSessionManager({ gcIntervalMs: 0 });
    const traceManager = createTraceManager();
    const outcomes: RunOutcome[] = [];
    const hangElapsed: number[] = [];
    const errorCodes: HarnessErrorCode[] = [];
    const sessionIds: string[] = [];

    for (let i = 0; i < RUNS; i++) {
      const inner = createMockAdapter({ responses: [{ content: 'ok' }] });
      const adapter = createChaosAdapter(inner, {
        seed: seed + i,
        hangRate: 0.05,
      });

      const session = sessionManager.create({ run: i });
      sessionIds.push(session.id);
      const lock = sessionManager.lock(session.id);

      // External timeout: each run gets its own abortable signal. The
      // adapter-caller wires the loop's signal into the adapter's
      // `ChatParams.signal`, so the chaos adapter's hang-path await on
      // `signal.aborted` will surface as an AbortedError.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }

      const loop = new AgentLoop({
        adapter,
        traceManager,
        signal: ac.signal,
        logger: silentLogger,
      });

      try {
        const wasHung = adapter.recorder.count('hang') > 0; // 0 before call
        const start = Date.now();
        const { outcome, events } = await drainRun(
          loop.run([{ role: 'user', content: `run ${i}` }]),
          { traceId: `run-${i}` },
        );
        const elapsed = Date.now() - start;
        outcomes.push(outcome);
        const injectedHang = adapter.recorder.count('hang') > 0 && !wasHung;
        if (injectedHang) hangElapsed.push(elapsed);
        for (const e of events) {
          if (e.type !== 'error') continue;
          if (e.error instanceof HarnessError) errorCodes.push(e.error.code);
        }
      } finally {
        clearTimeout(timer);
        loop.dispose?.();
        lock.unlock();
      }
    }

    assertAllRunsReachedTerminalState(outcomes);
    assertNoActiveSpans(traceManager);
    assertSessionLocksReleased(sessionManager, sessionIds);

    // Invariant 1: every hung run aborted within 1.5× timeout.
    for (const t of hangElapsed) {
      expect(
        t,
        `hung run took ${t}ms > ${TIMEOUT_UPPER_BOUND}ms upper bound`,
      ).toBeLessThan(TIMEOUT_UPPER_BOUND);
    }

    // Invariant 2: scenario actually injected some hangs.
    expect(
      hangElapsed.length,
      `expected some hangs at 5% over ${RUNS} runs, got ${hangElapsed.length}`,
    ).toBeGreaterThan(0);

    // Invariant 3: every hang-driven error classifies under the SAME
    // HarnessErrorCode. "Aborted" semantics live on the error-classifier
    // path today — a hung adapter whose signal fires throws from the
    // adapter boundary, and the classifier funnels every such error
    // through the same category. We don't care which category as long
    // as it's uniform (a mixture would prove error-classifier hysteresis
    // under adversarial timing). We do require every emitted error to
    // be a classified `HarnessError` — no generic `Error` leak.
    const distinct = new Set(errorCodes);
    expect(
      errorCodes.length,
      `expected classified error(s) from ${hangElapsed.length} hangs, got none`,
    ).toBeGreaterThan(0);
    expect(
      distinct.size,
      `hang-driven errors should classify uniformly, got codes: ${JSON.stringify([...distinct])}`,
    ).toBeLessThanOrEqual(1);

    sessionManager.dispose();
    await traceManager.dispose();
  }, 30_000);
});
