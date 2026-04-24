import { describe, expect, it } from 'vitest';

import { computeStats, isoWeek, renderWeekly } from '../src/weekly.js';
import type { RunReport } from '../src/types.js';

function report(overrides: Partial<RunReport>): RunReport {
  return {
    schemaVersion: 1,
    harnessVersion: '0.1.0',
    timestamp: '2026-04-24T12:00:00.000Z',
    repository: 'a/b',
    issueNumber: 1,
    issueBodyFingerprint: 'x',
    durationMs: 100,
    status: 'success',
    cost: { usd: 0.01, inputTokens: 100, outputTokens: 50 },
    mocked: false,
    ...overrides,
  };
}

describe('computeStats', () => {
  it('counts statuses and sums cost', () => {
    const stats = computeStats([
      report({ status: 'success' }),
      report({ status: 'guardrail_blocked', errorCode: 'VERDICT_PARSE_ERROR' }),
      report({ status: 'error', errorCode: 'UNCAUGHT' }),
      report({ status: 'success', mocked: true, cost: { usd: 0.05, inputTokens: 0, outputTokens: 0 } }),
    ]);
    expect(stats.totalRuns).toBe(4);
    expect(stats.successRuns).toBe(2);
    expect(stats.guardrailBlocked).toBe(1);
    expect(stats.errorRuns).toBe(1);
    expect(stats.mockRuns).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(0.08);
    expect(stats.topErrorCodes[0]?.code).toBeDefined();
  });

  it('sorts error codes by frequency then alphabetical', () => {
    const stats = computeStats([
      report({ status: 'error', errorCode: 'A' }),
      report({ status: 'error', errorCode: 'B' }),
      report({ status: 'error', errorCode: 'B' }),
    ]);
    expect(stats.topErrorCodes).toEqual([
      { code: 'B', count: 2 },
      { code: 'A', count: 1 },
    ]);
  });

  it('computes p50 / p95 from durationMs', () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = computeStats(latencies.map((ms) => report({ durationMs: ms })));
    expect(stats.p50LatencyMs).toBe(60);
    expect(stats.p95LatencyMs).toBe(100);
  });

  it('handles empty input without crashing', () => {
    const stats = computeStats([]);
    expect(stats.totalRuns).toBe(0);
    expect(stats.p50LatencyMs).toBe(0);
  });
});

describe('renderWeekly', () => {
  it('produces a deterministic markdown snapshot', () => {
    const stats = computeStats([
      report({ status: 'success' }),
      report({ status: 'error', errorCode: 'UNCAUGHT' }),
    ]);
    const body = renderWeekly(
      { year: 2026, week: 17 },
      stats,
      new Date('2026-04-24T00:00:00.000Z'),
    );
    expect(body).toContain('# Dogfood weekly report · 2026-W17');
    expect(body).toContain('Runs: **2**');
    expect(body).toContain('`UNCAUGHT` × 1');
    expect(body).toContain('`0.1.0` × 2');
  });
});

describe('isoWeek', () => {
  it('matches known ISO week boundaries', () => {
    // 2021-01-04 is the start of ISO week 1 of 2021 — classic boundary case.
    expect(isoWeek(new Date('2021-01-04T00:00:00.000Z'))).toEqual({ year: 2021, week: 1 });
    expect(isoWeek(new Date('2026-04-24T00:00:00.000Z'))).toEqual({ year: 2026, week: 17 });
  });
});
