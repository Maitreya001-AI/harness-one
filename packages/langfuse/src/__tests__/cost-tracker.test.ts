/**
 * Tests for `createLangfuseCostTracker`. Covers KahanSum drift,
 * Map-backed per-key totals, budget checks, budget snapshotting, event
 * emission, flush error routing, and dispose() drain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLangfuseCostTracker } from '../index.js';
import type { CostAlert } from 'harness-one/observe';
import { createMockLangfuse } from './langfuse-test-fixtures.js';

describe('createLangfuseCostTracker', () => {
  let mock: ReturnType<typeof createMockLangfuse>;

  beforeEach(() => {
    mock = createMockLangfuse();
  });

  it('records usage and computes cost', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(record.estimatedCost).toBeCloseTo(0.003 + 0.0075);
    expect(tracker.getTotalCost()).toBeCloseTo(0.0105);
  });

  it('exports usage as Langfuse generation', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'gpt-4', inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 },
      ],
    });

    tracker.recordUsage({
      traceId: 't1',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 200,
    });

    expect(mock.mocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
    );
    expect(mock.mocks.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4',
        usage: { input: 500, output: 200 },
      }),
    );
  });

  it('calls flushAsync after recording usage to persist generation', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'gpt-4', inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 },
      ],
    });

    tracker.recordUsage({
      traceId: 't1',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 200,
    });

    // flushAsync should be called after each recordUsage to persist the generation
    expect(mock.mocks.flushAsync).toHaveBeenCalled();
  });

  it('tracks cost by model', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
        { model: 'b', inputPer1kTokens: 0.01, outputPer1kTokens: 0.02 },
      ],
    });

    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    tracker.recordUsage({ traceId: 't2', model: 'b', inputTokens: 1000, outputTokens: 1000 });

    const byModel = tracker.getCostByModel();
    expect(byModel.get('a')).toBeCloseTo(0.003);
    expect(byModel.get('b')).toBeCloseTo(0.03);
  });

  it('tracks cost by trace', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ],
    });

    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 2000, outputTokens: 2000 });

    expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.003);
    expect(tracker.getCostByTrace('t2')).toBeCloseTo(0.006);
  });

  it('emits budget alerts', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ],
      budget: 1.0,
    });

    const alerts: CostAlert[] = [];
    tracker.onAlert((a) => alerts.push(a));

    // 85% usage -> warning
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 425, outputTokens: 425 });
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe('warning');

    // 96% usage -> critical
    tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 55, outputTokens: 55 });
    expect(alerts.length).toBe(2);
    expect(alerts[1].type).toBe('critical');
  });

  it('reset clears all records and running total', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ],
    });
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    tracker.reset();
    expect(tracker.getTotalCost()).toBe(0);
  });

  it('records usage with cache tokens included in cost computation', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [{
        model: 'claude-3',
        inputPer1kTokens: 0.003,
        outputPer1kTokens: 0.015,
        cacheReadPer1kTokens: 0.001,
        cacheWritePer1kTokens: 0.002,
      }],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    });

    // input: 1000/1000 * 0.003 = 0.003
    // output: 500/1000 * 0.015 = 0.0075
    // cacheRead: 200/1000 * 0.001 = 0.0002
    // cacheWrite: 100/1000 * 0.002 = 0.0002
    const expected = 0.003 + 0.0075 + 0.0002 + 0.0002;
    expect(record.estimatedCost).toBeCloseTo(expected);
  });

  it('returns 0 cost when inputTokens is NaN (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: NaN,
      outputTokens: 500,
    });

    // H1: NaN token counts must produce cost of 0, not NaN
    expect(record.estimatedCost).toBe(0);
    expect(Number.isNaN(record.estimatedCost)).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);

    // Should have warned about invalid token counts
    const invalidWarns = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('Invalid token counts'),
    );
    expect(invalidWarns.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when outputTokens is NaN (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: NaN,
    });

    expect(record.estimatedCost).toBe(0);
    expect(Number.isNaN(record.estimatedCost)).toBe(false);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when inputTokens is Infinity (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: Infinity,
      outputTokens: 500,
    });

    expect(record.estimatedCost).toBe(0);
    expect(Number.isFinite(record.estimatedCost)).toBe(true);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when outputTokens is -Infinity (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: -Infinity,
    });

    expect(record.estimatedCost).toBe(0);
    expect(Number.isFinite(record.estimatedCost)).toBe(true);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when both tokens are NaN (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: NaN,
      outputTokens: NaN,
    });

    expect(record.estimatedCost).toBe(0);
    // Total cost should not be NaN either
    expect(Number.isNaN(tracker.getTotalCost())).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);
    warnSpy.mockRestore();
  });

  it('computes normal cost when token counts are valid finite numbers (H1 baseline)', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      ],
    });

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: 500,
    });

    // Normal case: 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
    expect(record.estimatedCost).toBeCloseTo(0.0105);
    expect(Number.isFinite(record.estimatedCost)).toBe(true);
  });

  it('returns 0 cost for unknown models', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    // No pricing set for this model
    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'unknown-model',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(record.estimatedCost).toBe(0);
  });

  it('checkBudget returns null when no budget is set', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    expect(tracker.checkBudget()).toBeNull();
  });

  it('checkBudget returns null when usage is below warning threshold', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 },
      ],
      budget: 10.0,
    });
    // Very small usage, well below 80%
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
    expect(tracker.checkBudget()).toBeNull();
  });

  it('getAlertMessage returns null when no budget is set', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    expect(tracker.getAlertMessage()).toBeNull();
  });

  it('getAlertMessage returns null when below threshold', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 },
      ],
      budget: 10.0,
    });
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
    expect(tracker.getAlertMessage()).toBeNull();
  });

  it('getAlertMessage returns warning message at 80%+ usage', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ],
      budget: 1.0,
    });
    // 85% usage
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 425, outputTokens: 425 });
    const msg = tracker.getAlertMessage();
    expect(msg).toContain('BUDGET WARNING');
    expect(msg).toContain('be concise');
  });

  it('getAlertMessage returns critical message at 95%+ usage', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ],
      budget: 1.0,
    });
    // 96% usage
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 480, outputTokens: 480 });
    const msg = tracker.getAlertMessage();
    expect(msg).toContain('BUDGET CRITICAL');
    expect(msg).toContain('extremely concise');
  });

  it('does not emit alert when usage is below warning threshold', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 },
      ],
      budget: 100.0,
    });

    const alerts: CostAlert[] = [];
    tracker.onAlert((a) => alerts.push(a));

    // Very small usage
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
    expect(alerts).toHaveLength(0);
  });

  it('getCostByTrace returns 0 for unknown traceId', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    expect(tracker.getCostByTrace('nonexistent')).toBe(0);
  });

  it('evicts oldest records when exceeding maxRecords (10,000) and adjusts runningTotal', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.0 },
      ],
    });

    // Record 10,001 usages — the first record should be evicted
    for (let i = 0; i < 10_001; i++) {
      tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1000, outputTokens: 0 });
    }

    // Each record costs 0.001. After eviction, 10,000 records remain.
    // runningTotal should reflect 10,000 records, not 10,001.
    expect(tracker.getTotalCost()).toBeCloseTo(10.0, 2);

    // The first trace should have been evicted, so getCostByTrace returns 0
    expect(tracker.getCostByTrace('t0')).toBe(0);
    // The last trace should still be present
    expect(tracker.getCostByTrace('t10000')).toBeCloseTo(0.001);
  });

  it('resets recordsSinceRecalibrate on reset()', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.0 },
      ],
    });

    // Record some usages, then reset, then record more
    for (let i = 0; i < 500; i++) {
      tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1000, outputTokens: 0 });
    }
    tracker.reset();
    expect(tracker.getTotalCost()).toBe(0);

    // After reset, recording should still work correctly
    tracker.recordUsage({ traceId: 'post-reset', model: 'a', inputTokens: 1000, outputTokens: 0 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.001);
  });

  // Empty pricing map warns once per model
  it('warns once per unknown model when no pricing is configured', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    // No pricing set -- record multiple usages for the same unknown model
    tracker.recordUsage({ traceId: 't1', model: 'unknown-model', inputTokens: 1000, outputTokens: 0 });
    tracker.recordUsage({ traceId: 't2', model: 'unknown-model', inputTokens: 1000, outputTokens: 0 });
    tracker.recordUsage({ traceId: 't3', model: 'another-unknown', inputTokens: 1000, outputTokens: 0 });

    // Should warn once per model, not per call
    const unknownModelWarns = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('No pricing configured'),
    );
    expect(unknownModelWarns).toHaveLength(2); // one for 'unknown-model', one for 'another-unknown'
    warnSpy.mockRestore();
  });

  // Flush errors are logged, not silently swallowed
  it('logs flush errors via console.warn instead of silently swallowing', () => {
    const flushError = new Error('flush network error');
    mock.mocks.flushAsync.mockRejectedValue(flushError);
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
    });
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

    // Allow promise rejection to be handled
    return new Promise<void>(resolve => setTimeout(() => {
      const flushWarns = warnSpy.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('flush error'),
      );
      expect(flushWarns.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
      resolve();
    }, 20));
  });

  // maxRecords validation routes through the shared `requirePositiveInt`
  // helper; message normalised to match.
  it('throws when maxRecords is less than 1', () => {
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: 0 }))
      .toThrow('maxRecords must be a positive integer');
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: -5 }))
      .toThrow('maxRecords must be a positive integer');
  });

  it('does not throw when maxRecords is 1 or greater', () => {
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: 1 }))
      .not.toThrow();
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: 100 }))
      .not.toThrow();
  });

  it('does not throw when maxRecords is undefined (uses default)', () => {
    expect(() => createLangfuseCostTracker({ client: mock.client }))
      .not.toThrow();
  });

  it('does not throw when maxRecords is explicitly undefined', () => {
    // Explicit-undefined is distinct from key-omitted because some validators
    // treat them differently. Confirm both call-shapes default cleanly.
    expect(() =>
      createLangfuseCostTracker({ client: mock.client, maxRecords: undefined }),
    ).not.toThrow();
    // And the tracker should actually accept records without blowing up,
    // proving the default was substituted.
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      maxRecords: undefined,
      pricing: [
        { model: 'gpt-x', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ],
    });
    expect(() =>
      tracker.recordUsage({ model: 'gpt-x', inputTokens: 10, outputTokens: 5 }),
    ).not.toThrow();
  });

  it('getTotalCost uses running total (O(1)) not reduce (O(N))', () => {
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      pricing: [
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ],
    });

    // Record multiple usages and verify total is correctly maintained
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.003);

    tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 2000, outputTokens: 2000 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.009);

    // After reset, total should be 0
    tracker.reset();
    expect(tracker.getTotalCost()).toBe(0);

    // New records after reset
    tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.001);
  });

  // -------------------------------------------------------------------------
  // Kahan summation + Map-backed per-key totals + exceeded branch
  // -------------------------------------------------------------------------

  describe('KahanSum running total', () => {
    it('accumulates many tiny costs without drifting from exact sum', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          // 1 token => 0.0000001 dollars (a value not representable exactly in float)
          { model: 'a', inputPer1kTokens: 0.0001, outputPer1kTokens: 0 },
        ],
      });

      const N = 2500;
      for (let i = 0; i < N; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // Naive summation drifts off by many ULPs after thousands of adds.
      // KahanSum should land within 1e-12 of the mathematical total.
      const expected = N * (0.0001 / 1000);
      const actual = tracker.getTotalCost();
      expect(Math.abs(actual - expected)).toBeLessThan(1e-12);
    });

    it('keeps running total stable past the 1000-record boundary (no recalibration gap)', () => {
      // BUG REPRODUCTION: prior implementation recalibrated every 1000
      // records via O(N) reduce(). Totals just above / below 1000 should
      // both be accurate without requiring a reduction pass.
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 0.0003, outputPer1kTokens: 0 },
        ],
      });

      for (let i = 0; i < 999; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }
      const at999 = tracker.getTotalCost();

      tracker.recordUsage({ traceId: 't999', model: 'a', inputTokens: 1, outputTokens: 0 });
      const at1000 = tracker.getTotalCost();

      tracker.recordUsage({ traceId: 't1000', model: 'a', inputTokens: 1, outputTokens: 0 });
      const at1001 = tracker.getTotalCost();

      const step = 0.0003 / 1000;
      expect(Math.abs(at1000 - (at999 + step))).toBeLessThan(1e-12);
      expect(Math.abs(at1001 - (at1000 + step))).toBeLessThan(1e-12);
    });
  });

  describe('Map-backed per-key totals', () => {
    it('getCostByModel uses maintained map (not array scan)', () => {
      // After eviction, the map-backed total should still exclude evicted rows.
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        maxRecords: 3,
        pricing: [
          { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 },
          { model: 'b', inputPer1kTokens: 0.002, outputPer1kTokens: 0 },
        ],
      });

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'b', inputTokens: 1000, outputTokens: 0 });
      // Evict t1 (model 'a')
      tracker.recordUsage({ traceId: 't4', model: 'b', inputTokens: 1000, outputTokens: 0 });

      const byModel = tracker.getCostByModel();
      // model 'a': 1 record remaining (the other was evicted) => 0.001
      expect(byModel.get('a')).toBeCloseTo(0.001, 8);
      // model 'b': 2 records => 0.004
      expect(byModel.get('b')).toBeCloseTo(0.004, 8);
    });

    it('getCostByTrace is O(1) via maintained map and excludes evicted traces', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        maxRecords: 2,
        pricing: [
          { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 },
        ],
      });

      tracker.recordUsage({ traceId: 'keep-me', model: 'a', inputTokens: 1000, outputTokens: 0 });
      // Evict the above by pushing two more records
      tracker.recordUsage({ traceId: 'x1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 'x2', model: 'a', inputTokens: 1000, outputTokens: 0 });

      // 'keep-me' has been evicted from the retained window
      expect(tracker.getCostByTrace('keep-me')).toBe(0);
      expect(tracker.getCostByTrace('x1')).toBeCloseTo(0.001, 8);
      expect(tracker.getCostByTrace('x2')).toBeCloseTo(0.001, 8);
    });

    it('updateUsage adjusts per-model and per-trace totals incrementally', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
        ],
      });

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
      expect(tracker.getCostByModel().get('a')).toBeCloseTo(0.003);
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.003);

      // Double the tokens on the same record — cost doubles
      tracker.updateUsage!('t1', { inputTokens: 2000, outputTokens: 2000 });
      expect(tracker.getCostByModel().get('a')).toBeCloseTo(0.006);
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.006);
    });
  });

  describe('exceeded branch in checkBudget / isBudgetExceeded', () => {
    it('checkBudget returns an exceeded alert when actual >= hard budget', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      // 100% usage exactly
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 500, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('exceeded');
      expect(alert!.percentUsed).toBeGreaterThanOrEqual(1.0);
      expect(alert!.message).toContain('Exceeded');
    });

    it('checkBudget returns exceeded (not critical) when over budget', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      // 150% usage — must surface as 'exceeded', not 'critical'.
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 750, outputTokens: 750 });
      const alert = tracker.checkBudget();
      expect(alert!.type).toBe('exceeded');
    });

    it('emits an exceeded alert through onAlert when the budget is breached', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      const alerts: CostAlert[] = [];
      tracker.onAlert(a => alerts.push(a));

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      const exceeded = alerts.filter(a => a.type === 'exceeded');
      expect(exceeded.length).toBe(1);
    });

    it('isBudgetExceeded / shouldStop agree with checkBudget=exceeded', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      // Not yet exceeded
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
      expect(tracker.isBudgetExceeded()).toBe(false);
      expect(tracker.shouldStop()).toBe(false);
      expect(tracker.checkBudget()?.type).not.toBe('exceeded');

      // Exceed
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 500, outputTokens: 500 });
      expect(tracker.isBudgetExceeded()).toBe(true);
      expect(tracker.shouldStop()).toBe(true);
      expect(tracker.checkBudget()!.type).toBe('exceeded');
    });

    it('getAlertMessage reports BUDGET EXCEEDED when over budget', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      expect(tracker.getAlertMessage()).toContain('BUDGET EXCEEDED');
    });
  });

  // -------------------------------------------------------------------------
  // Budget race condition — snapshot-based budget check
  // -------------------------------------------------------------------------

  describe('budget snapshot prevents mid-check mutation', () => {
    it('uses a consistent budget snapshot throughout recordUsage', async () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 10.0,
      });

      const alerts: CostAlert[] = [];
      tracker.onAlert((a) => alerts.push(a));

      // Record usage well below the budget — should produce no alert
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
      expect(alerts).toHaveLength(0);

      // If budget were read live (not snapshotted), a concurrent updateBudget(0.01)
      // mid-recordUsage could cause the check to fire for a budget that wasn't
      // set when the call began. With the snapshot, this is safe.
      await tracker.updateBudget(0.01);
      // The previous recordUsage already completed, so the new budget only
      // affects future calls.
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1, outputTokens: 1 });
      // Now the budget is exceeded (cost > 0.01)
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Budget-exceeded Langfuse event emission (with dedupe)
  // -------------------------------------------------------------------------

  describe('budget_exceeded event emission', () => {
    it('emits a Langfuse event named "budget_exceeded" when shouldStop() flips true', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });

      expect(mock.mocks.event).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'budget_exceeded',
          level: 'ERROR',
          metadata: expect.objectContaining({
            model: 'a',
            budget: 1.0,
          }),
        }),
      );
    });

    it('dedupes budget_exceeded events by (model + budget) across multiple overages', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      // Three separate overages for the same (model, budget) => single event.
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });

      const calls = mock.mocks.event.mock.calls.filter(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'budget_exceeded',
      );
      expect(calls.length).toBe(1);
    });

    it('re-emits budget_exceeded after updateBudget() opens a fresh window', async () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });

      // Flip to a new budget — dedupe window resets.
      await tracker.updateBudget(0.5);
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 10, outputTokens: 10 });

      const calls = mock.mocks.event.mock.calls.filter(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'budget_exceeded',
      );
      expect(calls.length).toBe(2);
    });

    it('does NOT emit budget_exceeded while still within critical band', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });
      // 98% => critical but not exceeded
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 490, outputTokens: 490 });

      const calls = mock.mocks.event.mock.calls.filter(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'budget_exceeded',
      );
      expect(calls.length).toBe(0);
    });

    it('increments stats.budgetExceededEvents only for true exceedance', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      expect(tracker.getStats().budgetExceededEvents).toBe(1);
    });

    it('swallows event() failures without breaking recordUsage', () => {
      mock.mocks.event.mockImplementation(() => {
        throw new Error('event send failed');
      });
      const onExportError = vi.fn();
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      // Should NOT throw despite event() blowing up
      expect(() => {
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      }).not.toThrow();

      // onExportError was notified with op='record'
      expect(onExportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ op: 'record' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Flush errors route through onExportError / logger / fallback
  // -------------------------------------------------------------------------

  describe('flush error handling', () => {
    it('calls onExportError with op="flush" when provided', async () => {
      const flushError = new Error('boom');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const onExportError = vi.fn();

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      expect(onExportError).toHaveBeenCalledWith(
        flushError,
        expect.objectContaining({ op: 'flush' }),
      );
    });

    it('falls back to logger.error when no onExportError is provided', async () => {
      const flushError = new Error('network down');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        logger: logger as never,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('export error'),
        expect.objectContaining({ op: 'flush' }),
      );
    });

    it('falls back to console.warn when neither onExportError nor logger is configured', async () => {
      const flushError = new Error('legacy path');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      const flushWarns = warnSpy.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('flush error'),
      );
      expect(flushWarns.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });

    it('does not invoke logger.error when onExportError IS provided', async () => {
      const flushError = new Error('only onExportError');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const onExportError = vi.fn();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        logger: logger as never,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      expect(onExportError).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('exposes flushErrors count via getStats()', async () => {
      mock.mocks.flushAsync.mockRejectedValue(new Error('flaky'));
      const onExportError = vi.fn();

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 30));

      expect(tracker.getStats().flushErrors).toBe(3);
      expect(tracker.getStats().records).toBe(3);
    });

    it('reset() clears flushErrors and budgetExceededEvents counters', async () => {
      mock.mocks.flushAsync.mockRejectedValue(new Error('flaky'));
      const onExportError = vi.fn();
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 }],
        budget: 1.0,
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      await new Promise(r => setTimeout(r, 20));

      expect(tracker.getStats().flushErrors).toBeGreaterThan(0);
      expect(tracker.getStats().budgetExceededEvents).toBe(1);

      tracker.reset();
      expect(tracker.getStats()).toEqual({
        records: 0,
        flushErrors: 0,
        budgetExceededEvents: 0,
      });
    });

    it('onAlert unsubscribe function removes the handler', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });

      const alerts: CostAlert[] = [];
      const unsubscribe = tracker.onAlert(a => alerts.push(a));

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 425, outputTokens: 425 });
      expect(alerts.length).toBe(1);

      unsubscribe();
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 100, outputTokens: 100 });
      // No further alerts after unsubscribe
      expect(alerts.length).toBe(1);
    });

    it('onAlert unsubscribe is idempotent', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      const unsubscribe = tracker.onAlert(() => {});
      unsubscribe();
      // Second call must not throw (handler already removed)
      expect(() => unsubscribe()).not.toThrow();
    });

    it('updateUsage re-fires budget alerts when the delta crosses the threshold', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 1.0,
      });
      const alerts: CostAlert[] = [];
      tracker.onAlert(a => alerts.push(a));

      // 20% usage — no alert yet
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
      expect(alerts.length).toBe(0);

      // Bump the same record to 85% — should trigger a warning alert
      tracker.updateUsage!('t1', { inputTokens: 425, outputTokens: 425 });
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[alerts.length - 1].type).toBe('warning');
    });

    it('budgetUtilization returns 0 when budget is 0 or unset', async () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      // No budget set
      expect(tracker.budgetUtilization()).toBe(0);
      // Budget = 0
      await tracker.updateBudget(0);
      expect(tracker.budgetUtilization()).toBe(0);
    });

    it('budgetUtilization returns cost/budget ratio when budget is set', () => {
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
        ],
        budget: 2.0,
      });
      // Cost = 1.0, budget = 2.0 => 0.5
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 500, outputTokens: 500 });
      expect(tracker.budgetUtilization()).toBeCloseTo(0.5, 6);
    });

    it('swallows exceptions thrown from onExportError itself', async () => {
      mock.mocks.flushAsync.mockRejectedValue(new Error('x'));
      const onExportError = vi.fn().mockImplementation(() => {
        throw new Error('callback misbehaved');
      });

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });

      // recordUsage must remain exception-safe even if the callback throws.
      expect(() =>
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 }),
      ).not.toThrow();

      await new Promise(r => setTimeout(r, 20));
      expect(onExportError).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Track in-flight flushAsync promises so dispose() can drain
  // them before returning. Previously these were fire-and-forget.
  // -------------------------------------------------------------------------

  describe('dispose() drains pending flushAsync promises', () => {
    it('resolves immediately when no flushes are in flight', async () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      await expect(tracker.dispose()).resolves.toBeUndefined();
    });

    it('awaits a slow flushAsync before resolving dispose()', async () => {
      const order: string[] = [];
      mock.mocks.flushAsync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              order.push('flush-settled');
              resolve();
            }, 25);
          }),
      );
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await tracker.dispose();
      order.push('dispose-returned');

      // dispose() must not return before the pending flush settles.
      expect(order).toEqual(['flush-settled', 'dispose-returned']);
    });

    it('caps dispose() at the configured timeout when flush never settles', async () => {
      vi.useFakeTimers();
      try {
        mock.mocks.flushAsync.mockImplementation(() => new Promise<void>(() => {}));
        const tracker = createLangfuseCostTracker({
          client: mock.client,
          pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
        });
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

        const p = tracker.dispose(100);
        await vi.advanceTimersByTimeAsync(101);
        await expect(p).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not propagate flushAsync rejections through dispose()', async () => {
      // handleExportError is invoked on rejection; dispose() must still
      // resolve cleanly rather than rethrowing.
      const onExportError = vi.fn();
      mock.mocks.flushAsync.mockRejectedValue(new Error('network'));
      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await expect(tracker.dispose()).resolves.toBeUndefined();
      expect(onExportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ op: 'flush' }),
      );
    });

    it('does not produce unhandled rejections when the logger throws inside handleExportError', async () => {
      // Defensive try/catch inside the .catch() handler means logger
      // exceptions cannot escape as unhandled promise rejections.
      const unhandledSpy = vi.fn();
      process.on('unhandledRejection', unhandledSpy);
      try {
        const badLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn().mockImplementation(() => {
            throw new Error('logger broken');
          }),
          child: vi.fn(),
        };
        mock.mocks.flushAsync.mockRejectedValue(new Error('network'));
        const tracker = createLangfuseCostTracker({
          client: mock.client,
          logger: badLogger as never,
          pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
        });
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

        await expect(tracker.dispose()).resolves.toBeUndefined();
        // Give any straggling rejection a chance to surface.
        await new Promise((r) => setTimeout(r, 20));
        expect(unhandledSpy).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledSpy);
      }
    });

    it('drains multiple pending flushes concurrently', async () => {
      const settled: number[] = [];
      let seq = 0;
      mock.mocks.flushAsync.mockImplementation(() => {
        const mine = seq++;
        return new Promise<void>((resolve) => {
          // Later calls settle sooner to prove allSettled doesn't serialize.
          setTimeout(() => {
            settled.push(mine);
            resolve();
          }, Math.max(5, 30 - mine * 10));
        });
      });

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await tracker.dispose();
      // All three must have settled before dispose() returns.
      expect(settled).toHaveLength(3);
      expect(settled.sort()).toEqual([0, 1, 2]);
    });
  });
});

