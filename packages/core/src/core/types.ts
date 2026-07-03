/**
 * Shared types for harness-one core module.
 *
 * These types define the contract that all other modules import.
 *
 * @module
 */

/**
 * Brand helper + `TraceId`/`SpanId`/`SessionId` branded-id types live in
 * `infra/brands.ts` so `infra/ids.ts` can reference them without
 * importing upward. This module re-exports the canonical definitions for
 * backward compatibility with the rest of the codebase.
 */
import type { Brand, TraceId, SpanId, SessionId } from '../infra/brands.js';
export type { Brand, TraceId, SpanId, SessionId };

/** Message role in the conversation. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Origin marker for content entering the conversation history. */
export type MessageProvenance =
  | 'user_input'
  | 'tool_result'
  | 'memory_restore'
  | 'rag_retrieved'
  | 'trusted_system'
  | 'unknown';

/** Supported inline image media types. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** A plain text content block. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Extended-thinking content block. Providers that return reasoning
 * content (e.g. Anthropic extended thinking) attach an integrity
 * `signature`; when the assistant message also carries tool calls the
 * block MUST be replayed verbatim (signature intact) on the next
 * request or the provider rejects the conversation.
 */
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string;
}

/**
 * Redacted-thinking block — opaque provider payload standing in for
 * reasoning the provider chose not to reveal. MUST be replayed verbatim.
 */
export interface RedactedThinkingBlock {
  readonly type: 'redacted_thinking';
  readonly data: string;
}

/** Inline image content block (user messages and tool results). */
export interface ImageBlock {
  readonly type: 'image';
  readonly source:
    | { readonly kind: 'base64'; readonly mediaType: ImageMediaType; readonly data: string }
    | { readonly kind: 'url'; readonly url: string };
}

/**
 * Discriminated content-block union (RFC-0001).
 *
 * `Message.content` remains the canonical **text projection**: when
 * `blocks` is present, `content` MUST equal the concatenation of its
 * `TextBlock.text` fields (see {@link blocksText}). Block-aware consumers
 * (provider adapters) read `blocks` for full fidelity; text-only
 * consumers (guardrails, token estimation, compression, redaction) keep
 * reading `content` unchanged.
 */
export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ImageBlock;

/**
 * Text projection of a block list — concatenated `TextBlock` text.
 * Non-text blocks (thinking, images) contribute nothing, matching the
 * invariant documented on {@link ContentBlock}.
 */
export function blocksText(blocks: readonly ContentBlock[]): string {
  let out = '';
  for (const block of blocks) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}

/** Base properties shared by all message types. */
interface BaseMessage {
  readonly content: string;
  /**
   * Optional full-fidelity content blocks (RFC-0001). When present,
   * `content` must be the text projection of these blocks. Additive and
   * optional — messages without block-shaped content omit it.
   */
  readonly blocks?: readonly ContentBlock[];
  readonly name?: string;
  readonly meta?: MessageMeta;
}

/**
 * A system message. An opaque `_trust` brand is recognised on the
 * session-restore path — host code mints trusted instances via
 * `createTrustedSystemMessage`; restored messages lacking the
 * brand are downgraded to `user` role so an attacker who can write to
 * the session store cannot elevate a user turn into a system prompt.
 * Fresh construction accepts either shape.
 */
export interface SystemMessage extends BaseMessage {
  readonly role: 'system';
  readonly _trust?: TrustedSystemBrand;
}

/**
 * Opaque brand proving a `SystemMessage` was minted by trusted host code
 * (boot-time factory authenticated by `HOST_SECRET`). Opaqueness
 * prevents consumers from forging the brand at construction time — the
 * only exported mint surface is `createTrustedSystemMessage`.
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
  readonly provenance?: MessageProvenance;
  readonly provenanceDetail?: string;
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

/**
 * A chunk from a streaming LLM response.
 *
 * `thinking_delta` carries an incremental reasoning fragment in
 * `thinking`; a provider that signs thinking blocks sends the signature
 * on (any of) the block's chunks — the aggregator keeps the last one
 * (RFC-0001).
 */
export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_call_delta' | 'thinking_delta' | 'done';
  readonly text?: string;
  readonly toolCall?: Partial<ToolCallRequest>;
  readonly thinking?: string;
  readonly signature?: string;
  /**
   * Opaque redacted-thinking payload on a `thinking_delta` chunk. Each
   * one becomes a complete `RedactedThinkingBlock` on the reconstructed
   * assistant message (replayed verbatim on the next request).
   */
  readonly redactedData?: string;
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
   * `options` is `Readonly<>` so the AgentLoop can hoist one frozen
   * options bag at construction time and reuse the reference across
   * iterations without paying for an `Object.assign` per batch, and
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

/**
 * Lifecycle status of an AgentLoop instance.
 *
 * - `idle` — constructed, never ran or last run torn down cleanly.
 * - `running` — currently inside `run()`.
 * - `completed` — last run ended with a normal `end_turn` (LLM stopped).
 * - `errored` — last run ended with `aborted`, `max_iterations`,
 *   `token_budget`, a guardrail block, or an adapter/tool error. Consumers
 *   that previously coupled their "success" branch to `status === 'completed'`
 *   keep working unchanged; the new state carves off the abnormal terminals
 *   so operators can distinguish them without inspecting the last event.
 * - `disposed` — `dispose()` has been called; the loop is torn down and
 *   must not be re-used.
 */
export type AgentLoopStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'errored'
  | 'disposed';
