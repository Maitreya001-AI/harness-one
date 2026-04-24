/**
 * Mutation-testing coverage for `src/infra/validate.ts`.
 *
 * The contract tests in `validate.test.ts` stay untouched; this file adds
 * assertions whose sole purpose is to kill specific Stryker-reported
 * mutants (line numbers noted per-block so future Stryker runs can map
 * survivors back to the test that is supposed to catch them).
 *
 * Target: `validate.ts` is a safety boundary, so its mutation score is
 * pinned at >= 85 % in `stryker.conf.mjs`.
 */

import { describe, it, expect } from 'vitest';
import {
  requirePositiveInt,
  requireNonNegativeInt,
  requireFinitePositive,
  requireFiniteNonNegative,
  requireUnitInterval,
  validatePricingEntry,
  validatePricingArray,
} from '../validate.js';
import { HarnessError } from '../../core/errors.js';

function catchHarness(fn: () => void): HarnessError {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof HarnessError)) {
      throw new Error(`expected HarnessError, got ${String(err)}`);
    }
    return err;
  }
  throw new Error('expected helper to throw');
}

describe('validate.ts — undefined short-circuit branches', () => {
  // Stryker mutates `if (value === undefined) return;` into `if (false) return;`.
  // When the early return is skipped, the downstream `!Number.isInteger(undefined)`
  // / `!Number.isFinite(undefined)` check evaluates truthy and the helper
  // throws — a helper that accepts `undefined` on the baseline therefore
  // flips behaviour under the mutant.
  it('requireNonNegativeInt accepts undefined (validate.ts:53)', () => {
    expect(() => requireNonNegativeInt(undefined, 'retries')).not.toThrow();
  });
  it('requireFinitePositive accepts undefined (validate.ts:72)', () => {
    expect(() => requireFinitePositive(undefined, 'budget')).not.toThrow();
  });
  it('requireFiniteNonNegative accepts undefined (validate.ts:91)', () => {
    expect(() => requireFiniteNonNegative(undefined, 'delay')).not.toThrow();
  });
  it('requireUnitInterval accepts undefined (validate.ts:109)', () => {
    expect(() => requireUnitInterval(undefined, 'rate')).not.toThrow();
  });
});

describe('validate.ts — strict < 0 boundary for pricing invalid check', () => {
  // Stryker mutates `n < 0` → `n <= 0` in `validatePricingEntry`'s
  // `invalid` predicate. A pricing entry where any numeric field is
  // exactly 0 (free tiers legitimately bill $0 per token) must still
  // validate; the mutant would spuriously reject it.
  it('accepts an entry with inputPer1kTokens exactly 0', () => {
    expect(() =>
      validatePricingEntry({
        model: 'free',
        inputPer1kTokens: 0,
        outputPer1kTokens: 0,
      }),
    ).not.toThrow();
  });
  it('accepts an entry whose optional cache fields are exactly 0', () => {
    expect(() =>
      validatePricingEntry({
        model: 'mixed',
        inputPer1kTokens: 0.01,
        outputPer1kTokens: 0.02,
        cacheReadPer1kTokens: 0,
        cacheWritePer1kTokens: 0,
      }),
    ).not.toThrow();
  });
});

describe('validate.ts — validatePricingArray actually iterates', () => {
  // Two mutants survived the baseline because no existing test forced the
  // function to reach its loop:
  //   - BlockStatement mutant drops the whole body (line 160).
  //   - ConditionalExpression mutant flips the undefined guard to `true`,
  //     which exits before iterating (line 161).
  // A bad entry inside a non-empty array must still throw.
  it('rejects a sole bad entry', () => {
    expect(() =>
      validatePricingArray([
        { model: 'x', inputPer1kTokens: -1, outputPer1kTokens: 0 },
      ]),
    ).toThrow(HarnessError);
  });
  it('rejects when any entry among several is bad', () => {
    const ok = { model: 'ok', inputPer1kTokens: 0.01, outputPer1kTokens: 0.02 };
    const bad = {
      model: 'bad',
      inputPer1kTokens: Number.NaN,
      outputPer1kTokens: 0,
    };
    expect(() => validatePricingArray([ok, bad])).toThrow(HarnessError);
  });
});

describe('validate.ts — HarnessError.message template preservation', () => {
  // Stryker empties the template literal that builds each helper's error
  // `message`. The existing contract tests assert message content for
  // `requirePositiveInt` via downstream callers but not for the other
  // helpers — these direct-message assertions kill the remaining mutants.
  it('requireNonNegativeInt mentions the field name', () => {
    expect(catchHarness(() => requireNonNegativeInt(-1, 'retries')).message).toBe(
      'retries must be a non-negative integer',
    );
  });
  it('requireFinitePositive mentions the field name', () => {
    expect(catchHarness(() => requireFinitePositive(0, 'budget')).message).toBe(
      'budget must be a finite positive number',
    );
  });
  it('requireFiniteNonNegative mentions the field name', () => {
    expect(catchHarness(() => requireFiniteNonNegative(-1, 'delay')).message).toBe(
      'delay must be a non-negative finite number',
    );
  });
});

describe('validate.ts — HarnessError.suggestion field preservation', () => {
  // Stryker empties the third-arg `suggestion` string in every HarnessError
  // constructor call. The suggestions are part of the user-facing recovery
  // instructions on every config error, so we pin the exact text per helper.
  it('requirePositiveInt.suggestion', () => {
    expect(catchHarness(() => requirePositiveInt(0, 'x')).suggestion).toBe(
      'Use an integer value >= 1',
    );
  });
  it('requireNonNegativeInt.suggestion', () => {
    expect(catchHarness(() => requireNonNegativeInt(-1, 'x')).suggestion).toBe(
      'Use an integer value >= 0',
    );
  });
  it('requireFinitePositive.suggestion', () => {
    expect(catchHarness(() => requireFinitePositive(0, 'x')).suggestion).toBe(
      'Use a value > 0',
    );
  });
  it('requireFiniteNonNegative.suggestion', () => {
    expect(catchHarness(() => requireFiniteNonNegative(-1, 'x')).suggestion).toBe(
      'Use a value >= 0',
    );
  });
  it('requireUnitInterval.suggestion', () => {
    expect(catchHarness(() => requireUnitInterval(2, 'x')).suggestion).toBe(
      'Use a value between 0 and 1 inclusive',
    );
  });
  it('validatePricingEntry.suggestion', () => {
    expect(
      catchHarness(() =>
        validatePricingEntry({
          model: 'bad',
          inputPer1kTokens: -1,
          outputPer1kTokens: 0,
        }),
      ).suggestion,
    ).toBe('All pricing values must be finite numbers >= 0');
  });
});
