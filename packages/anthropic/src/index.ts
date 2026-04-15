/**
 * @harness-one/anthropic — Anthropic SDK adapter for harness-one.
 *
 * Provides a full AgentAdapter implementation backed by the Anthropic SDK,
 * with support for chat, streaming, and tool_use handling.
 *
 * @module
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  Message,
  TokenUsage,
  ToolSchema,
} from 'harness-one/core';
import { HarnessError, HarnessErrorCode} from 'harness-one/core';
import { safeWarn, createDefaultLogger, type Logger } from 'harness-one/observe';

/**
 * T05 (Wave-5A): Allow-list of `LLMConfig.extra` keys that are safe to forward
 * verbatim to the Anthropic Messages API. Any key outside this set is filtered
 * out (with a single `safeWarn` emission) in non-strict mode, or rejected with
 * a `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)` when `strictExtraAllowList: true`.
 *
 * Rationale: prior to T05, `extra` was spread into the request body unchecked,
 * which made it trivial for callers (or upstream preset chains) to leak vendor
 * keys, arbitrary fields, or typos to the provider. The allow-list is the
 * minimum viable surface to keep SPEC-005 forwarding useful without the
 * shotgun risk.
 */
const ANTHROPIC_EXTRA_ALLOW_LIST = new Set<string>([
  'temperature',
  'top_k',
  'top_p',
  'stop_sequences',
  'thinking',
  'metadata',
  'system',
]);

/** Configuration for the Anthropic adapter. */
export interface AnthropicAdapterConfig {
  /** A pre-configured Anthropic client instance. */
  readonly client: Anthropic;
  /** Model name. Defaults to 'claude-sonnet-4-20250514'. */
  readonly model?: string;
  /**
   * Optional logger used for non-fatal adapter warnings (e.g. malformed
   * tool_use JSON from the model). Defaults to the global `console` if not
   * provided. Library code SHOULD NOT write directly to `console` — accept a
   * logger so hosts can route/silence warnings.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
  /**
   * T05 (Wave-5A): when `true`, unknown keys in `LLMConfig.extra` cause
   * `chat()`/`stream()` to throw `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)`
   * before contacting the provider. Defaults to `false` — unknown keys are
   * silently filtered and reported via a single `safeWarn` emission so the
   * caller can notice without breaking their pipeline.
   */
  readonly strictExtraAllowList?: boolean;
}

/**
 * T05 (Wave-5A): Filter `extra` against the Anthropic allow-list.
 *
 * - Returns `undefined` when the input is `undefined` (pure pass-through,
 *   zero side effects).
 * - Returns the filtered subset plus a single `safeWarn` emission when keys
 *   are rejected and `strict === false`.
 * - Throws `HarnessError(HarnessErrorCode.ADAPTER_INVALID_EXTRA)` when keys are rejected
 *   and `strict === true`.
 *
 * The `logger` parameter is structurally compatible with `safeWarn`'s
 * `Logger | undefined` signature at runtime (only `.warn` is invoked); we
 * widen via a single cast at the call site to avoid forcing adapter callers
 * to supply a full `Logger` when they only care about `warn`/`error`.
 */
function filterExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  strict: boolean,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const filtered: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (ANTHROPIC_EXTRA_ALLOW_LIST.has(k)) {
      filtered[k] = v;
    } else {
      rejected.push(k);
    }
  }
  if (rejected.length === 0) return filtered;
  if (strict) {
    throw new HarnessError(
      `Anthropic adapter: extra contains keys outside the allow-list: ${rejected.join(', ')}`,
      HarnessErrorCode.ADAPTER_INVALID_EXTRA,
      'Remove the listed keys from LLMConfig.extra, or set strictExtraAllowList=false to filter-and-warn instead of throwing.',
    );
  }
  // `safeWarn` accepts `Logger | undefined`; our adapter type is a narrower
  // `Pick<Logger, 'warn' | 'error'>`. At runtime `safeWarn` only invokes
  // `target.warn(msg, meta)`, so the cast is sound.
  safeWarn(logger as Logger | undefined, 'anthropic adapter: extra keys filtered', { rejected });
  return filtered;
}

// Default logger now delegates to core's `createDefaultLogger()` singleton,
// which redacts secret keys and writes a structured `{level, msg, meta}` line
// to stdout. Replaces the hand-rolled console.warn/error fallback (Wave-5F T12).

/** Convert a harness-one Message to the Anthropic message format. */
function toAnthropicMessage(
  msg: Message,
  logger: Pick<Logger, 'warn' | 'error'>,
): Anthropic.MessageParam {
  if (msg.role === 'tool' && msg.toolCallId) {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content,
        },
      ],
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const content: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      // Narrow to object shape — silently casting a string to Record<string, unknown>
      // would hide LLM output corruption. When JSON is invalid or not an object,
      // pass an empty object and let the tool execution fail loudly on missing keys.
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(tc.arguments);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        } else {
          logger.warn(
            `[harness-one/anthropic] tool_use input for "${tc.name}" was not a JSON object (got ${typeof parsed}); substituting empty object.`,
          );
        }
      } catch {
        logger.warn(
          `[harness-one/anthropic] tool_use input for "${tc.name}" was not valid JSON; substituting empty object. Raw arguments may be truncated or malformed.`,
        );
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      });
    }
    return { role: 'assistant', content };
  }

  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  };
}

/**
 * Convert a harness-one JsonSchema to Anthropic's Tool.InputSchema.
 *
 * Anthropic expects `{ type: 'object'; properties?: unknown; [k: string]: unknown }`.
 * Rather than casting with `as Anthropic.Tool.InputSchema`, we explicitly map
 * the known JsonSchema fields to produce a conforming object.
 */
function toAnthropicInputSchema(schema: ToolSchema['parameters']): Anthropic.Tool.InputSchema {
  const result: Record<string, unknown> = { type: schema.type as 'object' };
  if (schema.properties !== undefined) result.properties = schema.properties;
  if (schema.required !== undefined) result.required = schema.required;
  if (schema.items !== undefined) result.items = schema.items;
  if (schema.enum !== undefined) result.enum = schema.enum;
  if (schema.description !== undefined) result.description = schema.description;
  if (schema.default !== undefined) result.default = schema.default;
  if (schema.minimum !== undefined) result.minimum = schema.minimum;
  if (schema.maximum !== undefined) result.maximum = schema.maximum;
  if (schema.minLength !== undefined) result.minLength = schema.minLength;
  if (schema.maxLength !== undefined) result.maxLength = schema.maxLength;
  if (schema.pattern !== undefined) result.pattern = schema.pattern;
  if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties;
  if (schema.oneOf !== undefined) result.oneOf = schema.oneOf;
  if (schema.anyOf !== undefined) result.anyOf = schema.anyOf;
  if (schema.allOf !== undefined) result.allOf = schema.allOf;
  if (schema.const !== undefined) result.const = schema.const;
  if (schema.format !== undefined) result.format = schema.format;
  return result as Anthropic.Tool.InputSchema;
}

/** Convert a harness-one ToolSchema to Anthropic's tool format. */
function toAnthropicTool(tool: ToolSchema): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toAnthropicInputSchema(tool.parameters),
  };
}

/** Extract the system prompt from the message array. */
function extractSystem(messages: readonly Message[]): {
  system: string | undefined;
  rest: Message[];
} {
  const system = messages.find((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system: system?.content, rest };
}

/**
 * Map Anthropic's usage response to harness-one's TokenUsage.
 *
 * Anthropic's Usage type may include cache_read_input_tokens and
 * cache_creation_input_tokens fields that are not in the base type definition.
 * We safely extract them using 'in' checks instead of a double assertion.
 */
function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  const cacheRead = 'cache_read_input_tokens' in usage
    && typeof usage.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens : 0;
  const cacheCreate = 'cache_creation_input_tokens' in usage
    && typeof usage.cache_creation_input_tokens === 'number'
    ? usage.cache_creation_input_tokens : 0;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheCreate,
  };
}

/** Parse Anthropic's response content blocks into a harness-one Message. */
function toHarnessMessage(response: Anthropic.Message): Message {
  const textParts: string[] = [];
  const toolCalls: { id: string; name: string; arguments: string }[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  return {
    role: 'assistant',
    content: textParts.join(''),
    ...(toolCalls.length > 0 && { toolCalls }),
  };
}

/**
 * Create an AgentAdapter backed by the Anthropic SDK.
 *
 * Supports chat(), stream(), and full tool_use handling.
 */
export function createAnthropicAdapter(config: AnthropicAdapterConfig): AgentAdapter {
  const { client } = config;
  const model = config.model ?? 'claude-sonnet-4-20250514';
  const logger: Pick<Logger, 'warn' | 'error'> = config.logger ?? createDefaultLogger();
  const strictExtra = config.strictExtraAllowList ?? false;

  return {
    name: `anthropic:${model}`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const { system, rest } = extractSystem(params.messages);

      // T05: filter `extra` against Anthropic allow-list BEFORE spreading.
      // Under strict mode this throws before any network call.
      const safeExtra = filterExtra(params.config?.extra, strictExtra, config.logger);

      const response = await client.messages.create({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        ...(system !== undefined && { system }),
        messages: rest.map((m) => toAnthropicMessage(m, logger)),
        ...(params.tools && { tools: params.tools.map(toAnthropicTool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params (per provider-spec.md).
        // T05: only allow-listed keys are forwarded; see ANTHROPIC_EXTRA_ALLOW_LIST.
        ...(safeExtra ?? {}),
      }, { signal: params.signal });

      if (!response.content || response.content.length === 0) {
        throw new HarnessError('Anthropic API returned empty content', HarnessErrorCode.ADAPTER_ERROR, 'Check if the model and API key are valid');
      }

      return {
        message: toHarnessMessage(response),
        usage: toTokenUsage(response.usage),
      };
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const { system, rest } = extractSystem(params.messages);

      // T05: filter `extra` against Anthropic allow-list BEFORE calling stream().
      // Under strict mode this throws before the HTTP request is initiated, which
      // is also why the tests assert `mock.stream` was NOT invoked.
      const safeExtra = filterExtra(params.config?.extra, strictExtra, config.logger);

      const stream = client.messages.stream({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        ...(system !== undefined && { system }),
        messages: rest.map((m) => toAnthropicMessage(m, logger)),
        ...(params.tools && { tools: params.tools.map(toAnthropicTool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params.
        // T05: only allow-listed keys are forwarded; see ANTHROPIC_EXTRA_ALLOW_LIST.
        ...(safeExtra ?? {}),
      }, { signal: params.signal });

      let currentToolId: string | undefined;
      let currentToolName: string | undefined;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
          } else {
            // Reset tool state when a non-tool block starts
            currentToolId = undefined;
            currentToolName = undefined;
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            yield {
              type: 'tool_call_delta',
              toolCall: {
                ...(currentToolId !== undefined && { id: currentToolId }),
                ...(currentToolName !== undefined && { name: currentToolName }),
                arguments: delta.partial_json,
              },
            };
          }
        } else if (event.type === 'message_delta') {
          // Intentionally not yielding done here; finalMessage() below provides
          // the complete, accurate usage data in a single done event.
        }
      }

      let finalMsg: Anthropic.Message;
      try {
        finalMsg = await stream.finalMessage();
      } catch (err) {
        // CQ-003: Do NOT silently swallow. Two legitimate cases exist:
        //  1. The caller aborted via an external AbortSignal. In that case,
        //     emit a terminal zero-usage done chunk so downstream iteration
        //     terminates cleanly without losing the signal semantics.
        //  2. Anything else is a real provider-side failure (network blip,
        //     500, malformed final message, etc.) and MUST propagate up as a
        //     typed HarnessError with `cause` preserved for observability.
        if (params.signal?.aborted === true) {
          yield {
            type: 'done',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
          return;
        }
        throw new HarnessError(
          'Anthropic stream failed before finalMessage() resolved',
          HarnessErrorCode.ADAPTER_ERROR,
          'The provider stream ended abnormally. Check network connectivity and provider status; retry if transient.',
          err instanceof Error ? err : undefined,
        );
      }
      yield { type: 'done', usage: toTokenUsage(finalMsg.usage) };
    },
  };
}
