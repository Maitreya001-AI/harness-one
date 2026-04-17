/**
 * Shared types for harness-one core module.
 *
 * These types define the contract that all other modules import.
 *
 * @module
 */

/**
 * Brand helper + `TraceId`/`SpanId`/`SessionId` branded-id types live in
 * `infra/brands.ts` (Wave-15) so `infra/ids.ts` can reference them without
 * importing upward. This module re-exports the canonical definitions for
 * backward compatibility with the rest of the codebase.
 */
import type { Brand, TraceId, SpanId, SessionId } from '../infra/brands.js';
export type { Brand, TraceId, SpanId, SessionId };

/** Message role in the conversation. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Base properties shared by all message types. */
interface BaseMessage {
  readonly content: string;
  readonly name?: string;
  readonly meta?: MessageMeta;
}

/**
 * A system message. Wave-5E (SEC-A07) adds an opaque `_trust` brand
 * recognised on the session-restore path — host code mints trusted
 * instances via {@link createTrustedSystemMessage}; restored messages
 * lacking the brand are downgraded to `user` role so an attacker who
 * can write to the session store cannot elevate a user turn into a
 * system prompt. Fresh construction accepts either shape.
 */
export interface SystemMessage extends BaseMessage {
  readonly role: 'system';
  readonly _trust?: TrustedSystemBrand;
}

/**
 * Opaque brand proving a `SystemMessage` was minted by trusted host code
 * (boot-time factory authenticated by {@link HOST_SECRET}). Opaqueness
 * prevents consumers from forging the brand at construction time — the
 * only exported mint surface is {@link createTrustedSystemMessage}.
 */
export type TrustedSystemBrand = Brand<symbol, 'TrustedSystemBrand'>;

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
  /**
   * Identifier for the adapter (e.g., `"anthropic"`, `"openai"`). Used as the
   * `adapter` attribute on iteration spans and as the `model` fallback when
   * usage is missing. Optional for backwards compatibility; built-in adapters
   * set this.
   */
  readonly name?: string;
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
  /** Provider-specific configuration passed through to the underlying SDK. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Requested response format for structured output.
 *
 * - `text`: default free-form text
 * - `json_object`: request valid JSON output
 * - `json_schema`: request JSON conforming to a specific schema
 */
export type ResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | { readonly type: 'json_schema'; readonly schema: JsonSchema; readonly strict?: boolean };

/** Parameters for an LLM chat call. */
export interface ChatParams {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly signal?: AbortSignal;
  /** Optional LLM configuration — adapter passes to provider. */
  readonly config?: LLMConfig;
  /** Request structured output from the LLM. */
  readonly responseFormat?: ResponseFormat;
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
  readonly responseFormat?: 'concise' | 'detailed';
}

/** Supported JSON Schema type values. */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** JSON Schema definition (supported subset). */
export interface JsonSchema {
  type: JsonSchemaType;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  /** Minimum value for number/integer types. */
  minimum?: number;
  /** Maximum value for number/integer types. */
  maximum?: number;
  /** Minimum string length for string type. */
  minLength?: number;
  /** Maximum string length for string type. */
  maxLength?: number;
  /** Regex pattern for string type validation. */
  pattern?: string;
  /** Whether additional properties are allowed (object type), or a schema for them. */
  additionalProperties?: boolean | JsonSchema;
  /** Matches exactly one of the given schemas. */
  oneOf?: JsonSchema[];
  /** Matches any of the given schemas. */
  anyOf?: JsonSchema[];
  /** Matches all of the given schemas. */
  allOf?: JsonSchema[];
  /** Constant value the instance must equal. */
  const?: unknown;
  /** Semantic format hint (e.g., 'email', 'date-time'). */
  format?: string;
}

/** Result of executing a single tool call within a batch. */
export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly result: unknown;
}

/** Strategy for executing a batch of tool calls. */
export interface ExecutionStrategy {
  /**
   * Execute a batch of tool calls.
   *
   * Wave-5B Step 3 (M-5): `options` is `Readonly<>` so the AgentLoop can hoist
   * one frozen options bag at construction time and reuse the reference across
   * iterations without paying for an `Object.assign` per batch (PERF-025) and
   * without risk of a strategy mutating shared state.
   */
  execute(
    calls: readonly ToolCallRequest[],
    handler: (call: ToolCallRequest) => Promise<unknown>,
    options?: Readonly<{
      getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
      signal?: AbortSignal;
    }>,
  ): Promise<readonly ToolExecutionResult[]>;
}

/** Lifecycle status of an AgentLoop instance. */
export type AgentLoopStatus = 'idle' | 'running' | 'completed' | 'disposed';
