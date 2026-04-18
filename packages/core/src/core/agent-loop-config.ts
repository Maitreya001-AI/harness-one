/**
 * Resolve a raw {@link AgentLoopConfig} into a validated bundle of final
 * values the `AgentLoop` constructor can consume without branching on
 * `undefined` in every line.
 *
 * Kept `readonly` end-to-end and `Object.freeze`-ed at the return boundary
 * so downstream consumers cannot mutate the resolved shape. Validation
 * runs eagerly so a misconfigured loop never fails silently at run() time.
 *
 * @module
 */

import type { AgentAdapter, ExecutionStrategy, Message, TokenUsage, ToolCallRequest, ToolSchema } from './types.js';
import type { AgentLoopConfig, AgentLoopHook } from './agent-loop-types.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { GuardrailPipeline } from './guardrail-port.js';
import { createSequentialStrategy, createParallelStrategy } from './execution-strategies.js';
import { validateAgentLoopConfig } from './agent-loop-validation.js';

/**
 * Per-iteration cap on the accumulated stream content (10 MB) that
 * {@link StreamAggregator} can buffer before it truncates and emits
 * `ADAPTER_STREAM_OVERSIZED`. This is the primary bound — a single
 * iteration can never balloon past it.
 *
 * The loop also enforces a secondary cumulative backstop,
 * `maxCumulativeStreamBytes = maxIterations × maxStreamBytes`, aimed at a
 * runaway loop that never exceeds the per-iteration cap but keeps calling
 * the adapter. With default maxIterations (25) and maxStreamBytes (10 MB)
 * that lands at 250 MB — a pragmatic ceiling, not a "total budget" the
 * user should rely on for accounting. Tighten either knob for stricter
 * containment.
 */
export const MAX_STREAM_BYTES = 10 * 1024 * 1024;
/** Maximum size per tool-call argument (5 MB) to prevent oversized payloads. */
export const MAX_TOOL_ARG_BYTES = 5 * 1024 * 1024;
/**
 * Default upper bound on the number of distinct tool calls a single adapter
 * stream can emit. Applied both by {@link StreamAggregator} (core-side) and
 * provider adapters (anthropic / openai) so truncation happens at the same
 * boundary and user-visible error codes stay uniform.
 */
export const MAX_TOOL_CALLS = 128;

/** Logger shape used by AgentLoop + its downstream components. */
export type AgentLoopLogger = {
  readonly warn: (msg: string, meta?: Record<string, unknown>) => void;
};

/**
 * Bundle of defaults + validated values handed to `AgentLoop` at
 * construction time. Split into sub-bundles so each concern
 * (limits, hooks, pipelines, observability) reads cleanly in the class body.
 */
export interface ResolvedAgentLoopConfig {
  readonly adapter: AgentAdapter;
  readonly tools?: readonly ToolSchema[];
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly externalSignal?: AbortSignal;

  readonly streaming: boolean;
  readonly executionStrategy: ExecutionStrategy;

  readonly limits: {
    readonly maxIterations: number;
    readonly maxTotalTokens: number;
    readonly maxConversationMessages: number;
    readonly maxStreamBytes: number;
    readonly maxToolArgBytes: number;
    readonly maxAdapterRetries: number;
    readonly baseRetryDelayMs: number;
    readonly retryableErrors: readonly string[];
    readonly toolTimeoutMs?: number;
  };

  readonly hooks: {
    readonly registered: readonly AgentLoopHook[];
    readonly strict: boolean;
  };

  readonly pipelines: {
    readonly input?: GuardrailPipeline;
    readonly output?: GuardrailPipeline;
  };

  readonly observability: {
    readonly logger?: AgentLoopLogger;
    readonly traceManager?: AgentLoopTraceManager;
  };

  readonly isSequentialTool?: (name: string) => boolean;
}

/**
 * Build a frozen {@link ResolvedAgentLoopConfig} from the raw
 * {@link AgentLoopConfig} surfaced to the public `createAgentLoop` / `new
 * AgentLoop()` entry points.
 *
 * Centralises: default values, presence-gated optional copying (respecting
 * the repo-wide `exactOptionalPropertyTypes: true` tsconfig), execution
 * strategy selection (explicit strategy ≻ `parallel: true` shorthand ≻
 * sequential default), and the `validateAgentLoopConfig` hard checks.
 */
export function resolveAgentLoopConfig(
  raw: Readonly<AgentLoopConfig>,
): ResolvedAgentLoopConfig {
  const limits = {
    maxIterations: raw.maxIterations ?? 25,
    maxTotalTokens: raw.maxTotalTokens ?? Infinity,
    maxConversationMessages: raw.maxConversationMessages ?? 200,
    maxStreamBytes: raw.maxStreamBytes ?? MAX_STREAM_BYTES,
    maxToolArgBytes: raw.maxToolArgBytes ?? MAX_TOOL_ARG_BYTES,
    maxAdapterRetries: raw.maxAdapterRetries ?? 0,
    baseRetryDelayMs: raw.baseRetryDelayMs ?? 1000,
    retryableErrors: raw.retryableErrors ?? ['ADAPTER_RATE_LIMIT'],
    ...(raw.toolTimeoutMs !== undefined && { toolTimeoutMs: raw.toolTimeoutMs }),
  } satisfies ResolvedAgentLoopConfig['limits'];

  validateAgentLoopConfig({
    maxIterations: limits.maxIterations,
    maxTotalTokens: limits.maxTotalTokens,
    maxStreamBytes: limits.maxStreamBytes,
    maxToolArgBytes: limits.maxToolArgBytes,
    ...(limits.toolTimeoutMs !== undefined && { toolTimeoutMs: limits.toolTimeoutMs }),
    baseRetryDelayMs: limits.baseRetryDelayMs,
    maxAdapterRetries: limits.maxAdapterRetries,
  });

  let executionStrategy: ExecutionStrategy;
  if (raw.executionStrategy) {
    executionStrategy = raw.executionStrategy;
  } else if (raw.parallel) {
    executionStrategy = createParallelStrategy({
      maxConcurrency: raw.maxParallelToolCalls ?? 5,
    });
  } else {
    executionStrategy = createSequentialStrategy();
  }

  const resolved: ResolvedAgentLoopConfig = {
    adapter: raw.adapter,
    streaming: raw.streaming ?? false,
    executionStrategy,
    limits: Object.freeze(limits),
    hooks: Object.freeze({
      registered: Object.freeze([...(raw.hooks ?? [])]) as readonly AgentLoopHook[],
      strict: raw.strictHooks ?? false,
    }),
    pipelines: Object.freeze({
      ...(raw.inputPipeline !== undefined && { input: raw.inputPipeline }),
      ...(raw.outputPipeline !== undefined && { output: raw.outputPipeline }),
    }),
    observability: Object.freeze({
      ...(raw.logger !== undefined && { logger: raw.logger }),
      ...(raw.traceManager !== undefined && { traceManager: raw.traceManager }),
    }),
    ...(raw.tools !== undefined && { tools: raw.tools }),
    ...(raw.onToolCall !== undefined && { onToolCall: raw.onToolCall }),
    ...(raw.signal !== undefined && { externalSignal: raw.signal }),
    ...(raw.isSequentialTool !== undefined && {
      isSequentialTool: raw.isSequentialTool,
    }),
  };

  return Object.freeze(resolved);
}

// Re-export so consumers that only want the types can avoid reaching into
// `agent-loop-types.js` directly.
export type { AgentLoopConfig, AgentLoopHook, TokenUsage, Message };
