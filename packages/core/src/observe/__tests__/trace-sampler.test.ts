/**
 * Tests for `trace-sampler.ts` — round-3 extraction from trace-manager.
 */
import { describe, it, expect } from 'vitest';
import { createTraceSampler } from '../trace-sampler.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('createTraceSampler', () => {
  it('defaults to rate=1 and always samples', () => {
    const s = createTraceSampler();
    expect(s.getRate()).toBe(1);
    for (let i = 0; i < 50; i++) {
      expect(s.decide().sampled).toBe(true);
    }
  });

  it('rate=0 never samples', () => {
    const s = createTraceSampler(0);
    for (let i = 0; i < 50; i++) {
      expect(s.decide().sampled).toBe(false);
    }
  });

  it('rate=0.5 produces roughly half-and-half over many trials', () => {
    const s = createTraceSampler(0.5);
    let kept = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      if (s.decide().sampled) kept++;
    }
    // Generous bounds so a statistical fluke doesn't break CI.
    expect(kept).toBeGreaterThan(trials * 0.35);
    expect(kept).toBeLessThan(trials * 0.65);
  });

  it('snapshots the rate at decide() time', () => {
    const s = createTraceSampler(1);
    const snap = s.decide().rateSnapshot;
    expect(snap).toBe(1);
    s.setRate(0);
    expect(s.getRate()).toBe(0);
  });

  it('rejects invalid defaultSamplingRate with defaultSamplingRate-shaped message', () => {
    expect(() => createTraceSampler(-1)).toThrow(/defaultSamplingRate/);
    expect(() => createTraceSampler(1.5)).toThrow(/defaultSamplingRate/);
    expect(() => createTraceSampler(Number.NaN)).toThrow(/defaultSamplingRate/);
    try {
      createTraceSampler(-1);
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    }
  });

  it('rejects invalid runtime setRate with samplingRate-shaped message', () => {
    const s = createTraceSampler(1);
    expect(() => s.setRate(-0.1)).toThrow(/samplingRate must be a finite number/);
    expect(() => s.setRate(2)).toThrow(/samplingRate must be a finite number/);
  });
});
