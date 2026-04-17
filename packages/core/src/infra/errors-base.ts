/**
 * Error primitives — the base `HarnessError` class and the full
 * `HarnessErrorCode` enum live in the L1 infra layer so L1 is truly
 * dependency-free (infra no longer imports from `core/errors`). L2/L3
 * subclasses (`MaxIterationsError`, `AbortedError`, …) live in
 * `core/core/errors.ts` and augment this module.
 *
 * Wave-15 refactor: prior to this wave infra imported `HarnessError`
 * and `HarnessErrorCode` from `../core/errors.js`, which violated the
 * documented "L1 imports from nothing" rule. Moving the primitives
 * down makes that rule enforceable by eslint without a carve-out.
 *
 * For extensibility (registering subsystem-specific error codes
 * without mutating the enum) see {@link createCustomErrorCode}.
 *
 * @module
 */

/**
 * Closed namespaced error-code enumeration for harness-one core and
 * ecosystem packages.
 *
 * String enum: values are human-readable strings equal to their member
 * names, so `JSON.stringify({ code })` remains self-describing and
 * `Object.values(HarnessErrorCode)` yields the introspectable list at
 * runtime for analytics / lint-rule generation.
 *
 * IMPORTANT: import as a VALUE (`import { HarnessErrorCode }`).
 * `import type { HarnessErrorCode }` silently drops the runtime object —
 * flagged by the `harness-one/no-type-only-harness-error-code` ESLint rule.
 *
 * Extension hook: call {@link createCustomErrorCode} to mint a namespaced
 * custom code when a subsystem needs a value the enum does not provide —
 * the code becomes `<namespace>:<member>` and rides on the
 * `HarnessErrorCode.ADAPTER_CUSTOM` branch of the enum for
 * switch-exhaustiveness purposes. `details.namespace` carries the parsed
 * namespace for downstream tooling.
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
  MEMORY_NOT_FOUND = 'MEMORY_NOT_FOUND',
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
  ADAPTER_UNAVAILABLE = 'ADAPTER_UNAVAILABLE',
  ADAPTER_CIRCUIT_OPEN = 'ADAPTER_CIRCUIT_OPEN',
  ADAPTER_PAYLOAD_OVERSIZED = 'ADAPTER_PAYLOAD_OVERSIZED',
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
  ORCH_DELEGATION_LIMIT = 'ORCH_DELEGATION_LIMIT',
  ORCH_CONTEXT_LIMIT = 'ORCH_CONTEXT_LIMIT',

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
 * {@link HarnessErrorCode} enum.
 *
 * Wave-15 adds `namespace` as the canonical container for custom codes
 * registered via {@link createCustomErrorCode} — it parallels `adapterCode`
 * but is subsystem-shaped rather than adapter-shaped.
 */
export interface HarnessErrorDetails {
  readonly adapterCode?: string;
  readonly namespace?: string;
  readonly customCode?: string;
  readonly [k: string]: unknown;
}

/**
 * Base error for all harness-one errors.
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
 * Mint a namespaced custom error code. The resulting object carries the
 * canonical `HarnessErrorCode.ADAPTER_CUSTOM` code (so consumers can
 * switch-exhaust the enum) plus the namespace+customCode tuple that
 * identifies the specific failure mode for observability tools.
 *
 * @param namespace — subsystem or package name (e.g. `'prompt'`, `'@harness-one/redis'`)
 * @param code — short machine-readable identifier (e.g. `'TEMPLATE_NOT_FOUND'`)
 * @example
 * ```ts
 * throw new HarnessError('No active skill', HarnessErrorCode.ADAPTER_CUSTOM,
 *   undefined, undefined, createCustomErrorCode('prompt', 'NO_ACTIVE_SKILL'));
 * ```
 */
export function createCustomErrorCode(
  namespace: string,
  code: string,
): Readonly<HarnessErrorDetails> {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new HarnessError(
      'namespace must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Pass a stable namespace like "prompt" or "@harness-one/redis".',
    );
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new HarnessError(
      'code must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_INPUT,
      'Pass a short identifier like "TEMPLATE_NOT_FOUND".',
    );
  }
  return Object.freeze({
    namespace,
    customCode: code,
  });
}
