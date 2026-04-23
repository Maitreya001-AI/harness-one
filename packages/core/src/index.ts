/**
 * Root entry point for `harness-one`.
 *
 * The curated barrel exposes **18 value symbols** covering the core
 * user-journeys. Every other runtime factory ships from its owning
 * subpath (`harness-one/core`, `harness-one/tools`, `harness-one/guardrails`,
 * etc.) or from a sibling package (`@harness-one/cli`, `@harness-one/devkit`,
 * `@harness-one/preset`). Type-only re-exports are unbounded (zero runtime
 * bundle cost).
 *
 * `createSecurePreset` is **not** re-exported here — it ships exclusively
 * from `@harness-one/preset` to avoid a three-leg cycle
 * (`harness-one` → `@harness-one/preset` → `harness-one`). Import it
 * directly from `@harness-one/preset`.
 *
 * @module
 */

// ── CORE LOOP ───────────────────────────────────────────────────────────────
export { createAgentLoop } from './core/index.js';           // 1  primary factory
export { AgentLoop } from './core/index.js';                 // 2  class for `new` + instanceof narrowing
export { createResilientLoop } from './advanced/index.js';   // 3  canonical retry-wrap (lives in /advanced)
export { createMiddlewareChain } from './advanced/index.js'; // 4  middleware composition (lives in /advanced)

// ── ERRORS (every consumer catches these) ───────────────────────────────────
export { HarnessError } from './core/errors.js';             // 5  base error class
export { MaxIterationsError } from './core/errors.js';       // 6  common catch target
export { AbortedError } from './core/errors.js';             // 7  AbortController path
export { ToolValidationError } from './core/errors.js';      // 8  tool-call schema miss
export { TokenBudgetExceededError } from './core/errors.js'; // 9  budget ceiling
export { HarnessErrorCode } from './core/errors.js';         // 10 closed enum (runtime-introspectable)

// ── TOOLS ───────────────────────────────────────────────────────────────────
export { defineTool } from './tools/index.js';     // 11 tool DSL
export { createRegistry } from './tools/index.js'; // 12 registry factory

// ── GUARDRAILS (fail-closed by default) ─────────────────────────────────────
export { createPipeline } from './guardrails/index.js'; // 13 guardrail pipeline composition

// ── OBSERVABILITY ───────────────────────────────────────────────────────────
export { createTraceManager } from './observe/index.js'; // 14 OTel bridge entry
export { createLogger } from './observe/index.js';       // 15 structured logger
export { createCostTracker } from './observe/index.js';  // 16 MetricsPort-aware cost tracker

// ── SESSION (multi-tenant gateway) ──────────────────────────────────────────
export { createSessionManager } from './session/index.js'; // 17 session primitive

// ── LIFECYCLE (Disposable contract) ─────────────────────────────────────────
export { disposeAll } from './infra/disposable.js'; // 18 public lifecycle helper

// ──────────────────────────────────────────────────────────────────────────
// TYPE-ONLY RE-EXPORTS — unbounded (zero runtime bundle cost)
// ──────────────────────────────────────────────────────────────────────────

export type {
  Role,
  Message,
  MessageMeta,
  MessageProvenance,
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
// root so top-level imports of the core primitives keep their public-type
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

// Lifecycle primitives (Disposable contract — type-only).
export type { Disposable } from './infra/disposable.js';
export type { DisposeAggregateError } from './infra/disposable.js';
