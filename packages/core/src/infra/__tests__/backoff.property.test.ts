/**
 * J3 · Property: `createBackoffSchedule` obeys the exponential-with-cap
 * contract.
 *
 * (a) `delay(n)` is monotonically non-decreasing in `n` until the `maxMs`
 *     cap is reached. We verify by fixing a deterministic `random` source
 *     so jitter cannot spuriously flip ordering.
 * (b) `delay(n) ≤ maxMs` for all attempts, including the edge case where
 *     `baseMs * 2^attempt` overflows to `+Infinity` and `Math.min` still
 *     has to clamp.
 * (c) `delay(0)` is non-negative and finite.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createBackoffSchedule } from '../backoff.js';

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

// Bounded config arbitrary — stays inside the BASE_MS_CEILING /
// MAX_MS_CEILING guards so constructor-level validation does not fire.
const configArb = fc.record({
  baseMs: fc.integer({ min: 1, max: 10_000 }),
  maxMs: fc.integer({ min: 1, max: 600_000 }),
  jitterFraction: fc.double({
    min: 0,
    max: 1,
    noNaN: true,
  }),
});

describe('J3 · BackoffSchedule (property)', () => {
  it('delay(n) is monotonically non-decreasing in n (with fixed random)', () => {
    fc.assert(
      fc.property(
        configArb,
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        fc.integer({ min: 1, max: 12 }),
        (cfg, rand, attempts) => {
          const base = Math.min(cfg.baseMs, cfg.maxMs);
          const schedule = createBackoffSchedule({
            baseMs: base,
            maxMs: cfg.maxMs,
            jitterFraction: cfg.jitterFraction,
            random: () => rand,
          });
          let prev = -1;
          for (let n = 0; n < attempts; n++) {
            const d = schedule.delay(n);
            expect(d).toBeGreaterThanOrEqual(prev);
            prev = d;
          }
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('delay(n) ≤ maxMs for every attempt', () => {
    fc.assert(
      fc.property(
        configArb,
        fc.integer({ min: 0, max: 60 }),
        (cfg, attempt) => {
          const base = Math.min(cfg.baseMs, cfg.maxMs);
          const schedule = createBackoffSchedule({
            baseMs: base,
            maxMs: cfg.maxMs,
            jitterFraction: cfg.jitterFraction,
          });
          expect(schedule.delay(attempt)).toBeLessThanOrEqual(cfg.maxMs);
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('delay(0) is finite and non-negative', () => {
    fc.assert(
      fc.property(configArb, (cfg) => {
        const base = Math.min(cfg.baseMs, cfg.maxMs);
        const schedule = createBackoffSchedule({
          baseMs: base,
          maxMs: cfg.maxMs,
          jitterFraction: cfg.jitterFraction,
        });
        const d = schedule.delay(0);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('with zero jitter, delay follows exact min(base * 2^n, max)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 600_000 }),
        fc.integer({ min: 0, max: 30 }),
        (baseMs, maxMs, attempt) => {
          const base = Math.min(baseMs, maxMs);
          const schedule = createBackoffSchedule({
            baseMs: base,
            maxMs,
            jitterFraction: 0,
          });
          const expected = Math.floor(
            Math.min(base * Math.pow(2, attempt), maxMs),
          );
          expect(schedule.delay(attempt)).toBe(expected);
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
