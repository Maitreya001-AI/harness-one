/**
 * Shared config validation for the agent loop. Kept separate from
 * `agent-loop.ts` so the class constructor reads as an assembly sequence
 * rather than a block of HarnessError guards.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from './errors.js';
import {
  requireFiniteNonNegative,
  requireNonNegativeInt,
} from '../infra/validate.js';

/** Minimal shape that `validateAgentLoopConfig` inspects. */
export interface ResolvedAgentLoopLimits {
  readonly maxIterations: number;
  readonly maxTotalTokens: number;
  readonly maxDurationMs?: number;
  readonly maxStreamBytes: number;
  readonly maxToolArgBytes: number;
  readonly toolTimeoutMs?: number | undefined;
  readonly baseRetryDelayMs: number;
  readonly maxAdapterRetries: number;
}

/**
 * Validates the numeric limits resolved from an `AgentLoopConfig`. Throws a
 * `HarnessError(CORE_INVALID_CONFIG)` the first time any guard fails; never
 * returns a value, never mutates the input. The class constructor calls this
 * after assigning every property to `this`.
 *
 * Error messages for `maxIterations` / `maxTotalTokens` / `maxStreamBytes`
 * / `maxToolArgBytes` / `toolTimeoutMs` are kept verbatim because external
 * tests and docs reference them; delegating to `requirePositiveInt`
 * would change the wording. The remaining numeric guards route through
 * `core/infra/validate.ts` helpers so they stay in lockstep with
 * `preset/validate-config.ts`.
 */
export function validateAgentLoopConfig(limits: ResolvedAgentLoopLimits): void {
  if (limits.maxIterations < 1) {
    throw new HarnessError(
      'maxIterations must be >= 1',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxIterations value',
    );
  }
  if (limits.maxTotalTokens <= 0) {
    throw new HarnessError(
      'maxTotalTokens must be > 0',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxTotalTokens value',
    );
  }
  if (limits.maxDurationMs !== undefined && !Number.isFinite(limits.maxDurationMs)) {
    throw new HarnessError(
      'maxDurationMs must be a finite number',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a finite maxDurationMs value in milliseconds',
    );
  }
  if (limits.maxDurationMs !== undefined && limits.maxDurationMs <= 0) {
    throw new HarnessError(
      'maxDurationMs must be > 0',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxDurationMs value',
    );
  }
  if (limits.maxStreamBytes <= 0) {
    throw new HarnessError(
      'maxStreamBytes must be > 0',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxStreamBytes value',
    );
  }
  if (limits.maxToolArgBytes <= 0) {
    throw new HarnessError(
      'maxToolArgBytes must be > 0',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxToolArgBytes value',
    );
  }
  if (limits.toolTimeoutMs !== undefined && limits.toolTimeoutMs <= 0) {
    throw new HarnessError(
      'toolTimeoutMs must be > 0',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive toolTimeoutMs value',
    );
  }
  // These two now share the centralised helpers so the exact same
  // `Number.isFinite` / `Number.isInteger` predicate is applied everywhere.
  requireFiniteNonNegative(limits.baseRetryDelayMs, 'baseRetryDelayMs');
  requireNonNegativeInt(limits.maxAdapterRetries, 'maxAdapterRetries');
}
