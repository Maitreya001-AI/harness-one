// Core module — public exports

// Types
export type {
  Role,
  Message,
  SystemMessage,
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

// Errors
export {
  HarnessError,
  HarnessErrorCode,
  MaxIterationsError,
  AbortedError,
  GuardrailBlockedError,
  ToolValidationError,
  TokenBudgetExceededError,
} from './errors.js';

// Events
export type { AgentEvent, DoneReason } from './events.js';
export { assertNever } from './events.js';

// AgentLoop — class and factory alias both exported; see createAgentLoop
// JSDoc for when to use each form. The class itself is `@deprecated`
// (ARCH-011); prefer `createAgentLoop()`.
export { AgentLoop, createAgentLoop } from './agent-loop.js';
export type { AgentLoopConfig, AgentLoopHook } from './agent-loop.js';

// Tracing interface (ARCH-002) — hoisted out of agent-loop.ts so callers can
// depend on the shape without importing the loop implementation.
export type { AgentLoopTraceManager } from './trace-interface.js';

// Stream aggregator (ARCH-001) — extracted from AgentLoop; reusable as a
// stand-alone primitive when wrapping a custom adapter.stream() generator.
export { StreamAggregator } from './stream-aggregator.js';
export type {
  StreamAggregatorEvent,
  StreamAggregatorChunk,
  StreamAggregatorMessage,
  StreamAggregatorOptions,
} from './stream-aggregator.js';

// Output parser
export type { OutputParser } from './output-parser.js';
export { createJsonOutputParser, parseWithRetry } from './output-parser.js';

// Middleware
export type { MiddlewareContext, MiddlewareFn, MiddlewareChain } from './middleware.js';
export { createMiddlewareChain } from './middleware.js';

// Fallback adapter
export type { FallbackAdapterConfig } from './fallback-adapter.js';
export { createFallbackAdapter } from './fallback-adapter.js';

// SSE streaming
export type { SSEChunk } from './sse-stream.js';
export { toSSEStream, formatSSE } from './sse-stream.js';

// Event bus
export type { EventHandler, EventBus, EventBusOptions } from './event-bus.js';
export { createEventBus } from './event-bus.js';

// Execution strategies
export { createSequentialStrategy, createParallelStrategy } from './execution-strategies.js';

// Error classifier (extracted from AgentLoop)
export { categorizeAdapterError } from './error-classifier.js';

// Conversation pruner (extracted from AgentLoop)
export type { PruneResult } from './conversation-pruner.js';
export { pruneConversation } from './conversation-pruner.js';

// Resilient loop
export type { ResilientLoopConfig, ResilientLoop } from './resilience.js';
export { createResilientLoop } from './resilience.js';

// Test utilities
export type { MockAdapterConfig } from './test-utils.js';
export { createMockAdapter } from './test-utils.js';
