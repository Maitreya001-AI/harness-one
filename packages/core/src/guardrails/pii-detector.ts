/**
 * PII (Personally Identifiable Information) detection guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';

/** Configuration for which PII types to detect. */
interface PIIDetectConfig {
  email?: boolean;
  phone?: boolean;
  ssn?: boolean;
  creditCard?: boolean;
}

/** A custom PII pattern with a name for identification. */
interface CustomPIIPattern {
  name: string;
  pattern: RegExp;
}

// Built-in PII patterns
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const CREDIT_CARD_RE = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/;

/**
 * Create a PII detector guardrail.
 *
 * @example
 * ```ts
 * const detector = createPIIDetector();
 * const result = detector.guard({ content: 'Email me at user@example.com' });
 * // { action: 'block', reason: 'PII detected: email' }
 * ```
 */
export function createPIIDetector(config?: {
  detect?: PIIDetectConfig;
  customPatterns?: CustomPIIPattern[];
}): { name: string; guard: Guardrail } {
  const detect = config?.detect ?? {
    email: true,
    phone: true,
    ssn: true,
    creditCard: true,
  };
  const customPatterns = config?.customPatterns ?? [];

  // Build the list of active detectors
  const detectors: Array<{ name: string; pattern: RegExp }> = [];

  if (detect.email !== false) {
    detectors.push({ name: 'email', pattern: EMAIL_RE });
  }
  if (detect.phone !== false) {
    detectors.push({ name: 'phone', pattern: PHONE_RE });
  }
  if (detect.ssn !== false) {
    detectors.push({ name: 'SSN', pattern: SSN_RE });
  }
  if (detect.creditCard !== false) {
    detectors.push({ name: 'credit card', pattern: CREDIT_CARD_RE });
  }

  for (const custom of customPatterns) {
    detectors.push({ name: custom.name, pattern: custom.pattern });
  }

  const guard: Guardrail = (ctx: GuardrailContext) => {
    for (const detector of detectors) {
      if (detector.pattern.test(ctx.content)) {
        return {
          action: 'block',
          reason: `PII detected: ${detector.name}`,
        };
      }
    }
    return { action: 'allow' };
  };

  return { name: 'pii-detector', guard };
}
