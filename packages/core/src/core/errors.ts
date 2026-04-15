/**
 * Error hierarchy for harness-one.
 *
 * Every error has a `.code` (programmatic) and optional `.suggestion` (actionable text).
 *
 * @module
 */

/**
 * Enumerated `HarnessError.code` values emitted by harness-one core.
 *
 * Wave-5C (T-1.3): converted from a string-literal union to a string enum.
 * Values are unchanged from the previous union (value-equivalence step per
 * Gap #3). PR-3 (T-3.2) will rename members to prefixed form (e.g.,
 * `UNKNOWN` → `CORE_UNKNOWN`); this PR only introduces the enum shape so
 * `Object.values(HarnessErrorCode)` becomes usable for runtime introspection
 * and consumers can migrate away from bare string literals.
 *
 * Subclass escape hatch (ADR §5.2): adapter subclasses that need to surface
 * vendor-specific codes should throw `HarnessError` with code
 * {@link HarnessErrorCode.ADAPTER_CUSTOM} and set
 * `details.adapterCode` to a string containing the vendor taxonomy.
 *
 * Back-compat note: `HarnessError.code` remains widened to
 * `HarnessErrorCode | (string & {})` in this PR so ecosystem throw sites
 * using bare literals outside this set (e.g., `'PROVIDER_ERROR'`,
 * `'NOT_FOUND'`) still compile. The type narrows to `HarnessErrorCode`
 * in PR-3 once the codemod has migrated those sites to enum members.
 */
export enum HarnessErrorCode {
  UNKNOWN = 'UNKNOWN',
  INVALID_CONFIG = 'INVALID_CONFIG',
  INVALID_STATE = 'INVALID_STATE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  CLI_PARSE_ERROR = 'CLI_PARSE_ERROR',
  MEMORY_CORRUPT = 'MEMORY_CORRUPT',
  STORE_CORRUPTION = 'STORE_CORRUPTION',
  MAX_ITERATIONS = 'MAX_ITERATIONS',
  ABORTED = 'ABORTED',
  GUARDRAIL_BLOCKED = 'GUARDRAIL_BLOCKED',
  GUARDRAIL_VIOLATION = 'GUARDRAIL_VIOLATION',
  INVALID_PIPELINE = 'INVALID_PIPELINE',
  ADAPTER_INVALID_EXTRA = 'ADAPTER_INVALID_EXTRA',
  ADAPTER_CUSTOM = 'ADAPTER_CUSTOM',
  TOOL_VALIDATION = 'TOOL_VALIDATION',
  INVALID_TOOL_SCHEMA = 'INVALID_TOOL_SCHEMA',
  TOOL_CAPABILITY_DENIED = 'TOOL_CAPABILITY_DENIED',
  TOKEN_BUDGET_EXCEEDED = 'TOKEN_BUDGET_EXCEEDED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_LIMIT = 'SESSION_LIMIT',
  SESSION_LOCKED = 'SESSION_LOCKED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  TRACE_NOT_FOUND = 'TRACE_NOT_FOUND',
  SPAN_NOT_FOUND = 'SPAN_NOT_FOUND',
  PROVIDER_REGISTRY_SEALED = 'PROVIDER_REGISTRY_SEALED',
}

/**
 * Optional structured details attached to a {@link HarnessError}.
 *
 * Adapter subclasses surfacing vendor codes should use the
 * {@link HarnessErrorCode.ADAPTER_CUSTOM} enum member together with
 * `adapterCode` so consumers can branch on provider taxonomies without
 * polluting the main {@link HarnessErrorCode} enum (ADR §5.2).
 */
export interface HarnessErrorDetails {
  /**
   * Vendor-specific code carried alongside {@link HarnessErrorCode.ADAPTER_CUSTOM}.
   * Open-ended by contract — third-party adapters publish their own taxonomies.
   */
  readonly adapterCode?: string;
  readonly [k: string]: unknown;
}

/**
 * Base error for all harness-one errors.
 *
 * @example
 * ```ts
 * throw new HarnessError('Something went wrong', HarnessErrorCode.UNKNOWN, 'Check your config');
 * ```
 */
export class HarnessError extends Error {
  public readonly details?: Readonly<HarnessErrorDetails>;

  constructor(
    message: string,
    // `code` accepts any string for forward compatibility (PR-1
    // value-equivalence step per Gap #3). The widened `(string & {})`
    // arm is removed in PR-3 once the ecosystem codemod has migrated
    // every throw site to a `HarnessErrorCode` enum member.
    public readonly code: HarnessErrorCode | (string & {}),
    public readonly suggestion?: string,
    public override readonly cause?: Error,
    details?: HarnessErrorDetails,
  ) {
    super(message);
    this.name = 'HarnessError';
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
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
      HarnessErrorCode.MAX_ITERATIONS,
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
      HarnessErrorCode.ABORTED,
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
      HarnessErrorCode.GUARDRAIL_BLOCKED,
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
      HarnessErrorCode.TOKEN_BUDGET_EXCEEDED,
      'Increase maxTotalTokens or reduce the conversation length',
      cause,
    );
    this.name = 'TokenBudgetExceededError';
  }
}
