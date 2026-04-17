/**
 * `harness-one/core` — the end-user surface.
 *
 * This barrel exposes the API a typical consumer needs to build an agent
 * loop: message types, errors, events, `createAgentLoop` + its hooks and
 * config shapes, model pricing, and the two tracing ports that get wired
 * into the observability stack.
 *
 * Extension primitives (`StreamAggregator`, `createMiddlewareChain`,
 * `parseWithRetry`, validators, iteration-coordinator helpers, etc.) live
 * in the separate `harness-one/advanced` barrel. Keeping the two surfaces
 * distinct means new consumers see a narrow, stable contract here and opt
 * into the lower-level plumbing only when they actually need it.
 *
 * @module
 */

// ─── Message / adapter / response types ──────────────────────────────────
export type {
  Role,
  Message,
  SystemMessage,
  TrustedSystemBrand,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  MessageMeta,
  ToolCallRequest,
  TokenUsage,
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  ToolSchema,
  JsonSchema,
  JsonSchemaType,
  LLMConfig,
  ResponseFormat,
  ToolExecutionResult,
  ExecutionStrategy,
} from './types.js';

// ─── Errors (every consumer catches these) ────────────────────────────────
export {
  HarnessError,
  HarnessErrorCode,
  MaxIterationsError,
  AbortedError,
  ToolValidationError,
  TokenBudgetExceededError,
} from './errors.js';

// ─── Events ───────────────────────────────────────────────────────────────
export type { AgentEvent, DoneReason } from './events.js';
export { assertNever } from './events.js';

// ─── AgentLoop + config + hooks (the idiomatic entry point) ──────────────
export { AgentLoop, createAgentLoop } from './agent-loop.js';
export type { AgentLoopConfig, AgentLoopHook } from './agent-loop.js';
// Nested-form public config (additive; flat AgentLoopConfig remains
// accepted by `createAgentLoop`). Prefer the nested shape in new code.
export type {
  AgentLoopConfigV2,
  AgentLoopExecutionConfig,
  AgentLoopLimitsConfig,
  AgentLoopResilienceConfig,
  AgentLoopObservabilityConfig,
  AgentLoopPipelinesConfig,
} from './agent-loop-types.js';

// ─── Pricing types (consumers declare model rates against this shape) ────
export type { ModelPricing, TokenUsageRecord } from './pricing.js';

// ─── Observability ports (consumers wire their backend against these) ───
export type {
  MetricsPort,
  MetricAttributes,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
} from './metrics-port.js';
export { createNoopMetricsPort } from './metrics-port.js';
export type { InstrumentationPort } from './instrumentation-port.js';
