/**
 * Error hierarchy for harness-one.
 *
 * Wave-15: `HarnessError` + `HarnessErrorCode` were moved down to L1
 * (`infra/errors-base.ts`) so infra modules can throw without importing
 * upward. This module re-exports the base primitives and layers L2
 * subclasses (`MaxIterationsError`, `AbortedError`, …) on top.
 *
 * @module
 */

export {
  HarnessError,
  HarnessErrorCode,
  createCustomErrorCode,
} from '../infra/errors-base.js';
export type { HarnessErrorDetails } from '../infra/errors-base.js';

import { HarnessError, HarnessErrorCode } from '../infra/errors-base.js';

/**
 * Thrown when the agent loop exceeds maxIterations.
 *
 * @example
 * ```ts
 * throw new MaxIterationsError(25);
 * ```
 */
export class MaxIterationsError extends HarnessError {
  constructor(
    public readonly iterations: number,
    cause?: Error,
  ) {
    super(
      `Agent loop exceeded maximum iterations (${iterations})`,
      HarnessErrorCode.CORE_MAX_ITERATIONS,
      'Increase maxIterations or simplify the task',
      cause,
    );
    this.name = 'MaxIterationsError';
  }
}

/**
 * Thrown when the agent loop is aborted.
 *
 * @example
 * ```ts
 * throw new AbortedError();
 * ```
 */
export class AbortedError extends HarnessError {
  constructor(cause?: Error) {
    super(
      'Agent loop was aborted',
      HarnessErrorCode.CORE_ABORTED,
      'Check if the abort was intentional',
      cause,
    );
    this.name = 'AbortedError';
  }
}

/**
 * Thrown when a guardrail blocks execution.
 *
 * @deprecated Wave-14: throw `new HarnessError(reason, HarnessErrorCode.GUARD_VIOLATION, ...)`
 *   directly instead. The runtime guardrail pipeline (see
 *   `core/guardrail-runner.ts`) now throws the typed `HarnessError` form;
 *   this class remains exported for back-compat with consumer `instanceof`
 *   checks and will be removed in v2.0. See MIGRATION.md for details.
 *
 * @example
 * ```ts
 * throw new GuardrailBlockedError('Content policy violation');
 * ```
 */
export class GuardrailBlockedError extends HarnessError {
  constructor(reason: string, cause?: Error) {
    super(
      `Guardrail blocked: ${reason}`,
      HarnessErrorCode.GUARD_BLOCKED,
      'Review the guardrail configuration and input',
      cause,
    );
    this.name = 'GuardrailBlockedError';
  }
}

/**
 * Thrown when tool call validation fails.
 *
 * @example
 * ```ts
 * throw new ToolValidationError('Invalid parameters');
 * ```
 */
export class ToolValidationError extends HarnessError {
  constructor(message: string, cause?: Error) {
    super(
      message,
      HarnessErrorCode.TOOL_VALIDATION,
      'Check the tool parameters against the schema',
      cause,
    );
    this.name = 'ToolValidationError';
  }
}

/**
 * Thrown when cumulative token budget is exceeded.
 *
 * @example
 * ```ts
 * throw new TokenBudgetExceededError(50000, 100000);
 * ```
 */
export class TokenBudgetExceededError extends HarnessError {
  constructor(
    public readonly used: number,
    public readonly budget: number,
    cause?: Error,
  ) {
    super(
      `Token budget exceeded: used ${used} of ${budget}`,
      HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
      'Increase maxTotalTokens or reduce the conversation length',
      cause,
    );
    this.name = 'TokenBudgetExceededError';
  }
}
