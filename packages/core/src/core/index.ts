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

// AgentLoop
export { AgentLoop } from './agent-loop.js';
export type { AgentLoopConfig } from './agent-loop.js';

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
export type { EventHandler, EventBus } from './event-bus.js';
export { createEventBus } from './event-bus.js';

// Test utilities
export type { MockAdapterConfig } from './test-utils.js';
export { createMockAdapter } from './test-utils.js';
