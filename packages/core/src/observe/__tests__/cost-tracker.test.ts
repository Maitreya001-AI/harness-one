import { describe, it, expect, vi } from 'vitest';
import { createCostTracker } from '../cost-tracker.js';

describe('createCostTracker', () => {
  const pricing = [
    { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    { model: 'gpt-4', inputPer1kTokens: 0.01, outputPer1kTokens: 0.03 },
  ];

  it('records usage and computes cost', () => {
    const tracker = createCostTracker({ pricing });
    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: 500,
    });
    // 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
    expect(record.estimatedCost).toBeCloseTo(0.0105, 4);
    expect(record.timestamp).toBeGreaterThan(0);
  });

  it('returns 0 cost for unknown model', () => {
    const tracker = createCostTracker({ pricing });
    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'unknown',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(record.estimatedCost).toBe(0);
  });

  it('includes cache token costs', () => {
    const tracker = createCostTracker({
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
      cacheReadTokens: 2000,
      cacheWriteTokens: 1000,
    });
    // input: 0.003 + output: 0.0075 + cacheRead: 0.002 + cacheWrite: 0.002 = 0.0145
    expect(record.estimatedCost).toBeCloseTo(0.0145, 4);
  });

  describe('getTotalCost', () => {
    it('sums all recorded costs', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.getTotalCost()).toBeCloseTo(0.006, 4);
    });
  });

  describe('getCostByModel', () => {
    it('breaks down costs by model', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'gpt-4', inputTokens: 1000, outputTokens: 0 });
      const byModel = tracker.getCostByModel();
      expect(byModel['claude-3']).toBeCloseTo(0.003, 4);
      expect(byModel['gpt-4']).toBeCloseTo(0.01, 4);
    });
  });

  describe('getCostByTrace', () => {
    it('returns cost for a specific trace', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 2000, outputTokens: 0 });
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.003, 4);
      expect(tracker.getCostByTrace('t2')).toBeCloseTo(0.006, 4);
    });

    it('returns 0 for unknown trace', () => {
      const tracker = createCostTracker({ pricing });
      expect(tracker.getCostByTrace('nope')).toBe(0);
    });
  });

  describe('budget alerts', () => {
    it('returns null when no budget set', () => {
      const tracker = createCostTracker({ pricing });
      expect(tracker.checkBudget()).toBeNull();
    });

    it('returns null when under warning threshold', () => {
      const tracker = createCostTracker({ pricing, budget: 1.0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.checkBudget()).toBeNull();
    });

    it('returns warning when over 80% (default)', () => {
      const tracker = createCostTracker({ pricing, budget: 0.01 });
      // 0.003 + 0.0075 = 0.0105 > 80% of 0.01
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert).not.toBeNull();
      // cost is 0.0105 which is > budget, so critical
      expect(alert!.type).toBe('critical');
    });

    it('returns critical when over 95%', () => {
      const tracker = createCostTracker({ pricing, budget: 0.004 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert!.type).toBe('critical');
    });

    it('uses custom thresholds', () => {
      const tracker = createCostTracker({
        pricing,
        budget: 0.01,
        alertThresholds: { warning: 0.5, critical: 0.9 },
      });
      // 0.003 / 0.01 = 30% -> no alert
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.checkBudget()).toBeNull();
    });

    it('calls onAlert handler', () => {
      const handler = vi.fn();
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      tracker.onAlert(handler);
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].type).toBe('critical');
    });
  });

  describe('setBudget', () => {
    it('sets budget after creation', () => {
      const tracker = createCostTracker({ pricing });
      tracker.setBudget(0.001);
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const alert = tracker.checkBudget();
      expect(alert).not.toBeNull();
    });
  });

  describe('setPricing', () => {
    it('adds pricing after creation', () => {
      const tracker = createCostTracker();
      tracker.setPricing(pricing);
      const record = tracker.recordUsage({
        traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0,
      });
      expect(record.estimatedCost).toBeCloseTo(0.003, 4);
    });
  });

  describe('reset', () => {
    it('clears all records', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.reset();
      expect(tracker.getTotalCost()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('getAlertMessage returns null when under budget', () => {
      const tracker = createCostTracker({ pricing, budget: 100.0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 100, outputTokens: 50 });
      expect(tracker.getAlertMessage()).toBeNull();
    });

    it('getAlertMessage returns warning at 80% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.00375 });
      // 0.003 cost = 80% of 0.00375
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET WARNING');
    });

    it('getAlertMessage returns critical at 95% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      // 0.003 cost = 100% of 0.003 => critical
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET CRITICAL');
    });

    it('cost with zero pricing returns 0', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'free-model', inputPer1kTokens: 0, outputPer1kTokens: 0 }],
      });
      const record = tracker.recordUsage({
        traceId: 't1',
        model: 'free-model',
        inputTokens: 10000,
        outputTokens: 5000,
      });
      expect(record.estimatedCost).toBe(0);
      expect(tracker.getTotalCost()).toBe(0);
    });

    it('multiple models with different pricing', () => {
      const tracker = createCostTracker({
        pricing: [
          { model: 'cheap', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
          { model: 'expensive', inputPer1kTokens: 0.01, outputPer1kTokens: 0.03 },
        ],
      });
      tracker.recordUsage({ traceId: 't1', model: 'cheap', inputTokens: 1000, outputTokens: 1000 });
      tracker.recordUsage({ traceId: 't2', model: 'expensive', inputTokens: 1000, outputTokens: 1000 });

      const byModel = tracker.getCostByModel();
      // cheap: 1*0.001 + 1*0.002 = 0.003
      expect(byModel['cheap']).toBeCloseTo(0.003, 4);
      // expensive: 1*0.01 + 1*0.03 = 0.04
      expect(byModel['expensive']).toBeCloseTo(0.04, 4);
      // total: 0.003 + 0.04 = 0.043
      expect(tracker.getTotalCost()).toBeCloseTo(0.043, 4);
    });
  });

  // Architecture: Cost-aware prompt injection via getAlertMessage
  describe('getAlertMessage', () => {
    it('returns null when budget not set', () => {
      const tracker = createCostTracker({ pricing });
      expect(tracker.getAlertMessage()).toBeNull();
    });

    it('returns null when under 80% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 1.0 });
      // 0.003 cost, which is 0.3% of 1.0
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.getAlertMessage()).toBeNull();
    });

    it('returns warning message when between 80% and 95% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.00375 });
      // 0.003 cost = 80% of 0.00375
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET WARNING');
      expect(msg).toContain('concise');
    });

    it('returns critical message when at or above 95% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      // 0.003 cost = 100% of 0.003
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET CRITICAL');
      expect(msg).toContain('extremely concise');
    });

    it('returns a string suitable for prompt injection', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(typeof msg).toBe('string');
      // Should be a self-contained instruction string
      expect(msg!.length).toBeGreaterThan(10);
    });
  });

  describe('running total optimization', () => {
    it('getTotalCost uses running total instead of reduce', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 2000, outputTokens: 0 });
      // 0.003 + 0.006 = 0.009
      expect(tracker.getTotalCost()).toBeCloseTo(0.009, 4);
    });

    it('reset clears running total', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.reset();
      expect(tracker.getTotalCost()).toBe(0);

      // New record after reset starts from 0
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.getTotalCost()).toBeCloseTo(0.003, 4);
    });
  });

  describe('destructured functions', () => {
    it('recordUsage and checkBudget work when destructured', () => {
      const { recordUsage, checkBudget, getTotalCost } = createCostTracker({
        pricing,
        budget: 0.001,
      });
      recordUsage({
        traceId: 't1',
        model: 'claude-3',
        inputTokens: 1000,
        outputTokens: 0,
      });
      expect(getTotalCost()).toBeCloseTo(0.003, 4);
      const alert = checkBudget();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('critical');
    });

    it('getAlertMessage works when destructured', () => {
      const { recordUsage, getAlertMessage } = createCostTracker({
        pricing,
        budget: 0.003,
      });
      recordUsage({
        traceId: 't1',
        model: 'claude-3',
        inputTokens: 1000,
        outputTokens: 0,
      });
      const msg = getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET CRITICAL');
    });

    it('onAlert fires correctly when recordUsage is destructured', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      const handler = vi.fn();
      tracker.onAlert(handler);

      const { recordUsage } = tracker;
      recordUsage({
        traceId: 't1',
        model: 'claude-3',
        inputTokens: 1000,
        outputTokens: 0,
      });
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].type).toBe('critical');
    });
  });

  describe('floating point precision recalibration', () => {
    it('maintains precision after many operations', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });

      // Record 1500 entries (crosses the 1000 recalibration threshold)
      for (let i = 0; i < 1500; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // Each record costs 1/1000 * 0.001 = 0.000001
      // Expected total: 1500 * 0.000001 = 0.0015
      const total = tracker.getTotalCost();
      const expected = 1500 * 0.000001;
      // After recalibration, should be very close
      expect(Math.abs(total - expected)).toBeLessThan(1e-10);
    });

    it('recalibration counter resets on tracker reset', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
      });

      for (let i = 0; i < 500; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }
      tracker.reset();
      expect(tracker.getTotalCost()).toBe(0);

      // After reset, recording should work normally
      tracker.recordUsage({ traceId: 'after', model: 'a', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.getTotalCost()).toBeCloseTo(1.0, 4);
    });
  });

  describe('records cap', () => {
    it('evicts oldest records when exceeding maxRecords (10,000) and adjusts running total', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
      });

      // Add 10,001 records: each costs 0.001 (1 token input at $1/1k)
      for (let i = 0; i < 10_001; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // The first record should have been evicted, so total should be 10,000 * 0.001 not 10,001 * 0.001
      // Each record: 1/1000 * 1.0 = 0.001
      expect(tracker.getTotalCost()).toBeCloseTo(10_000 * 0.001, 2);
    });
  });
});
