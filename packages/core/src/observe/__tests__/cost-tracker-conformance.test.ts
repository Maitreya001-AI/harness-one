/**
 * ARCH-008: shared conformance suite run against both eviction strategies.
 *
 * Both strategies MUST honour the public `CostTracker` contract:
 *   - `recordUsage` returns the stored record with `estimatedCost` populated.
 *   - `getTotalCost()` equals the sum of retained records' `estimatedCost`.
 *   - `getCostByModel()` / `getCostByTrace()` expose per-key totals.
 *   - Budget alerts fire via `onAlert` / `checkBudget`.
 *
 * Divergence is documented in this suite:
 *   - `overflow-bucket` keeps per-key totals cumulative-since-start.
 *   - `lru` decrements per-key totals on record eviction.
 */

import { describe, it, expect } from 'vitest';
import { createCostTracker, type ModelPricing } from '../cost-tracker.js';
import type { EvictionStrategyName } from '../cost-tracker-eviction.js';

const PRICING: ModelPricing[] = [
  { model: 'claude', inputPer1kTokens: 1, outputPer1kTokens: 2 },
];

for (const strategy of ['overflow-bucket', 'lru'] satisfies EvictionStrategyName[]) {
  describe(`CostTracker conformance — strategy=${strategy}`, () => {
    it('records usage and computes cost', () => {
      const t = createCostTracker({ pricing: PRICING, evictionStrategy: strategy });
      const rec = t.recordUsage({ traceId: 'tr', model: 'claude', inputTokens: 1000, outputTokens: 1000 });
      expect(rec.estimatedCost).toBeGreaterThan(0);
      expect(t.getTotalCost()).toBeCloseTo(rec.estimatedCost);
    });

    it('per-model and per-trace totals accumulate across calls', () => {
      const t = createCostTracker({ pricing: PRICING, evictionStrategy: strategy });
      t.recordUsage({ traceId: 'a', model: 'claude', inputTokens: 1000, outputTokens: 0 });
      t.recordUsage({ traceId: 'a', model: 'claude', inputTokens: 1000, outputTokens: 0 });
      t.recordUsage({ traceId: 'b', model: 'claude', inputTokens: 1000, outputTokens: 0 });
      const byModel = t.getCostByModel();
      const sum = Array.from(byModel.values()).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(t.getTotalCost());
      expect(t.getCostByTrace('a')).toBeCloseTo(2);
      expect(t.getCostByTrace('b')).toBeCloseTo(1);
    });

    it('budget alerts fire when exceeded', () => {
      const t = createCostTracker({ pricing: PRICING, budget: 0.5, evictionStrategy: strategy });
      let fired = false;
      t.onAlert((a) => { if (a.type === 'exceeded') fired = true; });
      t.recordUsage({ traceId: 'tr', model: 'claude', inputTokens: 1000, outputTokens: 0 });
      expect(fired).toBe(true);
      expect(t.isBudgetExceeded()).toBe(true);
      expect(t.shouldStop()).toBe(true);
    });

    it('reset clears all state', () => {
      const t = createCostTracker({ pricing: PRICING, evictionStrategy: strategy });
      t.recordUsage({ traceId: 'tr', model: 'claude', inputTokens: 1000, outputTokens: 0 });
      expect(t.getTotalCost()).toBeGreaterThan(0);
      t.reset();
      expect(t.getTotalCost()).toBe(0);
      expect(t.getCostByModel().size).toBe(0);
      expect(t.getCostByTrace('tr')).toBe(0);
    });
  });
}

describe('CostTracker strategy divergence (ARCH-008)', () => {
  it('overflow-bucket keeps per-model totals cumulative after record eviction', () => {
    const t = createCostTracker({
      pricing: PRICING,
      maxRecords: 1,
      evictionStrategy: 'overflow-bucket',
    });
    t.recordUsage({ traceId: 'x', model: 'claude', inputTokens: 1000, outputTokens: 0 });
    t.recordUsage({ traceId: 'y', model: 'claude', inputTokens: 1000, outputTokens: 0 });
    // First record has been evicted from the record buffer; getTotalCost()
    // tracks only the retained window, but getCostByModel() is cumulative.
    expect(t.getTotalCost()).toBeCloseTo(1);
    expect(t.getCostByModel().get('claude')).toBeCloseTo(2);
  });

  it('lru decrements per-model totals on record eviction', () => {
    const t = createCostTracker({
      pricing: PRICING,
      maxRecords: 1,
      evictionStrategy: 'lru',
    });
    t.recordUsage({ traceId: 'x', model: 'claude', inputTokens: 1000, outputTokens: 0 });
    t.recordUsage({ traceId: 'y', model: 'claude', inputTokens: 1000, outputTokens: 0 });
    expect(t.getTotalCost()).toBeCloseTo(1);
    expect(t.getCostByModel().get('claude')).toBeCloseTo(1);
    expect(t.getCostByTrace('x')).toBe(0); // evicted
    expect(t.getCostByTrace('y')).toBeCloseTo(1);
  });

  it('overflow-bucket routes unknown keys past maxModels into OVERFLOW_BUCKET_KEY', () => {
    const t = createCostTracker({
      pricing: [
        { model: 'a', inputPer1kTokens: 1, outputPer1kTokens: 0 },
        { model: 'b', inputPer1kTokens: 1, outputPer1kTokens: 0 },
      ],
      maxModels: 1,
      evictionStrategy: 'overflow-bucket',
    });
    t.recordUsage({ traceId: 'x', model: 'a', inputTokens: 1000, outputTokens: 0 });
    t.recordUsage({ traceId: 'y', model: 'b', inputTokens: 1000, outputTokens: 0 });
    const byModel = t.getCostByModel();
    expect(byModel.get('a')).toBeCloseTo(1);
    expect(byModel.get('__overflow__')).toBeCloseTo(1);
    expect(byModel.has('b')).toBe(false);
  });
});
