/**
 * Shared types for harness-one core module.
 *
 * These types define the contract that all other modules import.
 *
 * @module
 */

/** Message role in the conversation. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A single message in a conversation.
 *
 * @example
 * ```ts
 * const msg: Message = { role: 'user', content: 'Hello' };
 * ```
 */
export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: ToolCallRequest[];
  readonly meta?: MessageMeta;
}

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

/** Parameters for an LLM chat call. */
export interface ChatParams {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly signal?: AbortSignal;
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
