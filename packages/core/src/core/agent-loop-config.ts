/**
 * Resolve a raw {@link AgentLoopConfig} into a validated bundle of final
 * values the `AgentLoop` constructor can consume without branching on
 * `undefined` in every line.
 *
 * Extracted from `agent-loop.ts` in round-3 cleanup. The constructor used to
 * carry 26 per-field default / presence checks interleaved with assignments;
 * moving the logic here lets the class store a handful of grouped bundles
 * instead of 26 individual readonly fields.
 *
 * Kept `readonly` end-to-end and `Object.freeze`-ed at the return boundary so
 * downstream consumers cannot mutate the resolved shape. Validation is done
 * eagerly so a misconfigured loop never fails silently at run() time.
 *
 * @module
 */

import type { AgentAdapter, ExecutionStrategy, Message, TokenUsage, ToolCallRequest, ToolSchema } from './types.js';
import type { AgentLoopConfig, AgentLoopConfigV2, AgentLoopHook } from './agent-loop-types.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { GuardrailPipeline } from './guardrail-port.js';
import { createSequentialStrategy, createParallelStrategy } from './execution-strategies.js';
import { validateAgentLoopConfig } from './agent-loop-validation.js';

/** Maximum accumulated stream content size (10 MB) to prevent memory exhaustion. */
export const MAX_STREAM_BYTES = 10 * 1024 * 1024;
/** Maximum size per tool-call argument (5 MB) to prevent oversized payloads. */
export const MAX_TOOL_ARG_BYTES = 5 * 1024 * 1024;

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

/**
 * Flatten a nested {@link AgentLoopConfigV2} into the wire-format flat
 * {@link AgentLoopConfig}. Callers that supply both nested and flat
 * forms receive a shallow merge where nested groups take precedence.
 *
 * Pure — does not run validation. The existing `resolveAgentLoopConfig`
 * above runs validation on the merged shape, so misconfigurations still
 * surface at construction time.
 */
export function flattenNestedAgentLoopConfig(v2: AgentLoopConfigV2): AgentLoopConfig {
  const flat: AgentLoopConfig = {
    adapter: v2.adapter,
    ...(v2.signal !== undefined && { signal: v2.signal }),
    ...(v2.onToolCall !== undefined && { onToolCall: v2.onToolCall }),
    ...(v2.tools !== undefined && { tools: v2.tools }),
    ...(v2.streaming !== undefined && { streaming: v2.streaming }),
    ...(v2.hooks !== undefined && { hooks: v2.hooks }),
    ...(v2.strictHooks !== undefined && { strictHooks: v2.strictHooks }),
    ...(v2.execution?.executionStrategy !== undefined && {
      executionStrategy: v2.execution.executionStrategy,
    }),
    ...(v2.execution?.parallel !== undefined && { parallel: v2.execution.parallel }),
    ...(v2.execution?.maxParallelToolCalls !== undefined && {
      maxParallelToolCalls: v2.execution.maxParallelToolCalls,
    }),
    ...(v2.execution?.isSequentialTool !== undefined && {
      isSequentialTool: v2.execution.isSequentialTool,
    }),
    ...(v2.limits?.maxIterations !== undefined && { maxIterations: v2.limits.maxIterations }),
    ...(v2.limits?.maxTotalTokens !== undefined && { maxTotalTokens: v2.limits.maxTotalTokens }),
    ...(v2.limits?.maxConversationMessages !== undefined && {
      maxConversationMessages: v2.limits.maxConversationMessages,
    }),
    ...(v2.limits?.maxStreamBytes !== undefined && { maxStreamBytes: v2.limits.maxStreamBytes }),
    ...(v2.limits?.maxToolArgBytes !== undefined && { maxToolArgBytes: v2.limits.maxToolArgBytes }),
    ...(v2.limits?.toolTimeoutMs !== undefined && { toolTimeoutMs: v2.limits.toolTimeoutMs }),
    ...(v2.resilience?.maxAdapterRetries !== undefined && {
      maxAdapterRetries: v2.resilience.maxAdapterRetries,
    }),
    ...(v2.resilience?.baseRetryDelayMs !== undefined && {
      baseRetryDelayMs: v2.resilience.baseRetryDelayMs,
    }),
    ...(v2.resilience?.retryableErrors !== undefined && {
      retryableErrors: v2.resilience.retryableErrors,
    }),
    ...(v2.observability?.traceManager !== undefined && {
      traceManager: v2.observability.traceManager,
    }),
    ...(v2.observability?.logger !== undefined && { logger: v2.observability.logger }),
    ...(v2.pipelines?.input !== undefined && { inputPipeline: v2.pipelines.input }),
    ...(v2.pipelines?.output !== undefined && { outputPipeline: v2.pipelines.output }),
  };
  return flat;
}

/**
 * True when the raw object looks like the nested v2 shape (contains
 * at least one of the v2-exclusive group keys). Used by
 * `createAgentLoop` to decide whether to flatten first.
 */
export function isNestedAgentLoopConfig(
  raw: AgentLoopConfig | AgentLoopConfigV2,
): raw is AgentLoopConfigV2 {
  const v2 = raw as AgentLoopConfigV2;
  return (
    v2.execution !== undefined
    || v2.limits !== undefined
    || v2.resilience !== undefined
    || v2.observability !== undefined
    || v2.pipelines !== undefined
  );
}

// Re-export so consumers that only want the types can avoid reaching into
// `agent-loop-types.js` directly.
export type { AgentLoopConfig, AgentLoopHook, TokenUsage, Message };
export type { AgentLoopConfigV2 } from './agent-loop-types.js';
