/**
 * PII (Personally Identifiable Information) detection guardrail.
 *
 * @module
 */

import type { Guardrail, GuardrailContext } from './types.js';
import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import { isReDoSCandidate } from './content-filter.js';

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
// Email: reject consecutive dots in local part and domain.
// Uses a base regex for structure, with a post-match validation to reject '..' sequences.
const EMAIL_RE = /[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}/;
// Phone: require at least one separator (-, ., or space) between groups to reduce false positives
const PHONE_RE = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
// SSN: dashed (123-45-6789), no-dashes (123456789), space-separated (123 45 6789)
const SSN_RE = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const CREDIT_CARD_RE = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/;
// IPv4 with proper 0-255 range validation per octet
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/;
// API keys: OpenAI sk-*, AWS AKIA*, GitHub ghp_/gho_/github_pat_, Stripe sk_live_/sk_test_, Google AIza
// Requires key-like context: preceded by =, :, ", or whitespace/start-of-string to reduce false positives from discussion text
const API_KEY_RE = /(?:^|[=:"'\s])(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{22,}|sk_live_[a-zA-Z0-9]{24,}|sk_test_[a-zA-Z0-9]{24,}|AIza[a-zA-Z0-9_-]{35})\b/;
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

  // Build the list of active detectors, ordered by frequency of occurrence
  // in typical content (email > phone > API key > credit card > SSN > IP > private key).
  // This ensures the most common PII types are checked first for early exit.
  const detectors: Array<{ name: string; pattern: RegExp; validate?: (match: string) => boolean }> = [];

  if (detect.email !== false) {
    detectors.push({
      name: 'email',
      pattern: EMAIL_RE,
      // Reject emails with consecutive dots in local part or domain
      validate: (match: string) => !match.includes('..'),
    });
  }
  if (detect.phone !== false) {
    detectors.push({ name: 'phone', pattern: PHONE_RE });
  }
  if (detect.apiKey === true) {
    detectors.push({ name: 'API key', pattern: API_KEY_RE });
  }
  if (detect.creditCard !== false) {
    detectors.push({ name: 'credit card', pattern: CREDIT_CARD_RE, validate: (match: string) => luhnCheck(match.replace(/[-\s]/g, '')) });
  }
  if (detect.ssn !== false) {
    detectors.push({ name: 'SSN', pattern: SSN_RE });
  }
  if (detect.ipAddress === true) {
    detectors.push({ name: 'IP address', pattern: IPV4_RE });
  }
  if (detect.privateKey === true) {
    detectors.push({ name: 'private key', pattern: PEM_PRIVATE_KEY_RE });
  }

  for (const custom of customPatterns) {
    // Validate custom patterns against ReDoS to prevent user-supplied
    // regexes from causing catastrophic backtracking.
    if (isReDoSCandidate(custom.pattern.source)) {
      throw new HarnessError(
        `Custom PII pattern "${custom.name}" is potentially vulnerable to ReDoS`,
        HarnessErrorCode.CORE_REDOS_PATTERN,
        'Simplify the regex to avoid nested quantifiers or overlapping alternations',
      );
    }
    detectors.push({ name: custom.name, pattern: custom.pattern });
  }

  const guard: Guardrail = (ctx: GuardrailContext) => {
    // Fast-path preflight: if the content has no digits, skip all numeric-
    // based detectors (phone, SSN, credit card, IP, API key prefixes with
    // digits). For short alpha-only content this slashes per-message work
    // from N regexes to 0.
    const hasDigit = /\d/.test(ctx.content);
    const hasAt = ctx.content.indexOf('@') >= 0;

    for (const detector of detectors) {
      // Detector-level preflights — cheap single-char checks that rule out
      // entire classes of PII without running the full regex.
      if (!hasDigit && /phone|SSN|credit card|IP address/.test(detector.name)) continue;
      if (!hasAt && detector.name === 'email') continue;

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
