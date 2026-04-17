/**
 * Shared validation helpers used across `core` and `preset`.
 *
 * These helpers centralize the `Number.isInteger` / `Number.isFinite`
 * guards that were previously duplicated in `preset/build-harness/run.ts`
 * and `core/core/agent-loop-config.ts`. Centralisation:
 *
 * - Prevents the two validation sites from drifting (preset previously
 *   rejected fractional `maxIterations` but core's validator did not).
 * - Produces `HarnessError` instances with consistent code + suggestion
 *   text, so consumers can match on code without parsing messages.
 * - Lets new callers (e.g. the forthcoming `HarnessConfig` discriminated
 *   union) reuse the same rules.
 *
 * The helpers are intentionally tiny and throw-only: they return `void`,
 * mutating nothing, so they compose naturally in constructors.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';

/**
 * Require `value` to be a positive integer (>= 1). Accepts `undefined` so
 * callers can chain optional fields without pre-checking presence.
 *
 * Rejects fractional numbers, `NaN`, `Infinity`, zero, and negatives —
 * these have all shown up in real misconfiguration incidents.
 */
export function requirePositiveInt(
  value: number | undefined,
  fieldName: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new HarnessError(
      `${fieldName} must be a positive integer`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use an integer value >= 1',
    );
  }
}

/**
 * Require `value` to be a non-negative integer (>= 0). Same acceptance
 * semantics as {@link requirePositiveInt} but admits zero (e.g. for
 * "retries = 0 means no retry").
 */
export function requireNonNegativeInt(
  value: number | undefined,
  fieldName: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new HarnessError(
      `${fieldName} must be a non-negative integer`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use an integer value >= 0',
    );
  }
}

/**
 * Require `value` to be a finite, strictly positive number. Admits
 * fractions (e.g. for currency budgets) but rejects `NaN`, `Infinity`,
 * zero, and negatives.
 */
export function requireFinitePositive(
  value: number | undefined,
  fieldName: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new HarnessError(
      `${fieldName} must be a finite positive number`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use a value > 0',
    );
  }
}

/**
 * Require `value` to be a finite, non-negative number (>= 0). Admits
 * zero so callers can express "no delay" or "no cap". Rejects `NaN`,
 * `Infinity`, and negatives.
 */
export function requireFiniteNonNegative(
  value: number | undefined,
  fieldName: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new HarnessError(
      `${fieldName} must be a non-negative finite number`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use a value >= 0',
    );
  }
}

/**
 * Require `value` to be in `[0, 1]` (typical for jitter fractions,
 * sample rates, confidence scores). Admits undefined.
 */
export function requireUnitInterval(
  value: number | undefined,
  fieldName: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new HarnessError(
      `${fieldName} must be a finite number in [0, 1]`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Use a value between 0 and 1 inclusive',
    );
  }
}

/**
 * Canonical shape for per-model pricing: every numeric field must be
 * finite and non-negative. Used by {@link validatePricingEntry}; kept
 * separate from the full public `ModelPricing` interface so core's
 * validator can accept any structurally-compatible object.
 */
export interface PricingNumericFields {
  readonly model: string;
  readonly inputPer1kTokens: number;
  readonly outputPer1kTokens: number;
  readonly cacheReadPer1kTokens?: number;
  readonly cacheWritePer1kTokens?: number;
}

/**
 * Validate a single pricing entry. Throws `HarnessError` with a quoted
 * model name (so hostile identifiers cannot break the error string
 * shape) when any numeric field is `NaN`, `Infinity`, or negative.
 */
export function validatePricingEntry(p: PricingNumericFields): void {
  const invalid = (n: number): boolean => !Number.isFinite(n) || n < 0;
  if (
    invalid(p.inputPer1kTokens)
    || invalid(p.outputPer1kTokens)
    || (p.cacheReadPer1kTokens !== undefined && invalid(p.cacheReadPer1kTokens))
    || (p.cacheWritePer1kTokens !== undefined && invalid(p.cacheWritePer1kTokens))
  ) {
    throw new HarnessError(
      `Pricing for model \`${p.model}\` has non-finite or negative values`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'All pricing values must be finite numbers >= 0',
    );
  }
}

/**
 * Validate a pricing array: every entry must pass
 * {@link validatePricingEntry}. No-op on `undefined`.
 */
export function validatePricingArray(
  pricing: readonly PricingNumericFields[] | undefined,
): void {
  if (pricing === undefined) return;
  for (const entry of pricing) validatePricingEntry(entry);
}
