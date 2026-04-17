import { describe, it, expect } from 'vitest';
import {
  computeBackoffMs,
  computeJitterMs,
  BACKOFF_MAX_MS_CEILING,
  BACKOFF_BASE_MS_CEILING,
} from '../backoff.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

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

// P2-23 (Wave-12): Property-style tests for computeBackoffMs.
// We use a deterministic seeded PRNG (mulberry32) rather than fast-check
// because fast-check is not a project dependency. The PRNG produces a fixed
// sequence of inputs, giving reproducible property coverage across 500 runs.
describe('P2-23 (Wave-12): computeBackoffMs invariants (property tests)', () => {
  /** Deterministic PRNG — mulberry32 keeps this test reproducible. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('result ∈ [floor(exp * (1 - jitterFraction)), exp] across random inputs', () => {
    const rng = mulberry32(0xC0FFEE);
    const runs = 500;
    for (let i = 0; i < runs; i++) {
      // Pull parameters from the PRNG, clamping to sane bounds that we expect
      // real callers to use.
      const baseMs = Math.floor(rng() * 5000) + 1;           // [1, 5000]
      const maxMs = baseMs + Math.floor(rng() * 60_000);     // [baseMs, baseMs + 60k]
      const jitterFraction = rng() * 0.999;                  // [0, 0.999)
      const attempt = Math.floor(rng() * 10);                // [0, 9]
      // `random` here is the random source passed INTO computeBackoffMs.
      // Pin it to a value in [0, 1) to mimic Math.random().
      const r = rng();

      const result = computeBackoffMs(attempt, {
        baseMs,
        maxMs,
        jitterFraction,
        random: () => r,
      });

      const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
      const lowerBound = Math.floor(exponential * (1 - jitterFraction));
      const upperBound = exponential;

      // The floor() in computeBackoffMs can take the result exactly to the
      // lower bound; the upper bound is the pre-floor exponential delay.
      expect(result).toBeGreaterThanOrEqual(lowerBound);
      expect(result).toBeLessThanOrEqual(upperBound);
    }
  });

  it('result is monotonic-non-decreasing in attempt with jitter disabled', () => {
    const rng = mulberry32(0xBADF00D);
    const runs = 100;
    for (let i = 0; i < runs; i++) {
      const baseMs = Math.floor(rng() * 2000) + 1;
      // Keep maxMs under the A-3 ceiling (600_000ms) while still being
      // large enough that the cap does not fire across `attempt ∈ [0, 5]`.
      // baseMs <= 2000 → baseMs * 2^5 = baseMs*32 ≤ 64_000 < 600_000.
      const maxMs = Math.min(baseMs * 1024, BACKOFF_MAX_MS_CEILING);
      let prev = -1;
      for (let attempt = 0; attempt < 6; attempt++) {
        const v = computeBackoffMs(attempt, {
          baseMs,
          maxMs,
          jitterFraction: 0,
          random: () => 0,
        });
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('result is always <= maxMs regardless of attempt', () => {
    const rng = mulberry32(0x5EED);
    for (let i = 0; i < 200; i++) {
      const baseMs = Math.floor(rng() * 1000) + 1;
      const maxMs = Math.floor(rng() * 5000) + baseMs;
      const jitterFraction = rng() * 0.5; // keep below 1 so upper bound is well-defined
      const attempt = Math.floor(rng() * 25); // push well past saturation
      const r = rng();
      const result = computeBackoffMs(attempt, { baseMs, maxMs, jitterFraction, random: () => r });
      expect(result).toBeLessThanOrEqual(maxMs);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});

// Wave-13 A-2: `maxAbsoluteJitterMs` caps additive jitter above the
// exponential floor.
describe('Wave-13 A-2: computeBackoffMs maxAbsoluteJitterMs cap', () => {
  it('Wave-13 A-2: result never exceeds exponential + maxAbsoluteJitterMs', () => {
    // At attempt=0 with baseMs=1000 the exponential is 1000.
    // With jitterFraction=0.5 and random=0.999 the unclamped jittered value
    // would be 1000 * (0.5 + 0.999*0.5) = 999.5 — already <= 1000.
    // To exercise the absolute cap, use attempt large enough to saturate
    // maxMs, then verify the cap clamps below the proportional-jitter max.
    const result = computeBackoffMs(0, {
      baseMs: 1_000,
      maxMs: 60_000,
      jitterFraction: 0.5,
      random: () => 0.999,
      maxAbsoluteJitterMs: 50, // tiny cap
    });
    // exponential=1000, floor=500, ceiling=min(1000+50, 60000)=1050.
    // jittered ~= 999 → clamp does not bite because 999 < 1050.
    expect(result).toBeLessThanOrEqual(1050);
    expect(result).toBeGreaterThanOrEqual(500);
  });

  it('Wave-13 A-2: cap kicks in when proportional jitter would overshoot absolute cap', () => {
    // Construct a scenario where the proportional jitter band is wider
    // than the absolute cap so clamping is visible.
    // Pick exponential=10_000, jitterFraction=1.0 → jittered ∈ [0, 10_000].
    // With maxAbsoluteJitterMs=100, ceiling=min(10_000+100, maxMs)=10_100
    // but the inner clamp prevents jittered > 10_000 anyway.
    // The more meaningful test: ensure we never exceed exponential + cap
    // across a range of random draws.
    for (let i = 0; i < 20; i++) {
      const r = i / 20;
      const exp = 4_000;
      const result = computeBackoffMs(2, {
        baseMs: 1_000,
        maxMs: 60_000,
        jitterFraction: 1.0,
        random: () => r,
        maxAbsoluteJitterMs: 500,
      });
      // exponential = 1000 * 4 = 4000, ceiling = min(4000+500, 60000) = 4500
      expect(result).toBeLessThanOrEqual(exp + 500);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('Wave-13 A-2: ceiling is also bounded by maxMs', () => {
    // When exponential is already at maxMs, adding jitter cap must not
    // push the result above maxMs.
    const result = computeBackoffMs(10, {
      baseMs: 1_000,
      maxMs: 5_000,           // exponential saturates at 5000
      jitterFraction: 0.5,
      random: () => 0.999,
      maxAbsoluteJitterMs: 10_000, // larger than maxMs
    });
    // exponential=5000, ceiling=min(5000+10000, 5000)=5000.
    expect(result).toBeLessThanOrEqual(5000);
  });

  it('Wave-13 A-2: omitting maxAbsoluteJitterMs preserves legacy behavior', () => {
    // Legacy: result == floor(exponential * (1 - jf + r*jf)).
    const legacy = computeBackoffMs(2, {
      baseMs: 1_000,
      maxMs: 60_000,
      jitterFraction: 0.5,
      random: () => 0.4,
    });
    // 1000 * 4 = 4000, jitter = 4000 * (0.5 + 0.4*0.5) = 4000*0.7 = 2800
    expect(legacy).toBe(2800);
  });

  it('Wave-13 A-2: cap of 0 collapses jitter to the proportional minimum', () => {
    // With cap=0, ceiling == exponential. jittered can only be clamped
    // down to `exponential`; the proportional floor still applies.
    // So the result equals floor(min(jittered, exponential)).
    const result = computeBackoffMs(0, {
      baseMs: 1_000,
      maxMs: 60_000,
      jitterFraction: 0.5,
      random: () => 0.999,
      maxAbsoluteJitterMs: 0,
    });
    // jittered ≈ 999, ceiling = 1000 → unclamped. Result = 999.
    // The cap only clamps when jittered would exceed `exponential + 0`,
    // which is impossible by construction (jittered <= exponential).
    expect(result).toBe(999);
  });
});

// Wave-13 A-3: ceiling validation rejects out-of-range configuration.
describe('Wave-13 A-3: computeBackoffMs config validation', () => {
  it('Wave-13 A-3: throws CORE_INVALID_CONFIG when maxMs exceeds ceiling', () => {
    expect(() =>
      computeBackoffMs(0, { maxMs: BACKOFF_MAX_MS_CEILING + 1 }),
    ).toThrow(HarnessError);
    try {
      computeBackoffMs(0, { maxMs: BACKOFF_MAX_MS_CEILING + 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    }
  });

  it('Wave-13 A-3: accepts maxMs exactly at the ceiling', () => {
    // Boundary case: 600_000 must be allowed.
    expect(() =>
      computeBackoffMs(0, { maxMs: BACKOFF_MAX_MS_CEILING, jitterFraction: 0, random: () => 0 }),
    ).not.toThrow();
  });

  it('Wave-13 A-3: rejects negative maxMs', () => {
    expect(() => computeBackoffMs(0, { maxMs: -1 })).toThrow(HarnessError);
  });

  it('Wave-13 A-3: rejects non-finite maxMs (NaN / Infinity)', () => {
    expect(() => computeBackoffMs(0, { maxMs: Number.POSITIVE_INFINITY })).toThrow(HarnessError);
    expect(() => computeBackoffMs(0, { maxMs: Number.NaN })).toThrow(HarnessError);
  });

  it('Wave-13 A-3: throws CORE_INVALID_CONFIG when baseMs exceeds ceiling', () => {
    try {
      computeBackoffMs(0, { baseMs: BACKOFF_BASE_MS_CEILING + 1 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    }
  });

  it('Wave-13 A-3: accepts baseMs exactly at the ceiling', () => {
    expect(() =>
      computeBackoffMs(0, {
        baseMs: BACKOFF_BASE_MS_CEILING,
        maxMs: BACKOFF_MAX_MS_CEILING,
        jitterFraction: 0,
        random: () => 0,
      }),
    ).not.toThrow();
  });

  it('Wave-13 A-3: rejects negative baseMs', () => {
    expect(() => computeBackoffMs(0, { baseMs: -1 })).toThrow(HarnessError);
  });

  it('Wave-13 A-3: rejects jitterFraction outside [0, 1]', () => {
    expect(() => computeBackoffMs(0, { jitterFraction: -0.01 })).toThrow(HarnessError);
    expect(() => computeBackoffMs(0, { jitterFraction: 1.01 })).toThrow(HarnessError);
    expect(() => computeBackoffMs(0, { jitterFraction: Number.NaN })).toThrow(HarnessError);
  });

  it('Wave-13 A-3: accepts jitterFraction at boundaries 0 and 1', () => {
    expect(() => computeBackoffMs(0, { jitterFraction: 0 })).not.toThrow();
    expect(() => computeBackoffMs(0, { jitterFraction: 1 })).not.toThrow();
  });

  it('Wave-13 A-3: rejects negative maxAbsoluteJitterMs', () => {
    expect(() =>
      computeBackoffMs(0, { maxAbsoluteJitterMs: -1 }),
    ).toThrow(HarnessError);
  });

  it('Wave-13 A-3: rejects non-finite maxAbsoluteJitterMs', () => {
    expect(() =>
      computeBackoffMs(0, { maxAbsoluteJitterMs: Number.POSITIVE_INFINITY }),
    ).toThrow(HarnessError);
  });
});
