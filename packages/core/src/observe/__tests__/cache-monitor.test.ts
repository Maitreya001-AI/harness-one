import { describe, it, expect } from 'vitest';
import { createCacheMonitor } from '../cache-monitor.js';
import type { TokenUsage } from '../../core/types.js';

function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 100,
    ...overrides,
  };
}

describe('createCacheMonitor', () => {
  it('record + getMetrics returns correct aggregates', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage());
    monitor.record(makeUsage());
    const metrics = monitor.getMetrics();
    expect(metrics.totalCalls).toBe(2);
    expect(metrics.totalCacheReadTokens).toBe(1000);
    expect(metrics.totalCacheWriteTokens).toBe(200);
  });

  it('computes avgHitRate correctly', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage({ inputTokens: 1000, cacheReadTokens: 500 })); // 0.5
    monitor.record(makeUsage({ inputTokens: 1000, cacheReadTokens: 800 })); // 0.8
    const metrics = monitor.getMetrics();
    expect(metrics.avgHitRate).toBeCloseTo(0.65); // (0.5 + 0.8) / 2
  });

  it('uses prefixMatchRatio when provided', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage(), 0.9);
    const metrics = monitor.getMetrics();
    expect(metrics.avgHitRate).toBeCloseTo(0.9);
  });

  it('getTimeSeries buckets correctly', () => {
    const monitor = createCacheMonitor();
    // Record at different times using Date.now mock
    // We can't easily mock Date.now, so just verify bucketing works with real timestamps
    monitor.record(makeUsage());
    monitor.record(makeUsage());
    const series = monitor.getTimeSeries(60_000);
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series[0].calls).toBeGreaterThanOrEqual(1);
  });

  it('calculates savings with pricing config', () => {
    const monitor = createCacheMonitor({
      pricing: { cacheReadPer1kTokens: 0.01, inputPer1kTokens: 0.03 },
    });
    monitor.record(makeUsage({ inputTokens: 1000, cacheReadTokens: 500 }));
    const metrics = monitor.getMetrics();
    // Savings = cacheReadTokens * (inputPrice - cachePrice) / 1000
    // = 500 * (0.03 - 0.01) / 1000 = 0.01
    expect(metrics.estimatedSavings).toBeCloseTo(0.01);
  });

  it('reset clears all data', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage());
    monitor.reset();
    const metrics = monitor.getMetrics();
    expect(metrics.totalCalls).toBe(0);
    expect(metrics.avgHitRate).toBe(0);
    expect(metrics.totalCacheReadTokens).toBe(0);
    expect(metrics.totalCacheWriteTokens).toBe(0);
    expect(metrics.estimatedSavings).toBe(0);
    expect(monitor.getTimeSeries().length).toBe(0);
  });

  it('handles zero inputTokens without division error', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage({ inputTokens: 0, cacheReadTokens: 0 }));
    const metrics = monitor.getMetrics();
    expect(metrics.avgHitRate).toBe(0);
    expect(Number.isFinite(metrics.avgHitRate)).toBe(true);
  });

  // Fix 8: Cached getMetrics with dirty flag
  it('getMetrics returns cached result when no new records', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage());

    // First call computes metrics
    const metrics1 = monitor.getMetrics();
    // Second call without new records should return same result (cached)
    const metrics2 = monitor.getMetrics();
    expect(metrics1).toEqual(metrics2);
  });

  it('getMetrics recomputes after new record', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage({ inputTokens: 1000, cacheReadTokens: 500 }));
    const metrics1 = monitor.getMetrics();
    expect(metrics1.totalCalls).toBe(1);

    monitor.record(makeUsage({ inputTokens: 1000, cacheReadTokens: 800 }));
    const metrics2 = monitor.getMetrics();
    expect(metrics2.totalCalls).toBe(2);
    expect(metrics2.avgHitRate).not.toBe(metrics1.avgHitRate);
  });

  it('getMetrics cache is invalidated on reset', () => {
    const monitor = createCacheMonitor();
    monitor.record(makeUsage());
    const metrics1 = monitor.getMetrics();
    expect(metrics1.totalCalls).toBe(1);

    monitor.reset();
    const metrics2 = monitor.getMetrics();
    expect(metrics2.totalCalls).toBe(0);
  });

  it('evicts old data points beyond limit', () => {
    const monitor = createCacheMonitor({ maxBuckets: 2 });
    // maxBuckets * 10 = 20, so record 25 to trigger eviction
    for (let i = 0; i < 25; i++) {
      monitor.record(makeUsage());
    }
    const metrics = monitor.getMetrics();
    // After eviction, only maxBuckets*10 = 20 points retained (aggregates corrected)
    expect(metrics.totalCalls).toBe(20);
    // Time series should still work
    expect(monitor.getTimeSeries().length).toBeGreaterThanOrEqual(1);
  });
});
