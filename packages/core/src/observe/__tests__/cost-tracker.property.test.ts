/**
 * J5 · Property: `CostTracker.recordUsage` + `updateUsage` preserve the
 * monotonicity invariant the whole cost subsystem depends on.
 *
 * (a) After any sequence of non-negative `recordUsage` calls, the running
 *     total cost is non-decreasing. Recording zero-cost rows (unknown model)
 *     keeps the total unchanged.
 * (b) `updateUsage` can only ever INCREASE token counts — attempting to
 *     lower input/output tokens throws. So given a sequence of updates
 *     that stays above the existing floor, the recorded totals never
 *     shrink.
 * (c) Using Kahan summation under the hood means repeated tiny cost
 *     additions must not drift past a tolerance that scales with the
 *     number of operations. We assert equality to the naive sum within
 *     1e-6 of Kahan precision over ≤200 adds.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createCostTracker } from '../cost-tracker.js';

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

const pricingArb = fc.record({
  model: fc.constantFrom('m1', 'm2', 'm3'),
  inputPer1kTokens: fc.double({ min: 0, max: 0.05, noNaN: true }),
  outputPer1kTokens: fc.double({ min: 0, max: 0.1, noNaN: true }),
});

const recordArb = fc.record({
  traceId: fc.string({ minLength: 1, maxLength: 6 }),
  model: fc.constantFrom('m1', 'm2', 'm3'),
  inputTokens: fc.integer({ min: 0, max: 10_000 }),
  outputTokens: fc.integer({ min: 0, max: 10_000 }),
});

describe('J5 · CostTracker (property)', () => {
  it('total cost is non-decreasing under any recordUsage sequence', () => {
    fc.assert(
      fc.property(
        fc.array(pricingArb, { minLength: 1, maxLength: 3 }),
        fc.array(recordArb, { minLength: 0, maxLength: 80 }),
        (pricing, rows) => {
          const tracker = createCostTracker({
            pricing,
            warnUnpricedModels: false,
          });
          let prev = 0;
          for (const row of rows) {
            tracker.recordUsage(row);
            const now = tracker.getTotalCost();
            expect(now).toBeGreaterThanOrEqual(prev - 1e-12);
            prev = now;
          }
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('updateUsage can only raise tokens — downward updates throw', () => {
    fc.assert(
      fc.property(
        fc.record({
          model: fc.constant('m1'),
          baseInput: fc.integer({ min: 100, max: 1000 }),
          baseOutput: fc.integer({ min: 100, max: 1000 }),
          deltaInput: fc.integer({ min: 1, max: 500 }),
          deltaOutput: fc.integer({ min: 1, max: 500 }),
        }),
        ({ model, baseInput, baseOutput, deltaInput, deltaOutput }) => {
          const tracker = createCostTracker({
            pricing: [{ model, inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 }],
            warnUnpricedModels: false,
          });
          tracker.recordUsage({
            traceId: 't',
            model,
            inputTokens: baseInput,
            outputTokens: baseOutput,
          });
          // Raising is fine.
          const raised = tracker.updateUsage('t', {
            inputTokens: baseInput + deltaInput,
            outputTokens: baseOutput + deltaOutput,
          });
          expect(raised?.inputTokens).toBe(baseInput + deltaInput);
          expect(raised?.outputTokens).toBe(baseOutput + deltaOutput);
          // Lowering throws.
          expect(() => tracker.updateUsage('t', { inputTokens: baseInput - 1 })).toThrow();
          expect(() => tracker.updateUsage('t', { outputTokens: baseOutput - 1 })).toThrow();
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });

  it('running total matches the naive sum within Kahan tolerance', () => {
    // Kahan summation compensates drift; for 200 adds of small doubles the
    // drift should be << 1e-9. We use a tolerance of 1e-6 to stay robust to
    // any double conversions between the cost math and the test mirror.
    fc.assert(
      fc.property(
        fc.array(recordArb, { minLength: 0, maxLength: 200 }),
        (rows) => {
          const pricing = [
            { model: 'm1', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
            { model: 'm2', inputPer1kTokens: 0.01, outputPer1kTokens: 0.03 },
            { model: 'm3', inputPer1kTokens: 0.0005, outputPer1kTokens: 0.002 },
          ];
          const tracker = createCostTracker({ pricing, warnUnpricedModels: false });
          const priceFor = new Map(pricing.map((p) => [p.model, p]));
          let naive = 0;
          for (const row of rows) {
            const record = tracker.recordUsage(row);
            const p = priceFor.get(row.model);
            const expected = p
              ? Math.round(
                ((row.inputTokens / 1000) * p.inputPer1kTokens +
                  (row.outputTokens / 1000) * p.outputPer1kTokens) *
                  1_000_000,
              ) / 1_000_000
              : 0;
            expect(record.estimatedCost).toBeCloseTo(expected, 6);
            naive += expected;
          }
          expect(tracker.getTotalCost()).toBeCloseTo(naive, 6);
        },
      ),
      { numRuns: 150, ...(seed !== undefined && { seed }) },
    );
  });
});
