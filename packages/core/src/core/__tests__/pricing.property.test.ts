/**
 * J6 · Property: `priceUsage` is a well-behaved pure function.
 *
 * (a) For non-negative tokens + non-negative prices, the result is
 *     non-negative and finite.
 * (b) Unit conversion is per-1000-tokens: doubling input tokens exactly
 *     doubles the input portion of the cost (modulo 6-decimal rounding).
 * (c) Undefined pricing → 0 cost, independent of usage.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { priceUsage, type ModelPricing } from '../pricing.js';

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

const nonNegTokens = fc.integer({ min: 0, max: 1_000_000 });
const nonNegPrice = fc.double({ min: 0, max: 1, noNaN: true });

const usageArb = fc.record({
  traceId: fc.string({ minLength: 1, maxLength: 6 }),
  model: fc.constantFrom('m1', 'm2'),
  inputTokens: nonNegTokens,
  outputTokens: nonNegTokens,
  cacheReadTokens: fc.option(nonNegTokens, { nil: undefined }),
  cacheWriteTokens: fc.option(nonNegTokens, { nil: undefined }),
});

const pricingArb: fc.Arbitrary<ModelPricing> = fc.record({
  model: fc.constantFrom('m1', 'm2'),
  inputPer1kTokens: nonNegPrice,
  outputPer1kTokens: nonNegPrice,
  cacheReadPer1kTokens: fc.option(nonNegPrice, { nil: undefined }),
  cacheWritePer1kTokens: fc.option(nonNegPrice, { nil: undefined }),
});

describe('J6 · priceUsage (property)', () => {
  it('non-negative + finite for non-negative inputs', () => {
    fc.assert(
      fc.property(usageArb, pricingArb, (usage, pricing) => {
        const cost = priceUsage(usage, pricing);
        expect(Number.isFinite(cost)).toBe(true);
        expect(cost).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('undefined pricing → 0 regardless of usage', () => {
    fc.assert(
      fc.property(usageArb, (usage) => {
        expect(priceUsage(usage, undefined)).toBe(0);
      }),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });

  it('zero tokens → 0 cost', () => {
    fc.assert(
      fc.property(pricingArb, (pricing) => {
        const cost = priceUsage(
          {
            traceId: 't',
            model: pricing.model,
            inputTokens: 0,
            outputTokens: 0,
          },
          pricing,
        );
        expect(cost).toBe(0);
      }),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });

  it('per-1k unit: doubling input tokens doubles the input portion', () => {
    // Isolate the input component by nulling outputPer1kTokens and cache prices.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        fc.double({
          min: 0.0001,
          max: 1,
          noNaN: true,
        }),
        (inputTokens, inputPrice) => {
          const pricing: ModelPricing = {
            model: 'm1',
            inputPer1kTokens: inputPrice,
            outputPer1kTokens: 0,
          };
          const base = priceUsage(
            { traceId: 't', model: 'm1', inputTokens, outputTokens: 0 },
            pricing,
          );
          const doubled = priceUsage(
            {
              traceId: 't',
              model: 'm1',
              inputTokens: inputTokens * 2,
              outputTokens: 0,
            },
            pricing,
          );
          // Allow rounding: both values are already rounded to 1e-6.
          expect(doubled).toBeCloseTo(base * 2, 5);
        },
      ),
      { numRuns: 200, ...(seed !== undefined && { seed }) },
    );
  });

  it('non-finite tokens short-circuit to 0', () => {
    fc.assert(
      fc.property(
        pricingArb,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (pricing, weirdNumber) => {
          const cost = priceUsage(
            {
              traceId: 't',
              model: pricing.model,
              inputTokens: weirdNumber,
              outputTokens: 100,
            },
            pricing,
          );
          expect(cost).toBe(0);
        },
      ),
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
