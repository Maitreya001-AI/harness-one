/**
 * Tests for `CostTracker.recordUsage` with optional traceId/model
 * (HARNESS_LOG HC-005). Missing identifiers fall through to the
 * `'unknown'` bucket so simple callers don't pollute aggregations
 * with stub values.
 */
import { describe, it, expect } from 'vitest';
import { createCostTracker } from '../cost-tracker.js';
import type { ModelPricing } from '../cost-tracker-types.js';

const PRICING: ModelPricing[] = [
  { model: 'unknown', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
  { model: 'real-model', inputPer1kTokens: 0.003, outputPer1kTokens: 0.004 },
];

describe('CostTracker.recordUsage — optional traceId/model', () => {
  it('accepts a record with no traceId, buckets under "unknown"', () => {
    const t = createCostTracker({ pricing: PRICING });
    const record = t.recordUsage({
      model: 'real-model',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(record.traceId).toBe('unknown');
    expect(record.model).toBe('real-model');
    expect(record.estimatedCost).toBeGreaterThan(0);
  });

  it('accepts a record with no model, buckets under "unknown"', () => {
    const t = createCostTracker({ pricing: PRICING });
    const record = t.recordUsage({
      traceId: 't1',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(record.model).toBe('unknown');
    expect(record.traceId).toBe('t1');
    // 'unknown' has pricing; cost > 0
    expect(record.estimatedCost).toBeGreaterThan(0);
  });

  it('accepts a record with neither traceId nor model', () => {
    const t = createCostTracker({ pricing: PRICING });
    const record = t.recordUsage({ inputTokens: 100, outputTokens: 50 });
    expect(record.traceId).toBe('unknown');
    expect(record.model).toBe('unknown');
  });

  it('does NOT emit unpriced-model warning when caller omits model', () => {
    const warns: string[] = [];
    const logger = {
      info: () => {}, warn: (m: string) => { warns.push(m); }, error: () => {}, debug: () => {},
    } as unknown as Parameters<typeof createCostTracker>[0]['logger'];
    const t = createCostTracker({ logger });
    t.recordUsage({ inputTokens: 1, outputTokens: 1 });
    const matches = warns.filter((w) => w.includes('No pricing registered'));
    expect(matches).toHaveLength(0);
  });

  it('still emits unpriced-model warning when caller supplies an unknown model name', () => {
    const warns: string[] = [];
    const logger = {
      info: () => {}, warn: (m: string) => { warns.push(m); }, error: () => {}, debug: () => {},
    } as unknown as Parameters<typeof createCostTracker>[0]['logger'];
    const t = createCostTracker({ logger });
    t.recordUsage({ model: 'never-priced', inputTokens: 1, outputTokens: 1 });
    const matches = warns.filter((w) => w.includes('never-priced'));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('aggregates costByTrace under "unknown" when traceId is omitted', () => {
    const t = createCostTracker({ pricing: PRICING });
    t.recordUsage({ model: 'real-model', inputTokens: 100, outputTokens: 0 });
    t.recordUsage({ model: 'real-model', inputTokens: 200, outputTokens: 0 });
    expect(t.getCostByTrace('unknown')).toBeGreaterThan(0);
  });

  it('aggregates costByModel under "unknown" when model is omitted', () => {
    const t = createCostTracker({ pricing: PRICING });
    t.recordUsage({ traceId: 't', inputTokens: 100, outputTokens: 0 });
    t.recordUsage({ traceId: 't', inputTokens: 200, outputTokens: 0 });
    const map = t.getCostByModel();
    expect(map.has('unknown')).toBe(true);
    expect(map.get('unknown')).toBeGreaterThan(0);
  });

  it('caller-supplied identifiers still take precedence over the default', () => {
    const t = createCostTracker({ pricing: PRICING });
    const record = t.recordUsage({
      traceId: 'explicit-trace',
      model: 'real-model',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(record.traceId).toBe('explicit-trace');
    expect(record.model).toBe('real-model');
  });

  it('strict-mode still rejects empty model', () => {
    const t = createCostTracker({ strictMode: true, pricing: PRICING });
    expect(() =>
      t.recordUsage({ inputTokens: 1, outputTokens: 1 }),
    ).toThrow(/model is required/);
  });
});
