/**
 * Shared types for harness-one core module.
 *
 * These types define the contract that all other modules import.
 *
 * @module
 */

/** Message role in the conversation. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Base properties shared by all message types. */
interface BaseMessage {
  readonly content: string;
  readonly name?: string;
  readonly meta?: MessageMeta;
}

/** A system message. */
export interface SystemMessage extends BaseMessage {
  readonly role: 'system';
}

/** A user message. */
export interface UserMessage extends BaseMessage {
  readonly role: 'user';
}

/** An assistant message, optionally containing tool call requests. */
export interface AssistantMessage extends BaseMessage {
  readonly role: 'assistant';
  readonly toolCalls?: readonly ToolCallRequest[];
}

/** A tool result message, referencing the tool call it responds to. */
export interface ToolMessage extends BaseMessage {
  readonly role: 'tool';
  readonly toolCallId: string;
}

/**
 * A single message in a conversation (discriminated union by role).
 *
 * @example
 * ```ts
 * const msg: Message = { role: 'user', content: 'Hello' };
 * const assistantMsg: Message = { role: 'assistant', content: 'Hi', toolCalls: [] };
 * const toolMsg: Message = { role: 'tool', content: 'result', toolCallId: 'tc-1' };
 * ```
 */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** Metadata attached to a message for context management. */
export interface MessageMeta {
  readonly pinned?: boolean;
  readonly isFailureTrace?: boolean;
  readonly timestamp?: number;
  readonly tokens?: number;
}

/** A tool call request from the LLM. */
export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** Token usage from a single LLM call. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * Adapter interface for LLM providers.
 *
 * @example
 * ```ts
 * const adapter: AgentAdapter = {
 *   async chat(params) {
 *     // Call your LLM here
 *     return { message: { role: 'assistant', content: 'Hi' }, usage: { inputTokens: 10, outputTokens: 5 } };
 *   }
 * };
 * ```
 */
export interface AgentAdapter {
  chat(params: ChatParams): Promise<ChatResponse>;
  stream?(params: ChatParams): AsyncIterable<StreamChunk>;
  countTokens?(messages: readonly Message[]): Promise<number>;
}

/** Optional LLM configuration — adapter passes to provider. */
export interface LLMConfig {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly stopSequences?: readonly string[];
  readonly [key: string]: unknown;
}

/** Parameters for an LLM chat call. */
export interface ChatParams {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly signal?: AbortSignal;
  /** Optional LLM configuration — adapter passes to provider. */
  readonly config?: LLMConfig;
}

/** Response from an LLM chat call. */
export interface ChatResponse {
  readonly message: Message;
  readonly usage: TokenUsage;
}

/** A chunk from a streaming LLM response. */
export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_call_delta' | 'done';
  readonly text?: string;
  readonly toolCall?: Partial<ToolCallRequest>;
  readonly usage?: TokenUsage;
}

/** JSON Schema for tool parameters. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

/** JSON Schema definition (supported subset). */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}
