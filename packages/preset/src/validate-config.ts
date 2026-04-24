/**
 * Unified configuration validation for harness preset.
 *
 * Both structural and numeric/provider validation live in this module so
 * adding a new config field touches a single file and error messages stay
 * consistent.
 *
 * `KNOWN_KEYS` is type-enforced against {@link HarnessConfigBase} +
 * {@link SecurePresetOptions} so adding a new top-level field surfaces a
 * TypeScript error here until the validator is updated — the "shape in
 * types.ts, allow-list in validate-config.ts" drift cannot happen silently.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import {
  requirePositiveInt,
  requireNonNegativeInt,
  requireFinitePositive,
  requireFiniteNonNegative,
  validatePricingArray,
} from 'harness-one/advanced';
import type { PricingNumericFields } from 'harness-one/advanced';
import type { HarnessConfigBase } from './build-harness/types.js';
import type { SecurePresetOptions } from './secure.js';

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

  // Warn about unrecognized top-level keys. The allow-list is typed against
  // the public config surfaces so adding a field to `HarnessConfigBase` /
  // `AnthropicHarnessConfig` / `OpenAIHarnessConfig` / `AdapterHarnessConfig` /
  // `SecurePresetOptions` — or renaming one — raises a TypeScript error here
  // until `KNOWN_KEYS` is updated in step.
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key as HarnessConfigKnownKey)) {
      throw new HarnessError(
        `Unknown config key: "${key}"`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        `Remove "${key}" from the config or check for typos. Known keys: ${[...KNOWN_KEYS].join(', ')}`,
      );
    }
  }
}

/**
 * Discriminator-tag keys from the provider-specific harness config variants.
 * These live on {@link AnthropicHarnessConfig} / {@link OpenAIHarnessConfig} /
 * {@link AdapterHarnessConfig} but not on `HarnessConfigBase`, so they need
 * to be spelled out for the `KNOWN_KEYS` allow-list.
 */
type DiscriminatorKey = 'type' | 'provider' | 'client' | 'adapter';

/** Every top-level key `createHarness` / `createSecurePreset` accept. */
type HarnessConfigKnownKey =
  | keyof HarnessConfigBase
  | DiscriminatorKey
  | keyof SecurePresetOptions;

const KNOWN_KEYS: ReadonlySet<HarnessConfigKnownKey> = new Set<HarnessConfigKnownKey>([
  // HarnessConfigBase — keep in sync with `build-harness/types.ts`.
  'model',
  'langfuse',
  'redis',
  'exporters',
  'memoryStore',
  'schemaValidator',
  'tokenizer',
  'maxIterations',
  'maxTotalTokens',
  'maxAdapterRetries',
  'baseRetryDelayMs',
  'retryableErrors',
  'adapterTimeoutMs',
  'guardrails',
  'budget',
  'pricing',
  'logger',
  // Provider-variant discriminators.
  'type',
  'provider',
  'client',
  'adapter',
  // SecurePresetOptions.
  'guardrailLevel',
  'skipProviderSeal',
]);

/**
 * Numeric + provider validation (formerly inlined in `build-harness/run.ts`).
 *
 * Runs the `require*` guards from `harness-one/core` so preset and core
 * agree on what counts as a positive integer / finite positive number, and
 * enforces the adapter/client XOR rule that the discriminated union
 * already blocks at compile time (belt-and-suspenders for dynamic callers).
 *
 * Input is an already structurally-validated `Record<string, unknown>` from
 * {@link validateHarnessConfig}; numeric fields are narrowed inline via
 * `readNumber` so we never reach for `as any`.
 */
export function validateHarnessRuntimeConfig(config: Record<string, unknown>): void {
  const hasAdapter = !!config.adapter;
  const hasClient = !!config.client;

  if (!hasAdapter && !hasClient) {
    throw new HarnessError(
      'Either adapter or client must be provided',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Pass a pre-built adapter or a provider client',
    );
  }
  if (hasAdapter && hasClient) {
    throw new HarnessError(
      'adapter and client are mutually exclusive',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Pass either a pre-built adapter OR a provider client, not both. '
      + 'Use AdapterHarnessConfig ({ adapter }) to inject a pre-built adapter; '
      + 'use AnthropicHarnessConfig/OpenAIHarnessConfig ({ provider, client }) '
      + 'to let harness-one build the adapter for you.',
    );
  }
  requirePositiveInt(readNumber(config.maxIterations), 'maxIterations');
  requirePositiveInt(readNumber(config.maxTotalTokens), 'maxTotalTokens');
  requireFinitePositive(readNumber(config.budget), 'budget');
  const rateLimit = readRateLimit(config.guardrails);
  if (rateLimit) {
    requirePositiveInt(rateLimit.max, 'guardrails.rateLimit.max');
    requirePositiveInt(rateLimit.windowMs, 'guardrails.rateLimit.windowMs');
  }
  validatePricingArray(config.pricing as readonly PricingNumericFields[] | undefined);
  requireNonNegativeInt(readNumber(config.maxAdapterRetries), 'maxAdapterRetries');
  requireFiniteNonNegative(readNumber(config.baseRetryDelayMs), 'baseRetryDelayMs');
}

/** Narrow `unknown` to `number | undefined`; non-numbers surface as-is so the
 *  downstream `require*` guard throws a structured error with the field name. */
function readNumber(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? v : (v as number);
}

/** Pull `{ max, windowMs }` out of a nested `guardrails.rateLimit` if present. */
function readRateLimit(
  guardrails: unknown,
): { max: number | undefined; windowMs: number | undefined } | undefined {
  if (!guardrails || typeof guardrails !== 'object') return undefined;
  const rl = (guardrails as { rateLimit?: unknown }).rateLimit;
  if (!rl || typeof rl !== 'object') return undefined;
  const { max, windowMs } = rl as { max?: unknown; windowMs?: unknown };
  return { max: readNumber(max), windowMs: readNumber(windowMs) };
}

/**
 * One-shot validator that runs structural (`validateHarnessConfig`) and
 * numeric (`validateHarnessRuntimeConfig`) checks in a single call. Prefer
 * this over invoking them separately so preset and secure-preset cannot
 * drift on validation order.
 */
export function validateHarnessConfigAll(config: Record<string, unknown>): void {
  validateHarnessConfig(config);
  validateHarnessRuntimeConfig(config);
}
