/**
 * Unified configuration validation for harness preset.
 *
 * Validates the full HarnessConfig object at construction time using
 * structural checks. Catches misconfigurations early with actionable errors
 * instead of allowing silent failures at runtime.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';

/** Known provider names that createHarness supports. */
const VALID_PROVIDERS = new Set(['anthropic', 'openai']);

/** Known guardrail sensitivity levels. */
const VALID_SENSITIVITIES = new Set(['low', 'medium', 'high']);

/** Known PII types. */
const VALID_PII_TYPES = new Set([
  'email', 'phone', 'ssn', 'creditCard', 'apiKey', 'ipv4', 'privateKey',
]);

/**
 * Validate the harness configuration object and throw `HarnessError` with
 * `CORE_INVALID_CONFIG` for any structural violations.
 *
 * This is intentionally NOT JSON Schema (AJV is an optional dependency).
 * The checks are minimal structural guards that catch typos and misconfiguration
 * without pulling in a heavy validation library.
 */
export function validateHarnessConfig(config: Record<string, unknown>): void {
  // Provider validation (when no adapter is injected).
  if (!config.adapter && config.provider !== undefined) {
    if (typeof config.provider !== 'string' || !VALID_PROVIDERS.has(config.provider)) {
      throw new HarnessError(
        `Invalid provider: ${String(config.provider)}. Expected one of: ${[...VALID_PROVIDERS].join(', ')}`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Use "anthropic" or "openai", or pass a pre-built adapter',
      );
    }
    if (!config.client) {
      throw new HarnessError(
        `Provider "${config.provider}" requires a client instance`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Pass the SDK client as config.client',
      );
    }
  }

  // Model validation.
  if (config.model !== undefined && typeof config.model !== 'string') {
    throw new HarnessError(
      'config.model must be a string',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Pass the model name as a string',
    );
  }

  // Guardrails sub-config validation.
  if (config.guardrails !== undefined && typeof config.guardrails === 'object' && config.guardrails !== null) {
    const g = config.guardrails as Record<string, unknown>;

    // Injection sensitivity validation.
    if (g.injection !== undefined && typeof g.injection === 'object' && g.injection !== null) {
      const sens = (g.injection as Record<string, unknown>).sensitivity;
      if (sens !== undefined && (typeof sens !== 'string' || !VALID_SENSITIVITIES.has(sens))) {
        throw new HarnessError(
          `Invalid injection sensitivity: ${String(sens)}. Expected: low, medium, high`,
          HarnessErrorCode.CORE_INVALID_CONFIG,
          'Use one of: low, medium, high',
        );
      }
    }

    // PII types validation.
    if (g.pii !== undefined && typeof g.pii === 'object' && g.pii !== null) {
      const types = (g.pii as Record<string, unknown>).types;
      if (types !== undefined) {
        if (!Array.isArray(types)) {
          throw new HarnessError(
            'guardrails.pii.types must be an array',
            HarnessErrorCode.CORE_INVALID_CONFIG,
            'Pass an array of PII type names',
          );
        }
        for (const t of types) {
          if (typeof t !== 'string' || !VALID_PII_TYPES.has(t)) {
            throw new HarnessError(
              `Invalid PII type: ${String(t)}. Expected one of: ${[...VALID_PII_TYPES].join(', ')}`,
              HarnessErrorCode.CORE_INVALID_CONFIG,
              'Check the supported PII types',
            );
          }
        }
      }
    }
  }

  // Tokenizer validation.
  if (config.tokenizer !== undefined) {
    const t = config.tokenizer;
    if (t !== 'tiktoken' && typeof t !== 'function' && !(typeof t === 'object' && t !== null && 'encode' in t)) {
      throw new HarnessError(
        'config.tokenizer must be "tiktoken", a function, or an object with .encode()',
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Pass "tiktoken" for the built-in tokenizer, or a custom tokenizer function/object',
      );
    }
  }

  // Warn about unrecognized top-level keys.
  const KNOWN_KEYS = new Set([
    'provider', 'client', 'model', 'adapter', 'langfuse', 'redis',
    'exporters', 'memoryStore', 'schemaValidator', 'tokenizer',
    'maxIterations', 'maxTotalTokens', 'guardrails', 'budget', 'pricing',
    'logger',
    // SecurePresetOptions
    'guardrailLevel', 'skipProviderSeal',
  ]);
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new HarnessError(
        `Unknown config key: "${key}"`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        `Remove "${key}" from the config or check for typos. Known keys: ${[...KNOWN_KEYS].join(', ')}`,
      );
    }
  }
}
