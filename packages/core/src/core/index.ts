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
  MaxIterationsError,
  AbortedError,
  GuardrailBlockedError,
  ToolValidationError,
  TokenBudgetExceededError,
} from './errors.js';

// Events
export type { AgentEvent, DoneReason } from './events.js';
export { assertNever } from './events.js';

// AgentLoop
export { AgentLoop } from './agent-loop.js';
export type { AgentLoopConfig, AgentLoopTraceManager } from './agent-loop.js';

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
