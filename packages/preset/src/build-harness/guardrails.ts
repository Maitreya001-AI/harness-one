/**
 * Guardrail-pipeline factory helper — constructs a {@link GuardrailPipeline}
 * from the user-facing `config.guardrails` bag. Extracted from the monolithic
 * `index.ts`; behavior unchanged.
 *
 * @module
 */

import {
  createPipeline,
  createInjectionDetector,
  createRateLimiter,
  createContentFilter,
  createPIIDetector,
} from 'harness-one/guardrails';
import type { GuardrailPipeline, Guardrail } from 'harness-one/guardrails';

import type { HarnessConfig } from './types.js';

/**
 * Build a {@link GuardrailPipeline} from `config.guardrails`.
 *
 * Each sub-option is optional; when unset the corresponding guardrail is not
 * added to the pipeline. The returned pipeline runs input guardrails
 * (injection detection, rate limiting, PII) on user messages and output
 * guardrails (content filter) on assistant responses.
 */
export function createGuardrails(config: HarnessConfig): GuardrailPipeline {
  const entries: Array<{ name: string; guard: Guardrail; direction: 'input' | 'output' }> = [];

  if (config.guardrails?.injection) {
    const sensitivity = typeof config.guardrails.injection === 'object'
      ? config.guardrails.injection.sensitivity
      : undefined;
    const detector = createInjectionDetector(sensitivity !== undefined ? { sensitivity } : {});
    entries.push({
      name: detector.name,
      guard: detector.guard,
      direction: 'input',
    });
  }

  if (config.guardrails?.rateLimit) {
    // P1-14: config shape is deep-readonly; factory accepts mutable shape.
    // Spread to a fresh mutable object so readonly→mutable conversion is
    // explicit and contained to this boundary.
    const { max, windowMs } = config.guardrails.rateLimit;
    const limiter = createRateLimiter({ max, windowMs });
    entries.push({
      name: limiter.name,
      guard: limiter.guard,
      direction: 'input',
    });
  }

  if (config.guardrails?.contentFilter) {
    // P1-14: clone the `blocked` array so the deep-readonly config-level
    // array cannot alias the internal mutable representation used by the
    // filter factory.
    const cf = config.guardrails.contentFilter;
    const filter = createContentFilter({
      ...(cf.blocked !== undefined && { blocked: [...cf.blocked] }),
    });
    entries.push({
      name: filter.name,
      guard: filter.guard,
      direction: 'output',
    });
  }

  if (config.guardrails?.pii) {
    const piiConfig = typeof config.guardrails.pii === 'object' ? config.guardrails.pii : undefined;
    const detect = piiConfig?.types
      ? {
          email: piiConfig.types.includes('email'),
          phone: piiConfig.types.includes('phone'),
          ssn: piiConfig.types.includes('ssn'),
          creditCard: piiConfig.types.includes('creditCard'),
          apiKey: piiConfig.types.includes('apiKey'),
          ipAddress: piiConfig.types.includes('ipv4'),
          privateKey: piiConfig.types.includes('privateKey'),
        }
      : undefined;
    const detector = createPIIDetector(detect !== undefined ? { detect } : {});
    entries.push({
      name: detector.name,
      guard: detector.guard,
      direction: 'input',
    });
  }

  const input = entries
    .filter((g) => g.direction === 'input')
    .map((g) => ({ name: g.name, guard: g.guard }));
  const output = entries
    .filter((g) => g.direction === 'output')
    .map((g) => ({ name: g.name, guard: g.guard }));

  return createPipeline({ input, output });
}
