import { describe, expect, it } from 'vitest';
import { createCostTracker } from 'harness-one/observe';

import { createBudgetTracker } from '../../src/agent/budget.js';

const limits = { tokens: 1000, iterations: 5, durationMs: 10_000 };

describe('createBudgetTracker', () => {
  it('reports null exhausted axis when fresh', () => {
    const ct = createCostTracker();
    const tracker = createBudgetTracker({ limits, costTracker: ct });
    expect(tracker.snapshot().exhaustedAxis).toBeNull();
  });

  it('flags tokens axis when usage crosses the cap', () => {
    const ct = createCostTracker();
    const tracker = createBudgetTracker({ limits, costTracker: ct });
    const snap = tracker.recordUsage({ inputTokens: 600, outputTokens: 600 });
    expect(snap.exhaustedAxis).toBe('tokens');
    expect(snap.state.tokensUsed).toBe(1200);
  });

  it('flags iterations axis after limit iterations', () => {
    const ct = createCostTracker();
    const tracker = createBudgetTracker({ limits, costTracker: ct });
    let snap = tracker.snapshot();
    for (let i = 0; i < 5; i++) snap = tracker.recordIteration();
    expect(snap.exhaustedAxis).toBe('iterations');
    expect(snap.state.iterations).toBe(5);
  });

  it('flags duration axis when wall-clock crosses the cap', () => {
    const ct = createCostTracker();
    let now = 1_000_000;
    const tracker = createBudgetTracker({
      limits,
      costTracker: ct,
      now: () => now,
    });
    now += 11_000;
    const snap = tracker.tick();
    expect(snap.exhaustedAxis).toBe('duration');
  });

  it('seeds from initial state', () => {
    const ct = createCostTracker();
    const tracker = createBudgetTracker({
      limits,
      costTracker: ct,
      initial: { tokensUsed: 500, iterations: 2, elapsedMs: 100, costUsd: 0.5 },
    });
    expect(tracker.snapshot().state.tokensUsed).toBe(500);
    expect(tracker.snapshot().state.iterations).toBe(2);
  });

  it('updates costUsd via the cost tracker', () => {
    const ct = createCostTracker({
      pricing: [
        {
          model: 'mock-model',
          inputPer1kTokens: 1,
          outputPer1kTokens: 2,
        },
      ],
    });
    const tracker = createBudgetTracker({ limits, costTracker: ct });
    const snap = tracker.recordUsage(
      { inputTokens: 1000, outputTokens: 500 },
      'mock-model',
    );
    expect(snap.state.costUsd).toBeGreaterThan(0);
  });
});
