import { describe, it, expect } from 'vitest';
import { createCostTracker } from '../cost-tracker.js';
import { createLogger } from '../logger.js';
import type { CostAlert } from '../types.js';
import type { MetricsPort } from '../../core/metrics-port.js';

function makeRecordingMetricsPort(): {
  port: MetricsPort;
  counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }>;
  gauges: Array<{ name: string; value: number }>;
} {
  const counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }> = [];
  const gauges: Array<{ name: string; value: number }> = [];
  const port: MetricsPort = {
    counter(name) {
      return { add: (value, attrs) => counters.push({ name, value, attrs: attrs as Record<string, unknown> | undefined }) };
    },
    gauge(name) {
      return { record: (value) => gauges.push({ name, value }) };
    },
    histogram() {
      return { record: () => {} };
    },
  };
  return { port, counters, gauges };
}

describe('Wave-13 cost-tracker fixes', () => {
  describe('Wave-13 P0-6: O(1) amortised eviction bookkeeping', () => {
    it('keeps updateUsage() correct across many evictions', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 }],
        maxRecords: 5,
      });
      // Push 20 records for the SAME trace so every eviction hits that trace.
      for (let i = 0; i < 20; i++) {
        tracker.recordUsage({ traceId: 't1', model: 'm', inputTokens: 100, outputTokens: 100 });
      }
      // updateUsage() must target the freshest record (the latest push) even
      // though 15 earlier records were evicted.
      const updated = tracker.updateUsage('t1', { inputTokens: 500 });
      expect(updated).toBeDefined();
      expect(updated!.inputTokens).toBe(500);
    });

    it('updateUsage() returns undefined once all records for a trace are evicted', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 }],
        maxRecords: 2,
      });
      tracker.recordUsage({ traceId: 'old', model: 'm', inputTokens: 1, outputTokens: 1 });
      // Push 5 new-trace records so the single 'old' record is evicted.
      for (let i = 0; i < 5; i++) {
        tracker.recordUsage({ traceId: 'new', model: 'm', inputTokens: 1, outputTokens: 1 });
      }
      expect(tracker.updateUsage('old', { inputTokens: 2 })).toBeUndefined();
    });

    it('handles interleaved traces without backward scan blowup', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 }],
        maxRecords: 10,
      });
      // Interleave two traces; both should be updatable after churn.
      for (let i = 0; i < 50; i++) {
        const traceId = i % 2 === 0 ? 'even' : 'odd';
        tracker.recordUsage({ traceId, model: 'm', inputTokens: 10, outputTokens: 10 });
      }
      expect(tracker.updateUsage('even', { inputTokens: 999 })!.inputTokens).toBe(999);
      expect(tracker.updateUsage('odd', { inputTokens: 888 })!.inputTokens).toBe(888);
    });

    it('reset() clears eviction bias so fresh trace indexes from zero', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 }],
        maxRecords: 3,
      });
      for (let i = 0; i < 10; i++) {
        tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1, outputTokens: 1 });
      }
      tracker.reset();
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 5, outputTokens: 5 });
      expect(tracker.updateUsage('t', { inputTokens: 42 })!.inputTokens).toBe(42);
    });
  });

  describe('Wave-13 C-1: concurrency-safe updatePricing / updateBudget', () => {
    it('updatePricing() serialises concurrent writes via the internal lock', async () => {
      const tracker = createCostTracker({});
      await Promise.all([
        tracker.updatePricing([{ model: 'a', inputPer1kTokens: 1, outputPer1kTokens: 1 }]),
        tracker.updatePricing([{ model: 'b', inputPer1kTokens: 2, outputPer1kTokens: 2 }]),
      ]);
      const rec = tracker.recordUsage({ traceId: 't', model: 'a', inputTokens: 1000, outputTokens: 1000 });
      // Model 'a' at $1/1k in + $1/1k out = $2 for 1k+1k.
      expect(rec.estimatedCost).toBeCloseTo(2, 4);
    });

    it('updateBudget() serialises + applies new budget', async () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 1, outputPer1kTokens: 1 }],
        budget: 100,
      });
      await tracker.updateBudget(0.5);
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1000, outputTokens: 1000 });
      expect(tracker.isBudgetExceeded()).toBe(true);
    });
  });

  describe('Wave-13 C-2: updateUsage avoids conditional-spread allocation', () => {
    it('preserves cache token fields via explicit assignment', () => {
      const tracker = createCostTracker({
        pricing: [{
          model: 'm',
          inputPer1kTokens: 1,
          outputPer1kTokens: 1,
          cacheReadPer1kTokens: 1,
          cacheWritePer1kTokens: 1,
        }],
      });
      tracker.recordUsage({
        traceId: 't',
        model: 'm',
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
      });
      const updated = tracker.updateUsage('t', { outputTokens: 200 });
      expect(updated).toBeDefined();
      // cacheReadTokens/cacheWriteTokens must be preserved from the existing record.
      expect(updated!.cacheReadTokens).toBe(50);
      expect(updated!.cacheWriteTokens).toBe(25);
    });

    it('overrides cache token fields when provided in the patch', () => {
      const tracker = createCostTracker({
        pricing: [{
          model: 'm',
          inputPer1kTokens: 1,
          outputPer1kTokens: 1,
          cacheReadPer1kTokens: 1,
        }],
      });
      tracker.recordUsage({
        traceId: 't',
        model: 'm',
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 5,
      });
      const updated = tracker.updateUsage('t', { cacheReadTokens: 77 });
      expect(updated!.cacheReadTokens).toBe(77);
    });

    it('omits cache fields when neither patch nor existing record has them', () => {
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 1, outputPer1kTokens: 1 }],
      });
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1, outputTokens: 1 });
      const updated = tracker.updateUsage('t', { outputTokens: 2 });
      expect(updated!.cacheReadTokens).toBeUndefined();
      expect(updated!.cacheWriteTokens).toBeUndefined();
    });
  });

  describe('Wave-13 C-3: alerts emit log + metrics', () => {
    it('emits logger.warn on every budget alert', () => {
      const lines: string[] = [];
      const logger = createLogger({ output: (line) => lines.push(line), redact: false });
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 1, outputPer1kTokens: 1 }],
        budget: 1,
        logger,
      });
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1000, outputTokens: 1000 });
      const warns = lines.filter((l) => l.includes('WARN') && l.includes('budget alert'));
      expect(warns.length).toBeGreaterThan(0);
    });

    it('records utilisation gauge on every recordUsage with a budget', () => {
      const { port, gauges } = makeRecordingMetricsPort();
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 1, outputPer1kTokens: 1 }],
        budget: 10,
        metrics: port,
      });
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1000, outputTokens: 1000 });
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1000, outputTokens: 1000 });
      const utilGauges = gauges.filter((g) => g.name === 'harness.cost.utilization');
      expect(utilGauges.length).toBe(2);
      // Second record should be at 0.4 utilisation (total $4 / budget $10).
      expect(utilGauges[1].value).toBeCloseTo(0.4, 4);
    });

    it('increments harness.cost.alerts.total counter when alert fires', () => {
      const { port, counters } = makeRecordingMetricsPort();
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 1, outputPer1kTokens: 1 }],
        budget: 1,
        metrics: port,
        alertDedupeWindowMs: 0,
      });
      // Register handler to prove handler still receives alerts.
      const alerts: CostAlert[] = [];
      tracker.onAlert((a) => alerts.push(a));
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1000, outputTokens: 1000 });
      const alertCounters = counters.filter((c) => c.name === 'harness.cost.alerts.total');
      expect(alertCounters.length).toBeGreaterThan(0);
      expect(alerts.length).toBeGreaterThan(0);
    });

    it('skips utilisation gauge when no budget is configured', () => {
      const { port, gauges } = makeRecordingMetricsPort();
      const tracker = createCostTracker({
        pricing: [{ model: 'm', inputPer1kTokens: 1, outputPer1kTokens: 1 }],
        metrics: port,
      });
      tracker.recordUsage({ traceId: 't', model: 'm', inputTokens: 1000, outputTokens: 1000 });
      expect(gauges.filter((g) => g.name === 'harness.cost.utilization')).toHaveLength(0);
    });
  });
});
