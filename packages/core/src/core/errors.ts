/**
 * Error hierarchy for harness-one.
 *
 * Every error has a `.code` (programmatic) and optional `.suggestion` (actionable text).
 *
 * @module
 */

/**
 * Closed namespaced error-code enumeration for harness-one core and
 * ecosystem packages.
 *
 * Wave-5C PR-3 (T-3.2): renamed ADR-locked members to module-prefixed form
 * (`UNKNOWN` → `CORE_UNKNOWN`, `MAX_ITERATIONS` → `CORE_MAX_ITERATIONS`, etc.),
 * extended with previously ecosystem-only bare-literal codes under the same
 * taxonomy (`POOL_*`, `ORCH_*`, `LOCK_*`, `PROMPT_*`, `RAG_*`, `EVAL_*`,
 * `EVOLVE_*`, `CONTEXT_*`), and **closed** the type — the `(string & {})`
 * widening on `HarnessError.code` is removed.
 *
 * String enum: values are human-readable strings equal to their member
 * names, so `JSON.stringify({ code })` remains self-describing and
 * `Object.values(HarnessErrorCode)` yields the introspectable list at
 * runtime for analytics / lint-rule generation.
 *
 * IMPORTANT: import as a VALUE (`import { HarnessErrorCode }`).
 * `import type { HarnessErrorCode }` silently drops the runtime object —
 * flagged by the `harness-one/no-type-only-harness-error-code` ESLint rule
 * (Wave-5C.1 enforcement).
 *
 * Adapter escape hatch (ADR §5.2 + §6): third-party adapter subclasses
 * (`@harness-one/openai`, `@harness-one/anthropic`, etc.) throw with
 * {@link HarnessErrorCode.ADAPTER_CUSTOM} and populate `details.adapterCode`
 * with a vendor-specific code string. Adapter sub-codes are by-contract OPEN
 * — adapter packages publish their own taxonomy in their READMEs. Core's
 * enum closure is what matters for switch-exhaustiveness in consumer code.
 *
 * @see wave-5c-adr.md §6 for the locked taxonomy
 */
export enum HarnessErrorCode {
  // ── CORE_* — runtime invariants + loop exits ─────────────────────────────
  CORE_UNKNOWN = 'CORE_UNKNOWN',
  CORE_INVALID_CONFIG = 'CORE_INVALID_CONFIG',
  CORE_INVALID_STATE = 'CORE_INVALID_STATE',
  CORE_INVALID_INPUT = 'CORE_INVALID_INPUT',
  CORE_INVALID_ID = 'CORE_INVALID_ID',
  CORE_INVALID_KEY = 'CORE_INVALID_KEY',
  CORE_INVALID_PATTERN = 'CORE_INVALID_PATTERN',
  CORE_INVALID_BUDGET = 'CORE_INVALID_BUDGET',
  CORE_INTERNAL_ERROR = 'CORE_INTERNAL_ERROR',
  CORE_MAX_ITERATIONS = 'CORE_MAX_ITERATIONS',
  CORE_ABORTED = 'CORE_ABORTED',
  /** Generic timeout — used by `withAbortableTimeout` and similar utilities. */
  CORE_TIMEOUT = 'CORE_TIMEOUT',
  CORE_TOKEN_BUDGET_EXCEEDED = 'CORE_TOKEN_BUDGET_EXCEEDED',
  CORE_UNEXPECTED_VALUE = 'CORE_UNEXPECTED_VALUE',
  CORE_UNSUPPORTED_OPERATION = 'CORE_UNSUPPORTED_OPERATION',
  CORE_REDOS_PATTERN = 'CORE_REDOS_PATTERN',
  CORE_MIDDLEWARE_ERROR = 'CORE_MIDDLEWARE_ERROR',
  CORE_FALLBACK_EXHAUSTED = 'CORE_FALLBACK_EXHAUSTED',
  CORE_STREAM_NOT_SUPPORTED = 'CORE_STREAM_NOT_SUPPORTED',
  CORE_PARSE_EMPTY_INPUT = 'CORE_PARSE_EMPTY_INPUT',
  CORE_PARSE_EMPTY_CODEBLOCK = 'CORE_PARSE_EMPTY_CODEBLOCK',
  CORE_PARSE_UNCLOSED_CODEBLOCK = 'CORE_PARSE_UNCLOSED_CODEBLOCK',
  CORE_PARSE_INVALID_JSON = 'CORE_PARSE_INVALID_JSON',

  // ── TOOL_* ───────────────────────────────────────────────────────────────
  TOOL_VALIDATION = 'TOOL_VALIDATION',
  TOOL_INVALID_SCHEMA = 'TOOL_INVALID_SCHEMA',
  TOOL_INVALID_NAME = 'TOOL_INVALID_NAME',
  TOOL_CAPABILITY_DENIED = 'TOOL_CAPABILITY_DENIED',
  TOOL_DUPLICATE = 'TOOL_DUPLICATE',

  // ── GUARD_* ──────────────────────────────────────────────────────────────
  GUARD_BLOCKED = 'GUARD_BLOCKED',
  GUARD_VIOLATION = 'GUARD_VIOLATION',
  GUARD_INVALID_PIPELINE = 'GUARD_INVALID_PIPELINE',
  GUARD_SELF_HEALING_ABORTED = 'GUARD_SELF_HEALING_ABORTED',

  // ── SESSION_* ────────────────────────────────────────────────────────────
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_LIMIT = 'SESSION_LIMIT',
  SESSION_LOCKED = 'SESSION_LOCKED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  // ── MEMORY_* ─────────────────────────────────────────────────────────────
  MEMORY_CORRUPT = 'MEMORY_CORRUPT',
  MEMORY_STORE_CORRUPTION = 'MEMORY_STORE_CORRUPTION',
  MEMORY_NOT_FOUND = 'MEMORY_NOT_FOUND',
  MEMORY_DATA_CORRUPTION = 'MEMORY_DATA_CORRUPTION',
  MEMORY_RELAY_CONFLICT = 'MEMORY_RELAY_CONFLICT',

  // ── TRACE_* ──────────────────────────────────────────────────────────────
  TRACE_NOT_FOUND = 'TRACE_NOT_FOUND',
  TRACE_SPAN_NOT_FOUND = 'TRACE_SPAN_NOT_FOUND',

  // ── CLI_* ────────────────────────────────────────────────────────────────
  CLI_PARSE_ERROR = 'CLI_PARSE_ERROR',

  // ── ADAPTER_* (escape hatch lives here) ──────────────────────────────────
  ADAPTER_INVALID_EXTRA = 'ADAPTER_INVALID_EXTRA',
  ADAPTER_UNKNOWN = 'ADAPTER_UNKNOWN',
  ADAPTER_ERROR = 'ADAPTER_ERROR',
  ADAPTER_AUTH = 'ADAPTER_AUTH',
  ADAPTER_NETWORK = 'ADAPTER_NETWORK',
  ADAPTER_PARSE = 'ADAPTER_PARSE',
  ADAPTER_RATE_LIMIT = 'ADAPTER_RATE_LIMIT',
  /**
   * Adapter upstream is temporarily unavailable — HTTP 502/503/504, "bad
   * gateway", "service unavailable", "gateway timeout". Canonical "back off
   * and retry" signal; included in default retry allow-lists.
   */
  ADAPTER_UNAVAILABLE = 'ADAPTER_UNAVAILABLE',
  /** Circuit breaker is OPEN — fast-failing to prevent cascade failures. */
  ADAPTER_CIRCUIT_OPEN = 'ADAPTER_CIRCUIT_OPEN',
  /**
   * Escape mechanism: third-party adapter subclasses (`@harness-one/openai`,
   * `@harness-one/anthropic`, etc.) throw with `code = ADAPTER_CUSTOM` and
   * populate `details.adapterCode: string` with their own sub-code.
   * Adapter sub-codes are by-contract OPEN — adapter packages document their
   * taxonomy in their own READMEs. Core's union closure is what matters for
   * switch-exhaustiveness in consumer code.
   */
  ADAPTER_CUSTOM = 'ADAPTER_CUSTOM',

  // ── PROVIDER_* ───────────────────────────────────────────────────────────
  PROVIDER_REGISTRY_SEALED = 'PROVIDER_REGISTRY_SEALED',

  // ── POOL_* — agent-pool orchestration ────────────────────────────────────
  POOL_DISPOSED = 'POOL_DISPOSED',
  POOL_EXHAUSTED = 'POOL_EXHAUSTED',
  POOL_ABORTED = 'POOL_ABORTED',
  POOL_TIMEOUT = 'POOL_TIMEOUT',
  POOL_QUEUE_FULL = 'POOL_QUEUE_FULL',

  // ── ORCH_* — orchestrator / queue / handoff / boundary ──────────────────
  ORCH_QUEUE_FULL = 'ORCH_QUEUE_FULL',
  ORCH_AGENT_NOT_FOUND = 'ORCH_AGENT_NOT_FOUND',
  ORCH_DUPLICATE_AGENT = 'ORCH_DUPLICATE_AGENT',
  ORCH_MAX_AGENTS = 'ORCH_MAX_AGENTS',
  ORCH_DELEGATION_CYCLE = 'ORCH_DELEGATION_CYCLE',
  ORCH_INVALID_TRANSITION = 'ORCH_INVALID_TRANSITION',
  ORCH_INVALID_TRANSITION_TARGET = 'ORCH_INVALID_TRANSITION_TARGET',
  ORCH_HANDOFF_SERIALIZATION_ERROR = 'ORCH_HANDOFF_SERIALIZATION_ERROR',
  ORCH_BOUNDARY_READ_DENIED = 'ORCH_BOUNDARY_READ_DENIED',
  ORCH_BOUNDARY_WRITE_DENIED = 'ORCH_BOUNDARY_WRITE_DENIED',
  ORCH_STAGE_NOT_FOUND = 'ORCH_STAGE_NOT_FOUND',
  ORCH_TOPIC_NOT_FOUND = 'ORCH_TOPIC_NOT_FOUND',
  ORCH_UNKNOWN_STRATEGY = 'ORCH_UNKNOWN_STRATEGY',

  // ── LOCK_* — async-lock primitives ──────────────────────────────────────
  LOCK_ABORTED = 'LOCK_ABORTED',

  // ── PROMPT_* — prompt/skill engine ──────────────────────────────────────
  PROMPT_NO_ACTIVE_SKILL = 'PROMPT_NO_ACTIVE_SKILL',
  PROMPT_SKILL_NOT_FOUND = 'PROMPT_SKILL_NOT_FOUND',
  PROMPT_TEMPLATE_NOT_FOUND = 'PROMPT_TEMPLATE_NOT_FOUND',
  PROMPT_MISSING_VARIABLE = 'PROMPT_MISSING_VARIABLE',

  // ── CONTEXT_* — context-pack / checkpoint / compress ────────────────────
  CONTEXT_CHECKPOINT_NOT_FOUND = 'CONTEXT_CHECKPOINT_NOT_FOUND',
  CONTEXT_SEGMENT_OVERFLOW = 'CONTEXT_SEGMENT_OVERFLOW',
  CONTEXT_UNKNOWN_SEGMENT = 'CONTEXT_UNKNOWN_SEGMENT',
  CONTEXT_MISSING_SUMMARIZER = 'CONTEXT_MISSING_SUMMARIZER',

  // ── RAG_* — retrieval-augmented generation ──────────────────────────────
  RAG_INVALID_CONFIG = 'RAG_INVALID_CONFIG',
  RAG_NO_LOADER = 'RAG_NO_LOADER',
  RAG_QUERY_TOO_LONG = 'RAG_QUERY_TOO_LONG',
  RAG_EMBEDDING_MISMATCH = 'RAG_EMBEDDING_MISMATCH',
  RAG_EMBEDDING_VALIDATION = 'RAG_EMBEDDING_VALIDATION',

  // ── EVAL_* — devkit eval runner ─────────────────────────────────────────
  EVAL_CONFIG = 'EVAL_CONFIG',
  EVAL_EMPTY = 'EVAL_EMPTY',
  EVAL_SCORER_MISMATCH = 'EVAL_SCORER_MISMATCH',

  // ── EVOLVE_* — devkit architecture-checker + drift + taste ──────────────
  EVOLVE_NO_BASELINE = 'EVOLVE_NO_BASELINE',
  EVOLVE_COMPONENT_DUPLICATE = 'EVOLVE_COMPONENT_DUPLICATE',
  EVOLVE_COMPONENT_NOT_FOUND = 'EVOLVE_COMPONENT_NOT_FOUND',
  EVOLVE_TASTE_DUPLICATE = 'EVOLVE_TASTE_DUPLICATE',
  EVOLVE_TASTE_NOT_FOUND = 'EVOLVE_TASTE_NOT_FOUND',
}

/**
 * Optional structured details attached to a {@link HarnessError}.
 *
 * Adapter subclasses surfacing vendor codes should use
 * {@link HarnessErrorCode.ADAPTER_CUSTOM} together with `adapterCode` so
 * consumers can branch on provider taxonomies without polluting the main
 * {@link HarnessErrorCode} enum (ADR §5.2).
 */
export interface HarnessErrorDetails {
  /**
   * Vendor-specific code carried alongside
   * {@link HarnessErrorCode.ADAPTER_CUSTOM}. Open-ended by contract —
   * third-party adapters publish their own taxonomies.
   */
  readonly adapterCode?: string;
  readonly [k: string]: unknown;
}

/**
 * Base error for all harness-one errors.
 *
 * Wave-5C PR-3 (T-3.2) removes the `(string & {})` widening on `code`.
 * All throw sites must use a {@link HarnessErrorCode} enum member.
 * Vendor-specific adapter codes ride on
 * {@link HarnessErrorCode.ADAPTER_CUSTOM} + `details.adapterCode`.
 *
 * @example
 * ```ts
 * throw new HarnessError('Something went wrong', HarnessErrorCode.CORE_UNKNOWN, 'Check your config');
 * ```
 */
export class HarnessError extends Error {
  public readonly details?: Readonly<HarnessErrorDetails>;

  constructor(
    message: string,
    public readonly code: HarnessErrorCode,
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
