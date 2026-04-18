/**
 * Root entry point for `harness-one`.
 *
 * Wave-5C PR-3 (F-1) targeted 19 value symbols; subsequent deprecation passes
 * (Wave-17 dropped `GuardrailBlockedError`) settled the curated barrel at
 * **18 value symbols** covering the core user-journeys (UJ-1..UJ-5 per
 * wave-5c-prd-v2.md §5). Every other runtime factory moved to its owning
 * subpath (`harness-one/core`, `harness-one/tools`, `harness-one/guardrails`,
 * etc.) or to a sibling package (`@harness-one/cli`, `@harness-one/devkit`,
 * `@harness-one/preset`). Type-only re-exports remain unbounded per ADR §5.2
 * (zero runtime bundle cost).
 *
 * Per R-01 lead decision (`wave-5c-risk-decisions.md`), `createSecurePreset`
 * is **no longer re-exported here** — it ships exclusively from
 * `@harness-one/preset` to avoid a three-leg cycle
 * (`harness-one` → `@harness-one/preset` → `harness-one`). Wave-5A consumers
 * must import `createSecurePreset` directly from `@harness-one/preset`.
 *
 * @module
 */

// ── CORE LOOP (UJ-1) ────────────────────────────────────────────────────────
export { createAgentLoop } from './core/index.js';           // 1  UJ-1: primary factory
export { AgentLoop } from './core/index.js';                 // 2  UJ-1: class for `new` + instanceof narrowing
export { createResilientLoop } from './advanced/index.js';   // 3  UJ-1: canonical retry-wrap (lives in /advanced)
export { createMiddlewareChain } from './advanced/index.js'; // 4  UJ-1: middleware composition (lives in /advanced)

// ── ERRORS (UJ-1 — every consumer catches these) ────────────────────────────
export { HarnessError } from './core/errors.js';             // 5  UJ-1: base error class
export { MaxIterationsError } from './core/errors.js';       // 6  UJ-1: common catch target
export { AbortedError } from './core/errors.js';             // 7  UJ-1: AbortController path
export { ToolValidationError } from './core/errors.js';      // 8  UJ-1: tool-call schema miss
export { TokenBudgetExceededError } from './core/errors.js'; // 9  UJ-1: budget ceiling
export { HarnessErrorCode } from './core/errors.js';         // 10 UJ-1: closed enum (runtime-introspectable — ADR §3.f B-pattern)

// ── TOOLS (UJ-1) ────────────────────────────────────────────────────────────
export { defineTool } from './tools/index.js';     // 11 UJ-1: tool DSL
export { createRegistry } from './tools/index.js'; // 12 UJ-1: registry factory

// ── GUARDRAILS (UJ-1 + Wave-5A fail-closed) ─────────────────────────────────
export { createPipeline } from './guardrails/index.js'; // 13 UJ-1: guardrail pipeline composition

// ── OBSERVABILITY (UJ-1 + Wave-5 OTel invariant §3) ─────────────────────────
export { createTraceManager } from './observe/index.js'; // 14 UJ-1: OTel bridge entry
export { createLogger } from './observe/index.js';       // 15 UJ-1: structured logger
export { createCostTracker } from './observe/index.js';  // 16 UJ-1: MetricsPort (re-added per ADR §5.1 critic §3.4)

// ── SESSION (UJ-1; Wave-5E multi-tenant gateway) ────────────────────────────
export { createSessionManager } from './session/index.js'; // 17 UJ-1: session primitive

// ── LIFECYCLE (ARCH-005 Disposable contract) ────────────────────────────────
export { disposeAll } from './infra/disposable.js'; // 18 ARCH-005: public lifecycle helper

// History: Wave-5C PR-3a allocated 19 ADR slots; the original slot 11 was
// `createSecurePreset` (dropped per R-01 to break the
// `harness-one` ↔ `@harness-one/preset` cycle), leaving 18 active value
// symbols. The numbering above is now sequential (no gaps); the original
// ADR slot map lives in docs/architecture/00-overview.md §3.

// ──────────────────────────────────────────────────────────────────────────
// TYPE-ONLY RE-EXPORTS — unbounded per ADR §5.2 (zero runtime bundle cost)
// ──────────────────────────────────────────────────────────────────────────

export type {
  Role,
  Message,
  MessageMeta,
  SystemMessage,
  TrustedSystemBrand,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  AgentAdapter,
  AgentLoopConfig,
  AgentLoopHook,
  AgentLoopStatus,
  ChatParams,
  ChatResponse,
  StreamChunk,
  ToolCallRequest,
  ToolSchema,
  TokenUsage,
  JsonSchema,
  JsonSchemaType,
  LLMConfig,
  ResponseFormat,
  ToolExecutionResult,
  ExecutionStrategy,
  AgentEvent,
  DoneReason,
} from './core/index.js';

// Extension-point types from `harness-one/advanced` — re-exported at the
// root so top-level imports of the UJ-1 primitives keep their public-type
// references (MiddlewareChain, ResilientLoop, ...) without a second import.
// Type-only re-exports are safe even when the VALUE lives elsewhere: TS
// structural typing means there is no risk of two "different" copies of the
// same shape (the concern ARCHITECTURE.md raises for value symbols).
export type {
  AgentLoopTraceManager,
  FallbackAdapterConfig,
  ResilientLoopConfig,
  ResilientLoop,
  MiddlewareChain,
  MiddlewareFn,
  OutputParser,
  PruneResult,
  StreamAggregatorEvent,
  StreamAggregatorChunk,
  StreamAggregatorMessage,
  StreamAggregatorOptions,
  HarnessErrorDetails,
} from './advanced/index.js';

export type {
  ToolDefinition,
  ToolMiddleware,
  ToolResult,
  ToolFeedback,
  ToolCall,
  ToolRegistry,
  SchemaValidator,
  ValidationError,
  CreateRegistryConfig,
  ToolCapabilityValue,
} from './tools/index.js';

export type {
  Guardrail,
  GuardrailContext,
  GuardrailVerdict,
  GuardrailPipeline,
  PipelineResult,
  PermissionLevel,
} from './guardrails/index.js';

export type {
  Trace,
  Span,
  SpanEvent,
  SpanAttributes,
  SpanAttributeValue,
  TraceExporter,
  TraceManager,
  InstrumentationPort,
  MetricsPort,
  MetricAttributes,
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  CostTracker,
  ModelPricing,
  TokenUsageRecord,
  CostAlert,
  Logger,
  LogLevel,
  LoggerConfig,
  FailureMode,
  FailureClassification,
  CacheMetrics,
  CacheMetricsBucket,
  CacheMonitor,
} from './observe/index.js';

export type {
  Session,
  SessionEvent,
  SessionManager,
  ConversationStore,
  ConversationStoreCapabilities,
  AuthContext,
} from './session/index.js';

export type {
  MemoryEntry,
  MemoryFilter,
  MemoryStore,
  MemoryStoreCapabilities,
  MemoryGrade,
  ContextRelay,
  RelayState,
  CompactionPolicy,
  CompactionResult,
  VectorSearchOptions,
} from './memory/index.js';

// Lifecycle primitives (ARCH-005 Disposable contract — type-only per ADR §5.2).
export type { Disposable } from './infra/disposable.js';
export type { DisposeAggregateError } from './infra/disposable.js';
