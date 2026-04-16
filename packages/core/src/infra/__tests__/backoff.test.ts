import { describe, it, expect } from 'vitest';
import { computeBackoffMs, computeJitterMs } from '../backoff.js';

describe('computeBackoffMs', () => {
  it('returns base delay at attempt 0 (modulo jitter)', () => {
    const result = computeBackoffMs(0, { random: () => 0.5 });
    // base=1000, max=10000, jitter=0.5 → 1000 * (0.5 + 0.5*0.5) = 750
    expect(result).toBe(750);
  });

  it('doubles the base delay per attempt', () => {
    const noJitter = { jitterFraction: 0, random: () => 0 };
    expect(computeBackoffMs(0, { ...noJitter, baseMs: 1000 })).toBe(1000);
    expect(computeBackoffMs(1, { ...noJitter, baseMs: 1000 })).toBe(2000);
    expect(computeBackoffMs(2, { ...noJitter, baseMs: 1000 })).toBe(4000);
    expect(computeBackoffMs(3, { ...noJitter, baseMs: 1000 })).toBe(8000);
  });

  it('caps at maxMs', () => {
    const noJitter = { jitterFraction: 0, random: () => 0 };
    expect(computeBackoffMs(10, { ...noJitter, baseMs: 1000, maxMs: 5000 })).toBe(5000);
    expect(computeBackoffMs(20, { ...noJitter, baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });

  it('jitter produces range [base*(1-fraction), base)', () => {
    // random=0 → minimum jitter
    const low = computeBackoffMs(0, { baseMs: 1000, maxMs: 10000, jitterFraction: 0.5, random: () => 0 });
    // random=0.999 → near maximum
    const high = computeBackoffMs(0, { baseMs: 1000, maxMs: 10000, jitterFraction: 0.5, random: () => 0.999 });

    expect(low).toBe(500);  // 1000 * (1 - 0.5 + 0 * 0.5) = 500
    expect(high).toBe(999); // 1000 * (1 - 0.5 + 0.999 * 0.5) = 999.5 → floor = 999
  });

  it('uses defaults when no config provided', () => {
    // Default: baseMs=1000, maxMs=10000, jitterFraction=0.5
    const result = computeBackoffMs(0);
    expect(result).toBeGreaterThanOrEqual(500);
    expect(result).toBeLessThanOrEqual(1000);
  });

  it('accepts custom random source', () => {
    let callCount = 0;
    const fixed = () => { callCount++; return 0.42; };
    computeBackoffMs(0, { random: fixed });
    expect(callCount).toBe(1);
  });

  it('handles attempt=0 with baseMs=0', () => {
    expect(computeBackoffMs(0, { baseMs: 0, jitterFraction: 0, random: () => 0 })).toBe(0);
  });

  it('handles jitterFraction=0 (no jitter)', () => {
    const result = computeBackoffMs(2, { baseMs: 100, maxMs: 50000, jitterFraction: 0, random: () => 0.99 });
    expect(result).toBe(400); // 100 * 4 = 400, no jitter applied
  });
});

describe('computeJitterMs', () => {
  it('returns 0 when random returns 0', () => {
    expect(computeJitterMs(1000, 0.1, () => 0)).toBe(0);
  });

  it('returns up to fraction * baseMs', () => {
    expect(computeJitterMs(1000, 0.1, () => 0.999)).toBe(99); // floor(999 * 0.1 * 0.999) = 99
  });

  it('uses default fraction of 0.1', () => {
    const result = computeJitterMs(1000, undefined, () => 0.5);
    expect(result).toBe(50); // floor(0.5 * 0.1 * 1000) = 50
  });

  it('uses Math.random by default (non-deterministic)', () => {
    const result = computeJitterMs(10000);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(1000); // 10% of 10000
  });

  it('handles baseMs=0', () => {
    expect(computeJitterMs(0, 0.5, () => 0.99)).toBe(0);
  });
});
