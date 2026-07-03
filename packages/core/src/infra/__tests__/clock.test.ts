/**
 * Clock port — the injectable wall-clock seam. These tests pin the default
 * (`systemClock` tracks `Date.now()`) and demonstrate the fake-clock pattern
 * the kernel factories rely on for deterministic time.
 */

import { describe, it, expect } from 'vitest';
import { systemClock, type Clock } from '../clock.js';

describe('clock', () => {
  it('systemClock.now() returns the current epoch millis (tracks Date.now)', () => {
    const before = Date.now();
    const t = systemClock.now();
    const after = Date.now();
    expect(typeof t).toBe('number');
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('a fake Clock can be advanced deterministically without real waiting', () => {
    let t = 1_000;
    const fake: Clock = { now: () => t };
    expect(fake.now()).toBe(1_000);
    t += 5_000;
    expect(fake.now()).toBe(6_000);
  });
});
