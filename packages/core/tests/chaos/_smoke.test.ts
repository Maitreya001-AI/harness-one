/**
 * Smoke test: the chaos scaffolding (assertions, harness, seeded PRNG)
 * actually resolves from `tests/chaos/` — this file is intentionally
 * minimal so a failing import is surfaced in isolation before any
 * scenario runs.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { createMockAdapter, createChaosAdapter } from '../../src/testing/index.js';
import {
  assertAllRunsReachedTerminalState,
  assertCostConsistency,
  type RunOutcome,
} from './assertions.js';
import { drainRun, resolveSeed } from './harness.js';
import { createCostTracker } from '../../src/observe/cost-tracker.js';

describe('chaos scaffolding · smoke', () => {
  it('resolveSeed honours the explicit override', () => {
    expect(resolveSeed(1, 42)).toBe(42);
  });

  it('drainRun captures done reason + elapsed time', async () => {
    const adapter = createChaosAdapter(
      createMockAdapter({ responses: [{ content: 'hi' }] }),
      { seed: 1 },
    );
    const loop = new AgentLoop({ adapter });
    const { outcome, events } = await drainRun(loop.run([{ role: 'user', content: 'ping' }]));
    expect(outcome.reason).toBe('end_turn');
    expect(outcome.status).toBe('completed');
    expect(events.find((e) => e.type === 'message')).toBeDefined();
  });

  it('assertions compile and run against a trivial baseline', () => {
    const runs: RunOutcome[] = [
      { reason: 'end_turn', status: 'completed', elapsedMs: 1 },
      { reason: 'end_turn', status: 'completed', elapsedMs: 1 },
    ];
    assertAllRunsReachedTerminalState(runs);
    const tracker = createCostTracker();
    assertCostConsistency(tracker, runs);
  });
});
