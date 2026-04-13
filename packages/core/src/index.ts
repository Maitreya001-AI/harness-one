/**
 * Root entry point for `harness-one`.
 *
 * Re-exports the most commonly used public APIs from every submodule so
 * users can `import { AgentLoop, createRegistry, createTraceManager } from 'harness-one'`
 * instead of hunting through submodule paths. Submodules remain
 * individually importable (`harness-one/core`, `harness-one/tools`, etc.)
 * for tree-shaking; this entry is additive, not a replacement.
 *
 * @module
 */

// Core — the loop and its immediate supporting types
export {
  AgentLoop,
  createAgentLoop,
  HarnessError,
  MaxIterationsError,
  AbortedError,
  GuardrailBlockedError,
  ToolValidationError,
  TokenBudgetExceededError,
  createJsonOutputParser,
  parseWithRetry,
  createMiddlewareChain,
  createFallbackAdapter,
  createResilientLoop,
  createEventBus,
  createSequentialStrategy,
  createParallelStrategy,
  categorizeAdapterError,
  pruneConversation,
  toSSEStream,
  formatSSE,
  assertNever,
} from './core/index.js';
export type {
  Role,
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  AgentAdapter,
  AgentLoopConfig,
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
} from './core/index.js';

// Tools
export {
  defineTool,
  createRegistry,
  toolSuccess,
  toolError,
  validateToolCall,
} from './tools/index.js';
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

// Guardrails
export {
  createPipeline,
  createInjectionDetector,
  createPIIDetector,
  createContentFilter,
  createRateLimiter,
  createSchemaValidator,
  withSelfHealing,
  runInput,
  runOutput,
  runToolOutput,
} from './guardrails/index.js';
export type {
  Guardrail,
  GuardrailContext,
  GuardrailVerdict,
  GuardrailPipeline,
} from './guardrails/index.js';

// Prompt
export { createPromptBuilder, createPromptRegistry, createAsyncPromptRegistry, createSkillEngine, createDisclosureManager } from './prompt/index.js';

// Context
export {
  packContext,
  compress,
  compactIfNeeded,
  createAdapterSummarizer,
  analyzeCacheStability,
  createCheckpointManager,
  countTokens,
  registerTokenizer,
  createBudget,
} from './context/index.js';

// Observe
export {
  createTraceManager,
  createConsoleExporter,
  createNoOpExporter,
  createCostTracker,
  createLogger,
  createFailureTaxonomy,
  createCacheMonitor,
  createDatasetExporter,
} from './observe/index.js';
export type {
  Trace,
  Span,
  SpanEvent,
  SpanAttributes,
  SpanAttributeValue,
  TraceExporter,
  TraceManager,
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

// Session
export {
  createSessionManager,
  createInMemoryConversationStore,
  createAuthContext,
} from './session/index.js';
export type {
  Session,
  SessionEvent,
  SessionManager,
  ConversationStore,
  ConversationStoreCapabilities,
  AuthContext,
} from './session/index.js';

// Memory
export {
  createInMemoryStore,
  createFileSystemStore,
  createRelay,
  runMemoryStoreConformance,
  validateMemoryEntry,
  validateIndex,
  validateRelayState,
  parseJsonSafe,
} from './memory/index.js';
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

// Orchestration
export {
  createOrchestrator,
  createAgentPool,
  createHandoff,
  createContextBoundary,
  MessageQueue,
} from './orchestration/index.js';

// Eval / Evolve / RAG — less frequently imported directly, but convenient
// to surface their factories here.
export { createEvalRunner, createRelevanceScorer } from './eval/index.js';
export { createComponentRegistry } from './evolve/index.js';
export { createRAGPipeline } from './rag/index.js';

// Lifecycle primitives (ARCH-005): codified Disposable contract + helpers.
export type { Disposable } from './_internal/disposable.js';
export { disposeAll, DisposeAggregateError } from './_internal/disposable.js';
