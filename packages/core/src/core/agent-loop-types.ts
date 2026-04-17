/**
 * Public configuration + hook contracts for {@link AgentLoop}. Kept separate
 * from `agent-loop.ts` so the runtime implementation can focus on state
 * management and the types can be consumed without pulling the class into
 * a type-only import graph.
 *
 * Every symbol here is re-exported verbatim from `agent-loop.ts` for
 * backward compatibility — don't deep-import from this path directly.
 *
 * @module
 */

import type { AgentAdapter, ExecutionStrategy, ToolCallRequest, ToolSchema, TokenUsage } from './types.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { GuardrailPipeline } from './guardrail-port.js';

/**
 * ARCH-006: Iteration-level instrumentation hook. Every method is optional;
 * a hook only needs to declare the events it cares about. Hooks are invoked
 * synchronously from the `AgentLoop`.
 *
 * **Exception contract (Wave-13 D-11):** All hooks MUST NOT throw. If a hook
 * throws, the exception is logged (when a `logger` is configured — at
 * `warn` level with the event name and error message) and swallowed; the
 * loop continues as if the hook had returned normally. A throwing hook will
 * NEVER propagate to the consumer of `AgentLoop.run()`, NEVER short-circuit
 * subsequent hooks in the same registration list, and NEVER corrupt the
 * iteration state. The single exception is when `strictHooks: true` is
 * passed on the config — intended for tests — in which case the error is
 * re-thrown so hook failures are immediately visible.
 *
 * Implementers should therefore treat hook callbacks as observer-only: any
 * state mutation a hook performs on external systems is the hook author's
 * responsibility; the loop neither retries on failure nor waits for
 * asynchronous completion (hooks are invoked synchronously).
 *
 * @example
 * ```ts
 * const loop = createAgentLoop({
 *   adapter,
 *   hooks: [{
 *     onIterationStart: ({ iteration }) => console.log('iter', iteration),
 *     onCost: ({ usage }) => metrics.add(usage),
 *   }],
 * });
 * ```
 */
export interface AgentLoopHook {
  /**
   * Fires before any work in an iteration (right after the iteration counter
   * increments). MUST NOT throw — exceptions are logged and swallowed.
   */
  onIterationStart?(info: { iteration: number }): void;
  /**
   * Fires once per tool call yielded to the consumer, before tool execution.
   * MUST NOT throw — exceptions are logged and swallowed.
   */
  onToolCall?(info: { iteration: number; toolCall: ToolCallRequest }): void;
  /**
   * Fires after the adapter returns usage for the iteration. MUST NOT throw
   * — exceptions are logged and swallowed.
   */
  onCost?(info: { iteration: number; usage: TokenUsage }): void;
  /**
   * Fires at the end of the iteration. `done` indicates whether the loop is
   * terminating. MUST NOT throw — exceptions are logged and swallowed.
   */
  onIterationEnd?(info: { iteration: number; done: boolean }): void;
}

// ─────────────────────────────────────────────────────────────────────
// Nested public API (additive, back-compat alongside the flat shape)
//
// The flat `AgentLoopConfig` below groups 20+ optional fields into a
// single struct. The nested groups here let new callers pass concern-
// sized bundles — `AgentLoopConfigV2` is a strict superset of the flat
// fields (every field has the same name + semantics). Consumers may
// mix flat and nested fields on the same call; if both are present,
// nested takes precedence.
// ─────────────────────────────────────────────────────────────────────

/** Execution-strategy bundle. */
export interface AgentLoopExecutionConfig {
  readonly executionStrategy?: ExecutionStrategy;
  readonly parallel?: boolean;
  readonly maxParallelToolCalls?: number;
  readonly isSequentialTool?: (name: string) => boolean;
}

/** Limit / capacity bundle. */
export interface AgentLoopLimitsConfig {
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly maxConversationMessages?: number;
  readonly maxStreamBytes?: number;
  readonly maxToolArgBytes?: number;
  readonly toolTimeoutMs?: number;
}

/** Resilience (retry + circuit-breaker behaviour) bundle. */
export interface AgentLoopResilienceConfig {
  readonly maxAdapterRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly retryableErrors?: readonly string[];
}

/** Observability bundle. */
export interface AgentLoopObservabilityConfig {
  readonly traceManager?: import('./trace-interface.js').AgentLoopTraceManager;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Guardrail pipelines bundle. */
export interface AgentLoopPipelinesConfig {
  readonly input?: GuardrailPipeline;
  readonly output?: GuardrailPipeline;
}

/**
 * Nested-form configuration for the AgentLoop. Every group is
 * optional; unspecified groups behave exactly like the flat defaults.
 *
 * Accepted by `createAgentLoop` in addition to the flat
 * {@link AgentLoopConfig} — see `agent-loop-config.ts` for the
 * resolution rules. Prefer this shape in new code.
 */
export interface AgentLoopConfigV2 {
  readonly adapter: AgentAdapter;
  readonly signal?: AbortSignal;
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly tools?: ToolSchema[];
  readonly streaming?: boolean;
  readonly hooks?: readonly AgentLoopHook[];
  readonly strictHooks?: boolean;
  readonly execution?: AgentLoopExecutionConfig;
  readonly limits?: AgentLoopLimitsConfig;
  readonly resilience?: AgentLoopResilienceConfig;
  readonly observability?: AgentLoopObservabilityConfig;
  readonly pipelines?: AgentLoopPipelinesConfig;
}

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  readonly adapter: AgentAdapter;
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  /**
   * Callback invoked when the LLM requests a tool call.
   *
   * Returns `Promise<unknown>` intentionally: tool results are inherently
   * dynamic — each tool produces its own result shape (string, object, error
   * envelope, etc.), and the AgentLoop serializes the result to a string for
   * the LLM regardless of type. Typing this more narrowly would force every
   * tool handler to conform to a single return type, which would be incorrect.
   *
   * The AgentLoop treats the resolved value as opaque data: it is stringified
   * via `JSON.stringify` (or `.toString()` for non-objects) and fed back as a
   * tool-result message.
   */
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly tools?: ToolSchema[];
  readonly maxConversationMessages?: number;
  readonly streaming?: boolean;
  readonly parallel?: boolean;
  readonly maxParallelToolCalls?: number;
  /**
   * Custom execution strategy for tool calls.
   *
   * When provided, this strategy takes precedence over the `parallel` flag.
   * If omitted, a default strategy is selected automatically:
   * - `parallel: true` creates a default parallel strategy (with
   *   `maxParallelToolCalls` concurrency).
   * - Otherwise a sequential strategy is used.
   *
   * Inject a custom strategy to control ordering, batching, retries,
   * or any other execution concern without modifying the AgentLoop itself.
   *
   * @example
   * ```ts
   * const loop = new AgentLoop({
   *   adapter,
   *   executionStrategy: myCustomStrategy,
   * });
   * ```
   */
  readonly executionStrategy?: ExecutionStrategy;
  readonly isSequentialTool?: (name: string) => boolean;
  /**
   * Optional trace manager for automatic observability.
   *
   * When provided, `run()` automatically creates a trace on start, a span for
   * each iteration, child spans for each tool call, and ends the trace on
   * completion. This wires the AgentLoop to the observability layer without
   * requiring manual instrumentation.
   */
  readonly traceManager?: AgentLoopTraceManager;
  /**
   * Optional timeout in milliseconds for individual tool executions.
   *
   * When set, any tool call that does not resolve within this duration
   * is aborted with a timeout error and the result is fed back to the LLM.
   */
  readonly toolTimeoutMs?: number;
  /**
   * Maximum accumulated stream content size in bytes per iteration.
   *
   * Defaults to 10 MB (10 * 1024 * 1024). Set a lower value to reduce
   * memory pressure when processing large streaming responses.
   */
  readonly maxStreamBytes?: number;
  /**
   * Maximum size in bytes for a single tool-call's accumulated arguments.
   *
   * Defaults to 5 MB (5 * 1024 * 1024). Prevents oversized payloads from
   * being forwarded to tool handlers.
   */
  readonly maxToolArgBytes?: number;
  /**
   * Maximum number of retries for retryable adapter errors (e.g. rate-limit).
   *
   * Defaults to 0 (no retries). Set to a positive number to enable automatic
   * retry with exponential backoff for retryable errors.
   */
  readonly maxAdapterRetries?: number;
  /**
   * Base delay in milliseconds for exponential backoff between retries.
   *
   * Actual delay is `baseRetryDelayMs * 2^attempt + jitter`.
   * Defaults to 1000.
   */
  readonly baseRetryDelayMs?: number;
  /**
   * Error categories eligible for retry.
   *
   * Defaults to `['ADAPTER_RATE_LIMIT']`. Set to include `'ADAPTER_NETWORK'`
   * to also retry transient network errors.
   */
  readonly retryableErrors?: readonly string[];
  /**
   * ARCH-006: Iteration-level instrumentation hooks. Each registered hook
   * receives `onIterationStart`, `onToolCall`, `onCost`, and
   * `onIterationEnd` callbacks (all optional). Hook errors are logged via
   * `logger` (when set) and swallowed — hooks must never break the loop.
   */
  readonly hooks?: readonly AgentLoopHook[];
  /**
   * When true, hook errors are re-thrown instead of swallowed. Useful for
   * testing and development where hook failures should be immediately visible.
   * Default: false (production-safe — errors are logged and swallowed).
   */
  readonly strictHooks?: boolean;
  /**
   * Optional structured logger. Used to surface hook failures (ARCH-006)
   * and other diagnostic warnings that previously fell back to
   * `console.warn`. Optional — when omitted, hook failures fall back to
   * console.error.
   */
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * T10 (Wave-5A): optional guardrail pipeline applied to the latest user
   * message before every adapter call. A hard-block (`action: 'block'`)
   * terminates the loop with a `guardrail_blocked` AgentEvent followed by an
   * `error` carrying `HarnessErrorCode.GUARD_VIOLATION` (non-retryable),
   * and aborts the internal AbortController so any in-flight adapter call is
   * torn down. Omitting both pipelines emits a one-time `safeWarn` on the
   * first `run()` — security-relevant configurations should use
   * `createSecurePreset`.
   */
  readonly inputPipeline?: GuardrailPipeline;
  /**
   * T10 (Wave-5A): optional guardrail pipeline applied to
   * (a) each tool execution result — a block rewrites the tool result into a
   *     `GUARDRAIL_VIOLATION: <guardName>` stub so the LLM's tool-use / -result
   *     pairing stays valid and the loop continues, AND
   * (b) the final assistant answer — a block terminates the loop with a
   *     `guardrail_blocked` + `error` pair (see `inputPipeline`).
   */
  readonly outputPipeline?: GuardrailPipeline;
}
