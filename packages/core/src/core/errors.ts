/**
 * Error hierarchy for harness-one.
 *
 * Every error has a `.code` (programmatic) and optional `.suggestion` (actionable text).
 *
 * @module
 */

/**
 * Documented `HarnessError.code` values. Not an exhaustive closed enum —
 * `HarnessError.code` is typed as `string` to preserve ABI stability for
 * third-party subclasses — but consumers doing `switch (err.code)` against
 * this union get IDE autocomplete and an up-to-date list of the codes the
 * library itself emits.
 *
 * Recently added (Wave 4d):
 * - `INTERNAL_ERROR` — unreachable / invariant-violation sites.
 * - `CLI_PARSE_ERROR` — malformed CLI invocations.
 * - `MEMORY_CORRUPT` — persisted memory blobs failed runtime shape validation.
 */
export type HarnessErrorCode =
  | 'UNKNOWN'
  | 'INVALID_CONFIG'
  | 'INVALID_STATE'
  | 'INTERNAL_ERROR'
  | 'CLI_PARSE_ERROR'
  | 'MEMORY_CORRUPT'
  | 'STORE_CORRUPTION'
  | 'MAX_ITERATIONS'
  | 'ABORTED'
  | 'GUARDRAIL_BLOCKED'
  | 'INVALID_PIPELINE'
  | 'TOOL_VALIDATION'
  | 'INVALID_TOOL_SCHEMA'
  | 'TOKEN_BUDGET_EXCEEDED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_LIMIT'
  | 'SESSION_LOCKED'
  | 'SESSION_EXPIRED'
  | 'TRACE_NOT_FOUND'
  | 'SPAN_NOT_FOUND';

/**
 * Base error for all harness-one errors.
 *
 * @example
 * ```ts
 * throw new HarnessError('Something went wrong', 'UNKNOWN', 'Check your config');
 * ```
 */
export class HarnessError extends Error {
  constructor(
    message: string,
    // `code` accepts any string for forward compatibility, but callers are
    // encouraged to use values from {@link HarnessErrorCode}. New codes added
    // in this audit: INTERNAL_ERROR, CLI_PARSE_ERROR, MEMORY_CORRUPT.
    public readonly code: HarnessErrorCode | (string & {}),
    public readonly suggestion?: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}

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
      'MAX_ITERATIONS',
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
      'ABORTED',
      'Check if the abort was intentional',
      cause,
    );
    this.name = 'AbortedError';
  }
}

/**
 * Thrown when a guardrail blocks execution.
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
      'GUARDRAIL_BLOCKED',
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
      'TOOL_VALIDATION',
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
      'TOKEN_BUDGET_EXCEEDED',
      'Increase maxTotalTokens or reduce the conversation length',
      cause,
    );
    this.name = 'TokenBudgetExceededError';
  }
}
