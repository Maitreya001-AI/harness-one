/**
 * Contract tests for the shared validate helpers. Each helper is small
 * but the behaviour matters for back-compat: the error code and
 * suggestion text were historically embedded in preset's error handling
 * paths, and we want to guarantee they don't drift after centralisation.
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
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('requirePositiveInt', () => {
  it('accepts undefined and positive integers', () => {
    expect(() => requirePositiveInt(undefined, 'x')).not.toThrow();
    expect(() => requirePositiveInt(1, 'x')).not.toThrow();
    expect(() => requirePositiveInt(1000, 'x')).not.toThrow();
  });
  it('rejects zero, negatives, fractions, NaN, Infinity', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() => requirePositiveInt(bad, 'x')).toThrow(HarnessError);
    }
  });
  it('produces CORE_INVALID_CONFIG code', () => {
    try {
      requirePositiveInt(0, 'maxIterations');
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
      expect((err as HarnessError).message).toContain('maxIterations');
    }
  });
});

describe('requireNonNegativeInt', () => {
  it('accepts zero', () => {
    expect(() => requireNonNegativeInt(0, 'retries')).not.toThrow();
  });
  it('rejects negatives and fractions', () => {
    expect(() => requireNonNegativeInt(-1, 'r')).toThrow(HarnessError);
    expect(() => requireNonNegativeInt(1.5, 'r')).toThrow(HarnessError);
  });
});

describe('requireFinitePositive', () => {
  it('accepts fractions > 0', () => {
    expect(() => requireFinitePositive(0.01, 'budget')).not.toThrow();
  });
  it('rejects zero', () => {
    expect(() => requireFinitePositive(0, 'budget')).toThrow(HarnessError);
  });
  it('rejects Infinity and NaN', () => {
    expect(() => requireFinitePositive(Infinity, 'x')).toThrow(HarnessError);
    expect(() => requireFinitePositive(Number.NaN, 'x')).toThrow(HarnessError);
  });
});

describe('requireFiniteNonNegative', () => {
  it('accepts zero and fractions', () => {
    expect(() => requireFiniteNonNegative(0, 'd')).not.toThrow();
    expect(() => requireFiniteNonNegative(0.5, 'd')).not.toThrow();
  });
  it('rejects negatives and NaN', () => {
    expect(() => requireFiniteNonNegative(-0.1, 'd')).toThrow(HarnessError);
    expect(() => requireFiniteNonNegative(Number.NaN, 'd')).toThrow(HarnessError);
  });
});

describe('requireUnitInterval', () => {
  it('accepts bounds 0 and 1', () => {
    expect(() => requireUnitInterval(0, 'f')).not.toThrow();
    expect(() => requireUnitInterval(1, 'f')).not.toThrow();
  });
  it('rejects values outside [0, 1]', () => {
    expect(() => requireUnitInterval(1.01, 'f')).toThrow(HarnessError);
    expect(() => requireUnitInterval(-0.01, 'f')).toThrow(HarnessError);
  });
});

describe('Wave-16 m3: consolidated callers route through infra/validate', () => {
  // These witness-tests ensure that the subsystems that Wave-16 consolidated
  // keep delegating to the shared helpers. A regression that reintroduces a
  // bespoke inline guard will surface here via a divergent error message.
  it('admission-controller rejects non-integer maxInflight via the helper', async () => {
    const mod = await import('../admission-controller.js');
    expect(() => mod.createAdmissionController({ maxInflight: 1.5 })).toThrow(
      'AdmissionController.maxInflight must be a positive integer',
    );
  });

  it('circuit-breaker rejects zero failureThreshold via the helper', async () => {
    const mod = await import('../circuit-breaker.js');
    expect(() => mod.createCircuitBreaker({ failureThreshold: 0 })).toThrow(
      'failureThreshold must be a positive integer',
    );
  });

  it('execution-strategies rejects zero maxConcurrency via the helper', async () => {
    const mod = await import('../../core/execution-strategies.js');
    expect(() => mod.createParallelStrategy({ maxConcurrency: 0 })).toThrow(
      'maxConcurrency must be a positive integer',
    );
  });

  it('trace-sampler rejects rate > 1 via the helper', async () => {
    const mod = await import('../../observe/trace-sampler.js');
    const s = mod.createTraceSampler(0.5);
    expect(() => s.setRate(1.1)).toThrow('samplingRate must be a finite number in [0, 1]');
  });
});

describe('validatePricingEntry / validatePricingArray', () => {
  const good = {
    model: 'gpt-test',
    inputPer1kTokens: 0.01,
    outputPer1kTokens: 0.02,
  } as const;

  it('accepts valid entries', () => {
    expect(() => validatePricingEntry(good)).not.toThrow();
    expect(() => validatePricingArray([good, { ...good, model: 'b' }])).not.toThrow();
    expect(() => validatePricingArray(undefined)).not.toThrow();
  });

  it('rejects negative or non-finite values and quotes the model name', () => {
    expect(() =>
      validatePricingEntry({ ...good, inputPer1kTokens: -1 }),
    ).toThrow(/`gpt-test`/);
    expect(() =>
      validatePricingEntry({ ...good, outputPer1kTokens: Number.NaN }),
    ).toThrow(HarnessError);
    expect(() =>
      validatePricingEntry({ ...good, cacheReadPer1kTokens: Infinity }),
    ).toThrow(HarnessError);
    expect(() =>
      validatePricingEntry({ ...good, cacheWritePer1kTokens: -0.5 }),
    ).toThrow(HarnessError);
  });

  it('quotes with backticks so hostile model names cannot break the shape', () => {
    const attack = { ...good, model: '`malicious` "name"', inputPer1kTokens: -1 };
    try {
      validatePricingEntry(attack);
    } catch (err) {
      // The outer backticks still delimit: the field starts with `\` and ends with `\``.
      expect((err as Error).message).toContain('``malicious` "name"`');
    }
  });
});
