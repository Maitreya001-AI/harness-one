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
  /** Detect IPv4 addresses. Default: false (opt-in to avoid false positives). */
  ipAddress?: boolean;
  /** Detect API keys (OpenAI sk-*, AWS AKIA*, GitHub ghp_/gho_/github_pat_, Stripe sk_live_/sk_test_, Google AIza). Default: false (opt-in to avoid false positives). */
  apiKey?: boolean;
  /** Detect PEM private key headers. Default: false (opt-in to avoid false positives). */
  privateKey?: boolean;
}

/** A custom PII pattern with a name for identification. */
interface CustomPIIPattern {
  name: string;
  pattern: RegExp;
}

// Built-in PII patterns
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/;
// SSN: dashed (123-45-6789), no-dashes (123456789), space-separated (123 45 6789)
const SSN_RE = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const CREDIT_CARD_RE = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/;
// IPv4 with proper 0-255 range validation per octet
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/;
// API keys: OpenAI sk-*, AWS AKIA*, GitHub ghp_/gho_/github_pat_, Stripe sk_live_/sk_test_, Google AIza
const API_KEY_RE = /\b(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{22,}|sk_live_[a-zA-Z0-9]{24,}|sk_test_[a-zA-Z0-9]{24,}|AIza[a-zA-Z0-9_-]{35})\b/;
const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/;

/**
 * Luhn algorithm validation for credit card numbers.
 * Returns true if the digit string passes the Luhn checksum.
 */
function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

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
  const detectors: Array<{ name: string; pattern: RegExp; validate?: (match: string) => boolean }> = [];

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
    detectors.push({ name: 'credit card', pattern: CREDIT_CARD_RE, validate: (match: string) => luhnCheck(match.replace(/[-\s]/g, '')) });
  }
  if (detect.ipAddress === true) {
    detectors.push({ name: 'IP address', pattern: IPV4_RE });
  }
  if (detect.apiKey === true) {
    detectors.push({ name: 'API key', pattern: API_KEY_RE });
  }
  if (detect.privateKey === true) {
    detectors.push({ name: 'private key', pattern: PEM_PRIVATE_KEY_RE });
  }

  for (const custom of customPatterns) {
    detectors.push({ name: custom.name, pattern: custom.pattern });
  }

  const guard: Guardrail = (ctx: GuardrailContext) => {
    for (const detector of detectors) {
      const match = ctx.content.match(detector.pattern);
      if (match) {
        // If a validate function is provided, check the match
        if (detector.validate && !detector.validate(match[0])) {
          continue;
        }
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
