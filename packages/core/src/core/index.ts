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
