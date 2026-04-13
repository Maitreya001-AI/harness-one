import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCostTracker, KahanSum, OVERFLOW_BUCKET_KEY } from '../cost-tracker.js';
import type { CostAlert } from '../types.js';

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

    it('returns exceeded when over 100% (default)', () => {
      const tracker = createCostTracker({ pricing, budget: 0.01 });
      // 0.003 + 0.0075 = 0.0105 > 100% of 0.01
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert).not.toBeNull();
      // cost is 0.0105 which is > budget, so exceeded
      expect(alert!.type).toBe('exceeded');
    });

    it('returns exceeded when well over budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.004 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert!.type).toBe('exceeded');
    });

    it('returns critical when between 95% and 100%', () => {
      // budget = 0.0109 => 95% = 0.010355, 100% = 0.0109
      // cost = 0.0105 => 96.3% (between critical and exceeded)
      const tracker = createCostTracker({ pricing, budget: 0.0109 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert).not.toBeNull();
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
      // cost 0.003 > budget 0.001 => exceeded
      expect(handler.mock.calls[0][0].type).toBe('exceeded');
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

    it('getAlertMessage returns exceeded at 100% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      // 0.003 cost = 100% of 0.003 => exceeded
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET EXCEEDED');
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

    it('returns exceeded message when at or above 100% of budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      // 0.003 cost = 100% of 0.003
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET EXCEEDED');
      expect(msg).toContain('Stop all non-essential operations');
    });

    it('returns critical message when between 95% and 100% of budget', () => {
      // budget = 0.00316 => 95% = 0.003002, 100% = 0.00316
      // cost = 0.003 => ~94.9% -- hmm, that's under 95%. Let me use a tighter budget.
      // budget = 0.00312 => cost/budget = 0.003/0.00312 = 96.15%
      const tracker = createCostTracker({ pricing, budget: 0.00312 });
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
      // cost 0.003 > budget 0.001 => exceeded
      expect(alert!.type).toBe('exceeded');
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
      // cost = 0.003 = 100% of budget => exceeded
      expect(msg).toContain('BUDGET EXCEEDED');
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
      // cost 0.003 > budget 0.001 => exceeded
      expect(handler.mock.calls[0][0].type).toBe('exceeded');
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

  // Fix 3: onAlert returns a cleanup function for deregistration
  describe('alert handler deregistration', () => {
    it('onAlert returns an unsubscribe function', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      const handler = vi.fn();
      const unsub = tracker.onAlert(handler);
      expect(typeof unsub).toBe('function');

      // First usage triggers alert
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsub();

      // Second usage should NOT trigger handler
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(handler).toHaveBeenCalledTimes(1); // Still just 1 call
    });

    it('multiple handlers can be independently unsubscribed', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = tracker.onAlert(handler1);
      tracker.onAlert(handler2);

      // Unsubscribe only handler1
      unsub1();

      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });

      // handler1 should NOT be called, handler2 should be called
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('double-unsubscribe is safe (no-op)', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      const handler = vi.fn();
      const unsub = tracker.onAlert(handler);

      unsub();
      // Calling unsub again should not throw or corrupt state
      expect(() => unsub()).not.toThrow();

      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // Fix 4: getCostByModel uses permanent modelTotals (not affected by buffer eviction)
  describe('getCostByModel with permanent modelTotals', () => {
    it('getCostByModel remains consistent after buffer eviction', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
      });

      // Record 10,001 entries to trigger buffer eviction (maxRecords=10,000)
      for (let i = 0; i < 10_001; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // getCostByModel should reflect ALL recorded usage, not just buffer
      const byModel = tracker.getCostByModel();
      // Each record: 1/1000 * 1.0 = 0.001; total = 10,001 * 0.001 = 10.001
      expect(byModel['a']).toBeCloseTo(10_001 * 0.001, 2);
    });

    it('getCostByModel tracks multiple models independently', () => {
      const tracker = createCostTracker({
        pricing: [
          { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 },
          { model: 'b', inputPer1kTokens: 2.0, outputPer1kTokens: 0 },
        ],
      });

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'b', inputTokens: 1000, outputTokens: 0 });

      const byModel = tracker.getCostByModel();
      expect(byModel['a']).toBeCloseTo(1.0, 4);
      expect(byModel['b']).toBeCloseTo(2.0, 4);
    });

    it('getCostByModel is cleared on reset', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
      });

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.reset();

      const byModel = tracker.getCostByModel();
      expect(Object.keys(byModel)).toHaveLength(0);
    });
  });

  // Fix 5: KahanSum utility class
  describe('KahanSum utility', () => {
    it('accumulates values with high precision', () => {
      const sum = new KahanSum();
      for (let i = 0; i < 10000; i++) {
        sum.add(0.1);
      }
      expect(sum.total).toBeCloseTo(1000, 5);
    });

    it('supports subtraction', () => {
      const sum = new KahanSum();
      sum.add(1.0);
      sum.add(2.0);
      sum.subtract(1.5);
      expect(sum.total).toBeCloseTo(1.5, 10);
    });

    it('reset clears the sum', () => {
      const sum = new KahanSum();
      sum.add(42);
      sum.reset();
      expect(sum.total).toBe(0);
    });
  });

  // Fix 6: setBudget alert timing documentation
  describe('setBudget alert timing', () => {
    it('alerts are not re-evaluated immediately on budget change', () => {
      const handler = vi.fn();
      const tracker = createCostTracker({ pricing, budget: 100.0 });
      tracker.onAlert(handler);

      // Record usage that's over a very small budget
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(handler).not.toHaveBeenCalled(); // 0.003 << 100.0

      // Change budget to something very small — alerts NOT fired immediately
      tracker.setBudget(0.001);
      expect(handler).not.toHaveBeenCalled();

      // Next recordUsage triggers the alert re-evaluation
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 1, outputTokens: 0 });
      expect(handler).toHaveBeenCalled();
    });
  });

  // Fix 4: Recalibration triggered by getTotalCost()
  describe('getTotalCost recalibration', () => {
    it('recalibrates running total when called after recalibration interval', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }],
      });

      // Record exactly 1000 entries (hits recalibration interval in recordUsage)
      for (let i = 0; i < 1000; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // At this point recordsSinceRecalibrate was reset to 0 by recordUsage.
      // Record 999 more (just under recalibration threshold)
      for (let i = 0; i < 999; i++) {
        tracker.recordUsage({ traceId: `t2-${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // getTotalCost should still return an accurate value
      const total = tracker.getTotalCost();
      const expected = 1999 * 0.000001;
      expect(Math.abs(total - expected)).toBeLessThan(1e-10);
    });
  });

  // REQ-011: Cost-aware auto-mitigation
  describe('isBudgetExceeded', () => {
    it('returns false when no budget is set', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.isBudgetExceeded()).toBe(false);
    });

    it('returns false when total cost is under budget', () => {
      const tracker = createCostTracker({ pricing, budget: 1.0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 1.0
      expect(tracker.isBudgetExceeded()).toBe(false);
    });

    it('returns true when total cost equals budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 0.003
      expect(tracker.isBudgetExceeded()).toBe(true);
    });

    it('returns true when total cost exceeds budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 0.001
      expect(tracker.isBudgetExceeded()).toBe(true);
    });

    it('works when destructured', () => {
      const { recordUsage, isBudgetExceeded } = createCostTracker({ pricing, budget: 0.001 });
      recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(isBudgetExceeded()).toBe(true);
    });
  });

  describe('budgetUtilization', () => {
    it('returns 0 when no spend has occurred', () => {
      const tracker = createCostTracker({ pricing, budget: 1.0 });
      expect(tracker.budgetUtilization()).toBe(0);
    });

    it('returns 0 when no budget is set', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.budgetUtilization()).toBe(0);
    });

    it('returns 0.5 at half budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.006 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 0.006 => 0.5
      expect(tracker.budgetUtilization()).toBeCloseTo(0.5, 4);
    });

    it('returns 1.0 at full budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 0.003 => 1.0
      expect(tracker.budgetUtilization()).toBeCloseTo(1.0, 4);
    });

    it('can exceed 1.0 when over budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 0.001 => 3.0
      expect(tracker.budgetUtilization()).toBeCloseTo(3.0, 4);
    });

    it('resets to 0 after tracker reset', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.budgetUtilization()).toBeCloseTo(1.0, 4);
      tracker.reset();
      expect(tracker.budgetUtilization()).toBe(0);
    });

    it('works when destructured', () => {
      const { recordUsage, budgetUtilization } = createCostTracker({ pricing, budget: 0.006 });
      recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(budgetUtilization()).toBeCloseTo(0.5, 4);
    });
  });

  describe('shouldStop', () => {
    it('returns false when no budget is set', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.shouldStop()).toBe(false);
    });

    it('returns false when under budget', () => {
      const tracker = createCostTracker({ pricing, budget: 1.0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.shouldStop()).toBe(false);
    });

    it('returns true when budget is exceeded', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.shouldStop()).toBe(true);
    });

    it('returns true when cost exactly equals budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.003 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(tracker.shouldStop()).toBe(true);
    });

    it('works when destructured', () => {
      const { recordUsage, shouldStop } = createCostTracker({ pricing, budget: 0.001 });
      recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      expect(shouldStop()).toBe(true);
    });
  });

  describe('onBudgetExceeded callback', () => {
    it('fires when cost crosses 100% of budget via recordUsage', () => {
      const handler = vi.fn();
      const tracker = createCostTracker({ pricing, budget: 0.005 });
      tracker.onAlert(handler);

      // First usage: 0.003 = 60% of 0.005 — no alert
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // Check that no 'exceeded' alert was emitted
      const exceededCalls1 = handler.mock.calls.filter((c: [CostAlert]) => c[0].type === 'exceeded');
      expect(exceededCalls1).toHaveLength(0);

      // Second usage: 0.003 + 0.0105 = 0.0135 > 0.005 — exceeded
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 1000, outputTokens: 500 });
      const exceededCalls2 = handler.mock.calls.filter((c: [CostAlert]) => c[0].type === 'exceeded');
      expect(exceededCalls2).toHaveLength(1);
      expect(exceededCalls2[0][0].percentUsed).toBeGreaterThanOrEqual(1.0);
    });

    it('fires when cost crosses 100% of budget via updateUsage', () => {
      const handler = vi.fn();
      const tracker = createCostTracker({ pricing, budget: 0.005 });
      tracker.onAlert(handler);

      // Initial: 0.003 = 60% — no exceeded alert
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });

      // Update pushes over budget: 0.0105 > 0.005
      tracker.updateUsage('t1', { inputTokens: 1000, outputTokens: 500 });
      const exceededCalls = handler.mock.calls.filter((c: [CostAlert]) => c[0].type === 'exceeded');
      expect(exceededCalls).toHaveLength(1);
    });

    it('exceeded alert contains correct fields', () => {
      const handler = vi.fn();
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      tracker.onAlert(handler);

      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003, budget = 0.001 => 300% used
      const exceededCalls = handler.mock.calls.filter((c: [CostAlert]) => c[0].type === 'exceeded');
      expect(exceededCalls).toHaveLength(1);

      const alert = exceededCalls[0][0];
      expect(alert.type).toBe('exceeded');
      expect(alert.currentCost).toBeCloseTo(0.003, 4);
      expect(alert.budget).toBe(0.001);
      expect(alert.percentUsed).toBeCloseTo(3.0, 1);
      expect(alert.message).toContain('Exceeded');
    });

    it('getAlertMessage returns exceeded message at 100%+ budget', () => {
      const tracker = createCostTracker({ pricing, budget: 0.001 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const msg = tracker.getAlertMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('BUDGET EXCEEDED');
    });
  });

  // Issue 6: Streaming token support via updateUsage()
  describe('updateUsage (Issue 6 fix)', () => {
    it('updates the most recent record for a traceId and returns the updated record', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 500, outputTokens: 0 });
      const updated = tracker.updateUsage('t1', { inputTokens: 1000, outputTokens: 500 });
      expect(updated).toBeDefined();
      expect(updated!.inputTokens).toBe(1000);
      expect(updated!.outputTokens).toBe(500);
      expect(updated!.traceId).toBe('t1');
    });

    it('returns undefined for unknown traceId', () => {
      const tracker = createCostTracker({ pricing });
      const result = tracker.updateUsage('nonexistent', { inputTokens: 1000 });
      expect(result).toBeUndefined();
    });

    it('recalculates estimatedCost after update', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // initial cost: 1000/1000 * 0.003 = 0.003
      expect(tracker.getTotalCost()).toBeCloseTo(0.003, 4);

      const updated = tracker.updateUsage('t1', { inputTokens: 1000, outputTokens: 500 });
      // updated cost: 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
      expect(updated!.estimatedCost).toBeCloseTo(0.0105, 4);
    });

    it('adjusts running total by cost delta after update', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // Initial total: 0.003
      expect(tracker.getTotalCost()).toBeCloseTo(0.003, 4);

      tracker.updateUsage('t1', { inputTokens: 1000, outputTokens: 500 });
      // New total: 0.0105 (not 0.003 + 0.0105)
      expect(tracker.getTotalCost()).toBeCloseTo(0.0105, 4);
    });

    it('adjusts per-model total by cost delta after update', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.updateUsage('t1', { outputTokens: 500 });

      const byModel = tracker.getCostByModel();
      // 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.0105
      expect(byModel['claude-3']).toBeCloseTo(0.0105, 4);
    });

    it('updates most recent record when multiple records for same traceId exist', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 100, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 200, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 300, outputTokens: 0 });

      const updated = tracker.updateUsage('t1', { inputTokens: 999 });
      expect(updated!.inputTokens).toBe(999);
    });

    it('preserves unchanged token fields when only updating some fields', () => {
      const tracker = createCostTracker({
        pricing: [{
          model: 'claude-3',
          inputPer1kTokens: 0.003,
          outputPer1kTokens: 0.015,
          cacheReadPer1kTokens: 0.001,
          cacheWritePer1kTokens: 0.002,
        }],
      });
      tracker.recordUsage({
        traceId: 't1',
        model: 'claude-3',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
      });

      // Update only outputTokens — other fields preserved
      const updated = tracker.updateUsage('t1', { outputTokens: 1000 });
      expect(updated!.inputTokens).toBe(1000);
      expect(updated!.outputTokens).toBe(1000);
      expect(updated!.cacheReadTokens).toBe(200);
      expect(updated!.cacheWriteTokens).toBe(100);
    });

    it('fires budget alert after update increases cost over threshold', () => {
      const handler = vi.fn();
      const tracker = createCostTracker({ pricing, budget: 0.005 });
      tracker.onAlert(handler);
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 500, outputTokens: 0 });
      // 0.0015 — under 80% of 0.005
      expect(handler).not.toHaveBeenCalled();

      // Update to push over budget
      tracker.updateUsage('t1', { inputTokens: 1000, outputTokens: 500 });
      // 0.0105 > 0.005 — exceeded
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].type).toBe('exceeded');
    });

    it('handles streaming: successive updateUsage calls simulate token accumulation', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 'stream-1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });

      // Simulate streaming: output tokens arrive incrementally
      tracker.updateUsage('stream-1', { outputTokens: 100 });
      tracker.updateUsage('stream-1', { outputTokens: 200 });
      tracker.updateUsage('stream-1', { outputTokens: 500 });

      // Final total should reflect only the last update (500 output tokens), not cumulative
      // 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
      expect(tracker.getTotalCost()).toBeCloseTo(0.0105, 4);
    });

    it('does not double-count when updateUsage is called multiple times', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });

      tracker.updateUsage('t1', { outputTokens: 500 });
      tracker.updateUsage('t1', { outputTokens: 500 }); // same value again

      // Should still be: 1000/1000*0.003 + 500/1000*0.015 = 0.0105 (not doubled)
      expect(tracker.getTotalCost()).toBeCloseTo(0.0105, 4);
    });

    it('preserves original timestamp on update', () => {
      const tracker = createCostTracker({ pricing });
      const original = tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      const updated = tracker.updateUsage('t1', { outputTokens: 100 });
      expect(updated!.timestamp).toBe(original.timestamp);
    });
  });

  // PERF-03: getCostByTrace uses O(1) traceTotals index
  describe('getCostByTrace with traceTotals index', () => {
    it('returns correct cost from traceTotals index after multiple records', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 2000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // t1: 0.003 + 0.006 = 0.009
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.009, 4);
      // t2: 0.003
      expect(tracker.getCostByTrace('t2')).toBeCloseTo(0.003, 4);
    });

    it('traceTotals persists even after records buffer eviction', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
        maxRecords: 5,
      });

      // Record 6 entries for the same trace -- the first record gets evicted from buffer
      for (let i = 0; i < 6; i++) {
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      }

      // traceTotals should reflect ALL 6 records even though buffer only has 5
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(6.0, 2);
    });

    it('traceTotals adjusts correctly via updateUsage', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      // cost = 0.003
      tracker.updateUsage('t1', { inputTokens: 2000 });
      // cost should now be 0.006
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.006, 4);
    });

    it('traceTotals cleared on reset', () => {
      const tracker = createCostTracker({ pricing });
      tracker.recordUsage({ traceId: 't1', model: 'claude-3', inputTokens: 1000, outputTokens: 0 });
      tracker.reset();
      expect(tracker.getCostByTrace('t1')).toBe(0);
    });
  });

  // SEC-009: modelTotals and traceTotals never evict — overflow bucket keeps
  // late-arriving unknown keys without letting junk keys wipe legitimate totals.
  describe('bounded maps (overflow bucket, SEC-009)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    afterEach(() => {
      warnSpy.mockClear();
    });

    it('aggregates new models under OVERFLOW_BUCKET_KEY without evicting existing entries', () => {
      const models = Array.from({ length: 5 }, (_, i) => ({
        model: `m${i}`, inputPer1kTokens: 1.0, outputPer1kTokens: 0,
      }));
      const tracker = createCostTracker({
        pricing: models,
        maxModels: 3,
        warnUnpricedModels: false,
      });

      // Record usage for 5 different models -- maxModels is 3
      for (let i = 0; i < 5; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: `m${i}`, inputTokens: 1000, outputTokens: 0 });
      }

      const byModel = tracker.getCostByModel();
      // The first three models must still be present — SEC-009 forbids eviction
      // by caller keys.
      expect(byModel['m0']).toBeCloseTo(1.0, 6);
      expect(byModel['m1']).toBeCloseTo(1.0, 6);
      expect(byModel['m2']).toBeCloseTo(1.0, 6);
      // Later models aggregate into the overflow bucket.
      expect(byModel[OVERFLOW_BUCKET_KEY]).toBeCloseTo(2.0, 6);
      // Overflowed keys are NOT queryable individually.
      expect(byModel['m3']).toBeUndefined();
      expect(byModel['m4']).toBeUndefined();
    });

    it('aggregates new traces under OVERFLOW_BUCKET_KEY without evicting existing entries', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
        maxTraces: 3,
      });

      for (let i = 0; i < 5; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1000, outputTokens: 0 });
      }

      // Early traces must remain — they are NOT evictable.
      expect(tracker.getCostByTrace('t0')).toBeCloseTo(1.0, 6);
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(1.0, 6);
      expect(tracker.getCostByTrace('t2')).toBeCloseTo(1.0, 6);
      // t3, t4 are bucketed under __overflow__ and not individually retrievable.
      expect(tracker.getCostByTrace('t3')).toBe(0);
      expect(tracker.getCostByTrace('t4')).toBe(0);
      expect(tracker.getCostByTrace(OVERFLOW_BUCKET_KEY)).toBeCloseTo(2.0, 6);
    });

    it('invokes onOverflow callback when overflow activates', () => {
      const onOverflow = vi.fn();
      const tracker = createCostTracker({
        pricing: [{ model: 'base', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
        maxModels: 1,
        maxTraces: 1,
        warnUnpricedModels: false,
        onOverflow,
      });

      tracker.recordUsage({ traceId: 't-a', model: 'base', inputTokens: 1000, outputTokens: 0 });
      // Second model triggers model overflow, but traceId reuses 't-a' so no trace overflow yet.
      tracker.recordUsage({ traceId: 't-a', model: 'second', inputTokens: 1000, outputTokens: 0 });
      // Second trace triggers trace overflow.
      tracker.recordUsage({ traceId: 't-b', model: 'base', inputTokens: 1000, outputTokens: 0 });

      expect(onOverflow).toHaveBeenCalled();
      const kinds = onOverflow.mock.calls.map((c) => c[0].kind);
      expect(kinds).toContain('model');
      expect(kinds).toContain('trace');
    });

    it('throttles overflow warnings to at most once per minute per kind', () => {
      const onOverflow = vi.fn();
      const tracker = createCostTracker({
        pricing: [{ model: 'base', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
        maxModels: 1,
        warnUnpricedModels: false,
        onOverflow,
      });
      tracker.recordUsage({ traceId: 't', model: 'base', inputTokens: 1000, outputTokens: 0 });

      // Hammer the overflow path many times with distinct new model keys.
      for (let i = 0; i < 100; i++) {
        tracker.recordUsage({ traceId: 't', model: `flood-${i}`, inputTokens: 1000, outputTokens: 0 });
      }

      const modelOverflows = onOverflow.mock.calls.filter((c) => c[0].kind === 'model');
      expect(modelOverflows.length).toBe(1); // throttled to once
    });

    it('falls back to console.warn when onOverflow is not provided', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'base', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
        maxModels: 1,
        warnUnpricedModels: false,
      });
      tracker.recordUsage({ traceId: 't', model: 'base', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't', model: 'second', inputTokens: 1000, outputTokens: 0 });

      expect(warnSpy).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('__overflow__')),
      ).toBe(true);
    });
  });

  // CQ-009: getCostByModel/getCostByTrace cumulative, getTotalCost recent-window
  describe('getter semantics (CQ-009)', () => {
    it('getCostByModel stays cumulative even after records buffer eviction', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'c3', inputPer1kTokens: 1.0, outputPer1kTokens: 0 }],
        maxRecords: 2,
        warnUnpricedModels: false,
      });
      tracker.recordUsage({ traceId: 't1', model: 'c3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'c3', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'c3', inputTokens: 1000, outputTokens: 0 });

      // 3 records * 1.0 = 3.0 cumulative, even though buffer evicted the oldest.
      expect(tracker.getCostByModel()['c3']).toBeCloseTo(3.0, 6);
      // Recent window dropped the oldest record.
      expect(tracker.getTotalCost()).toBeCloseTo(2.0, 6);
    });
  });
});
