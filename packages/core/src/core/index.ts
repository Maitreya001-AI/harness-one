/**
 * `harness-one/core` — the end-user surface.
 *
 * This barrel exposes the API a typical consumer needs to build an agent
 * loop: message types, errors, events, `createAgentLoop` + its hooks and
 * config shapes, and model pricing.
 *
 * Observability ports (`MetricsPort`, `InstrumentationPort`,
 * `createNoopMetricsPort`) are exposed from `harness-one/observe` — the
 * canonical home for anything a caller reaches for when wiring a
 * backend. Extension primitives (`StreamAggregator`,
 * `createMiddlewareChain`, `parseWithRetry`, validators, etc.) live in
 * the separate `harness-one/advanced` barrel. Keeping the three surfaces
 * distinct means new consumers see a narrow, stable contract here and
 * opt into the lower-level plumbing only when they actually need it.
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

// ─── Pricing types (consumers declare model rates against this shape) ────
export type { ModelPricing, TokenUsageRecord } from './pricing.js';

// Note: `MetricsPort`, `InstrumentationPort`, and `createNoopMetricsPort`
// are exposed from `harness-one/observe` — the canonical home. Extension
// authors wiring a custom backend import from there, not here.
