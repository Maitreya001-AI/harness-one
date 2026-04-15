/**
 * Root entry point for `harness-one`.
 *
 * Wave-5C PR-3 (F-1): narrowed to **19 value symbols** covering the core
 * user-journeys (UJ-1..UJ-5 per wave-5c-prd-v2.md §5). Every other runtime
 * factory moved to its owning subpath (`harness-one/core`, `harness-one/tools`,
 * `harness-one/guardrails`, etc.) or to a sibling package (`@harness-one/cli`,
 * `@harness-one/devkit`, `@harness-one/preset`). Type-only re-exports remain
 * unbounded per ADR §5.2 (zero runtime bundle cost).
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
export { createAgentLoop } from './core/index.js';       // 1  UJ-1: primary factory
export { AgentLoop } from './core/index.js';             // 2  UJ-1: class for `new` + instanceof narrowing
export { createResilientLoop } from './core/index.js';   // 3  UJ-1: canonical retry-wrap (re-added per ADR §5.1 critic §3.4)
export { createMiddlewareChain } from './core/index.js'; // 4  UJ-1: middleware composition (preset + custom both use)

// ── ERRORS (UJ-1 — every consumer catches these) ────────────────────────────
export { HarnessError } from './core/errors.js';             // 5  UJ-1: base error class
export { MaxIterationsError } from './core/errors.js';       // 6  UJ-1: common catch target
export { AbortedError } from './core/errors.js';             // 7  UJ-1: AbortController path
export { GuardrailBlockedError } from './core/errors.js';    // 8  UJ-1: guardrail pipeline verdict
export { ToolValidationError } from './core/errors.js';      // 9  UJ-1: tool-call schema miss
export { TokenBudgetExceededError } from './core/errors.js'; // 10 UJ-1: budget ceiling
export { HarnessErrorCode } from './core/errors.js';         // 11 UJ-1: closed enum (runtime-introspectable — ADR §3.f B-pattern)

// ── TOOLS (UJ-1) ────────────────────────────────────────────────────────────
export { defineTool } from './tools/index.js';     // 12 UJ-1: tool DSL
export { createRegistry } from './tools/index.js'; // 13 UJ-1: registry factory

// ── GUARDRAILS (UJ-1 + Wave-5A fail-closed) ─────────────────────────────────
export { createPipeline } from './guardrails/index.js'; // 14 UJ-1: guardrail pipeline composition

// ── OBSERVABILITY (UJ-1 + Wave-5 OTel invariant §3) ─────────────────────────
export { createTraceManager } from './observe/index.js'; // 15 UJ-1: OTel bridge entry
export { createLogger } from './observe/index.js';       // 16 UJ-1: structured logger
export { createCostTracker } from './observe/index.js';  // 17 UJ-1: MetricsPort (re-added per ADR §5.1 critic §3.4)

// ── SESSION (UJ-1; Wave-5E multi-tenant gateway) ────────────────────────────
export { createSessionManager } from './session/index.js'; // 18 UJ-1: session primitive

// ── LIFECYCLE (ARCH-005 Disposable contract) ────────────────────────────────
export { disposeAll } from './infra/disposable.js'; // 19 ARCH-005: public lifecycle helper

// Slot 19 in ADR §5.1 was originally `createSecurePreset` from `@harness-one/preset`;
// dropped per R-01 (cycle avoidance). `disposeAll` takes the slot; total = 19 values.

// ──────────────────────────────────────────────────────────────────────────
// TYPE-ONLY RE-EXPORTS — unbounded per ADR §5.2 (zero runtime bundle cost)
// ──────────────────────────────────────────────────────────────────────────

export type {
  Role,
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  AgentAdapter,
  AgentLoopConfig,
  AgentLoopHook,
  AgentLoopTraceManager,
  ChatParams,
  ChatResponse,
  StreamChunk,
  ToolCallRequest,
  ToolSchema,
  TokenUsage,
  JsonSchema,
  LLMConfig,
  ResponseFormat,
  AgentEvent,
  DoneReason,
  FallbackAdapterConfig,
  ResilientLoopConfig,
  ResilientLoop,
  MiddlewareChain,
  OutputParser,
  EventBus,
  PruneResult,
  StreamAggregatorEvent,
  StreamAggregatorChunk,
  StreamAggregatorMessage,
  StreamAggregatorOptions,
} from './core/index.js';

export type {
  ToolDefinition,
  ToolMiddleware,
  ToolResult,
  ToolFeedback,
  ToolCall,
  ToolRegistry,
  SchemaValidator,
  ValidationError,
} from './tools/index.js';

export type {
  Guardrail,
  GuardrailContext,
  GuardrailVerdict,
  GuardrailPipeline,
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
  CostTracker,
  ModelPricing,
  TokenUsageRecord,
  CostAlert,
  Logger,
  LogLevel,
  FailureMode,
  FailureClassification,
  CacheMetrics,
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
