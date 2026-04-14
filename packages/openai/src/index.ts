/**
 * @harness-one/openai — OpenAI SDK adapter for harness-one.
 *
 * Provides a full AgentAdapter implementation backed by the OpenAI SDK,
 * with support for chat, streaming, and tool_calls handling.
 *
 * Works with any OpenAI-compatible API (Groq, DeepSeek, Together, Fireworks,
 * Perplexity, Mistral, Ollama, vLLM, LM Studio, etc.) via the baseURL option.
 *
 * @module
 */

import OpenAI from 'openai';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  Message,
  TokenUsage,
  ToolSchema,
} from 'harness-one/core';
import { HarnessError } from 'harness-one/core';
import type { Logger } from 'harness-one/observe';
import { safeWarn } from 'harness-one/observe';

const _providers: Record<string, { baseURL: string }> = {
  openrouter: { baseURL: 'https://openrouter.ai/api/v1' },
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  deepseek: { baseURL: 'https://api.deepseek.com' },
  together: { baseURL: 'https://api.together.xyz/v1' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1' },
  perplexity: { baseURL: 'https://api.perplexity.ai' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  ollama: { baseURL: 'http://localhost:11434/v1' },
};

/** Names reserved for built-in adapters; cannot be overridden without force. */
const BUILT_IN_PROVIDER_NAMES: ReadonlySet<string> = new Set(['openai', 'anthropic']);

/**
 * Keys that `LLMConfig.extra` may carry into the OpenAI Chat Completions API.
 *
 * Only parameters that are (a) documented in the OpenAI Chat Completions spec
 * and (b) safe-by-default (no auth, no routing, no callback URLs) are listed.
 * Unknown keys are filtered with a single warn by default; pass
 * `strictExtraAllowList: true` to the adapter to turn the filter into a hard
 * `ADAPTER_INVALID_EXTRA` failure — useful for prod builds that want any
 * provider-drift to surface as a test/CI failure.
 *
 * This list mirrors the symmetry with the Anthropic adapter's filter (T05) and
 * is intentionally narrower than the OpenAI SDK surface: callers needing
 * provider-specific knobs beyond this list should open a PR to expand it
 * (preferred) or supply a pre-configured `client` that embeds the knob.
 */
const OPENAI_EXTRA_ALLOW_LIST: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'response_format',
  'user',
  'service_tier',
  'parallel_tool_calls',
]);

/**
 * Filter a caller-supplied `LLMConfig.extra` payload against the OpenAI
 * allow-list.
 *
 * Behaviour:
 *  - Undefined / empty input → returns `{}` with no warning.
 *  - All keys allow-listed → returns the payload verbatim, no warning.
 *  - Some unknown keys, `strict` = false → returns the filtered subset and
 *    emits a single warn listing the rejected keys.
 *  - Any unknown key, `strict` = true → throws `HarnessError` with code
 *    `ADAPTER_INVALID_EXTRA`; nothing is forwarded.
 *
 * Kept package-local (not reused from anthropic) so each adapter owns its own
 * allow-list surface and can evolve independently.
 */
function filterExtra(
  extra: Readonly<Record<string, unknown>> | undefined,
  strict: boolean,
  logger: Pick<Logger, 'warn' | 'error'> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return {};

  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const key of Object.keys(extra)) {
    if (OPENAI_EXTRA_ALLOW_LIST.has(key)) {
      accepted[key] = extra[key];
    } else {
      rejected.push(key);
    }
  }

  if (rejected.length === 0) return accepted;

  if (strict) {
    throw new HarnessError(
      `OpenAI adapter: LLMConfig.extra contained keys not in the allow-list: ${rejected.join(', ')}`,
      'ADAPTER_INVALID_EXTRA',
      'Remove the offending keys, add them to OPENAI_EXTRA_ALLOW_LIST via a PR, or disable strictExtraAllowList.',
    );
  }

  const msg = `[harness-one/openai] LLMConfig.extra contained keys not in the allow-list and was filtered: ${rejected.join(', ')}. Pass strictExtraAllowList: true to fail instead of filtering.`;
  const meta = { rejectedKeys: rejected };
  if (logger !== undefined) {
    // A caller-supplied logger (even the Pick<> narrow one used by this
    // adapter) routes the warn itself; we only fall back to `safeWarn`'s
    // default redaction-enabled logger when none is provided.
    logger.warn(msg, meta);
  } else {
    safeWarn(undefined, msg, meta);
  }
  return accepted;
}

/**
 * Well-known OpenAI-compatible provider base URLs.
 *
 * Usage:
 *   createOpenAIAdapter({ ...providers.groq, apiKey: '...', model: 'llama-3.3-70b-versatile' })
 */
export const providers: Readonly<Record<string, { baseURL: string }>> = _providers;

/**
 * Register a custom OpenAI-compatible provider or override an existing one.
 *
 * SECURITY WARNING: This function mutates a module-scoped registry that
 * influences which base URL subsequent `createOpenAIAdapter({ ...providers.X })`
 * calls resolve to. It MUST only be called from trusted initialization code
 * (e.g. application bootstrap). Do NOT drive it from untrusted input (user
 * requests, config files fetched at runtime, etc.) — doing so would allow an
 * attacker to redirect API traffic (and bearer tokens) to an arbitrary host.
 *
 * Validation applied:
 *  - `config.baseURL` MUST parse as a valid URL (WHATWG `new URL`).
 *  - The scheme MUST be `https:` unless the host is `localhost` or
 *    `127.0.0.1` (for local-dev-only HTTP providers like Ollama / vLLM /
 *    LM Studio).
 *  - Built-in adapter names (`openai`, `anthropic`) are reserved. To
 *    deliberately override them, pass `{ force: true }` as the third argument.
 *
 * @throws {HarnessError} with code `INVALID_CONFIG` on any validation failure.
 */
export function registerProvider(
  name: string,
  config: { baseURL: string },
  options?: { readonly force?: boolean },
): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new HarnessError(
      'registerProvider: name must be a non-empty string',
      'INVALID_CONFIG',
      'Pass a non-empty provider name as the first argument.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(config.baseURL);
  } catch (err) {
    throw new HarnessError(
      `registerProvider: baseURL "${config.baseURL}" is not a valid URL`,
      'INVALID_CONFIG',
      'Pass a fully qualified absolute URL (including scheme), e.g. "https://api.example.com/v1".',
      err instanceof Error ? err : undefined,
    );
  }

  const isLocalDev = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalDev) {
    throw new HarnessError(
      `registerProvider: refusing non-HTTPS baseURL "${config.baseURL}"`,
      'INVALID_CONFIG',
      'Use an https:// URL. Plain http:// is only allowed for localhost / 127.0.0.1 development endpoints.',
    );
  }

  if (BUILT_IN_PROVIDER_NAMES.has(name) && !options?.force) {
    throw new HarnessError(
      `registerProvider: "${name}" is a reserved built-in provider name`,
      'INVALID_CONFIG',
      'Pick a different name, or pass { force: true } as the third argument to explicitly override the built-in.',
    );
  }

  _providers[name] = { baseURL: config.baseURL };
}

/** Configuration for the OpenAI adapter. */
export interface OpenAIAdapterConfig {
  /** A pre-configured OpenAI client instance. Takes precedence over apiKey/baseURL. */
  readonly client?: OpenAI;
  /** API key. Defaults to OPENAI_API_KEY env var. Used when client is not provided. */
  readonly apiKey?: string;
  /** Base URL for OpenAI-compatible APIs (e.g. Groq, DeepSeek). Used when client is not provided. */
  readonly baseURL?: string;
  /** Default HTTP headers. Used when client is not provided. */
  readonly defaultHeaders?: Record<string, string>;
  /** Model name. Defaults to 'gpt-4o'. */
  readonly model?: string;
  /**
   * Maximum number of retries for transient errors (429, 5xx).
   * Passed to the OpenAI SDK client at creation time. Defaults to 2 (SDK default).
   */
  readonly maxRetries?: number;
  /**
   * Optional logger used for non-fatal adapter warnings (e.g. missing token
   * usage in a stream chunk, malformed tool arguments). Defaults to the
   * global `console` if not provided. Library code SHOULD NOT write directly
   * to `console` — accept a logger so hosts can route/silence warnings.
   */
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
  /**
   * When true, any key in `LLMConfig.extra` that is not in the adapter's
   * allow-list raises `HarnessError { code: 'ADAPTER_INVALID_EXTRA' }` instead
   * of being silently filtered-with-warn. Intended for prod builds that want
   * provider-parameter drift to fail loudly in CI. Defaults to `false`.
   */
  readonly strictExtraAllowList?: boolean;
}

/** Convert a harness-one Message to OpenAI's chat completion message format. */
function toOpenAIMessage(
  msg: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (msg.role === 'tool' && msg.toolCallId) {
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId,
      content: msg.content,
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    };
  }

  if (msg.role === 'system') {
    return { role: 'system', content: msg.content };
  }

  if (msg.role === 'assistant') {
    return { role: 'assistant', content: msg.content };
  }

  return { role: 'user', content: msg.content };
}

/**
 * Convert a harness-one JsonSchema to OpenAI's FunctionParameters (Record<string, unknown>).
 *
 * OpenAI expects `Record<string, unknown>` for tool parameters.
 * Rather than using a double assertion (`as unknown as Record<string, unknown>`),
 * we explicitly map the known JsonSchema fields to produce a clean record.
 */
function toOpenAIParameters(schema: ToolSchema['parameters']): Record<string, unknown> {
  const result: Record<string, unknown> = { type: schema.type };
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
  return result;
}

/** Convert a harness-one ToolSchema to OpenAI's tool format. */
function toOpenAITool(
  tool: ToolSchema,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toOpenAIParameters(tool.parameters),
    },
  };
}

/**
 * Map OpenAI's usage to harness-one's TokenUsage.
 *
 * OpenAI exposes prompt-cache hits via the optional
 * `usage.prompt_tokens_details.cached_tokens` field (the newer Responses /
 * Chat Completions API shape). When present, we surface it as
 * `cacheReadTokens` so cost tracking in the core reflects cached-read savings.
 */
function toTokenUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): TokenUsage {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  const base: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
  if (typeof cachedTokens === 'number') {
    base.cacheReadTokens = cachedTokens;
  }
  return base;
}

/** Parse an OpenAI response choice into a harness-one Message. */
function toHarnessMessage(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
): Message {
  const msg = choice.message;
  const toolCalls = msg.tool_calls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));

  return {
    role: 'assistant',
    content: msg.content ?? '',
    ...(toolCalls && toolCalls.length > 0 && { toolCalls }),
  };
}

/**
 * Models for which we've already emitted a zero-token warning in non-stream
 * chat responses. Module-scoped so we dedupe across all adapter instances in
 * the process (same policy as stream path).
 */
const _zeroUsageWarnedModels: Set<string> = new Set();

/**
 * Create an AgentAdapter backed by the OpenAI SDK.
 *
 * Supports chat(), stream(), and tool_calls handling.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): AgentAdapter {
  const client: OpenAI = config.client ?? new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.defaultHeaders,
    maxRetries: config.maxRetries,
  });
  const model = config.model ?? 'gpt-4o';
  const strictExtra = config.strictExtraAllowList === true;
  const logger: Pick<Logger, 'warn' | 'error'> = config.logger ?? {
    warn: (msg: string, meta?: Record<string, unknown>): void => {
      if (meta && Object.keys(meta).length > 0) {
        console.warn(msg, meta);
      } else {
        console.warn(msg);
      }
    },
    error: (msg: string, meta?: Record<string, unknown>): void => {
      // Fallback logger routes to console.error by design — callers inject a
      // Logger to redirect library errors into structured logging.
      // eslint-disable-next-line no-console
      if (meta && Object.keys(meta).length > 0) console.error(msg, meta);
      // eslint-disable-next-line no-console
      else console.error(msg);
    },
  };

  return {
    name: `openai:${model}`,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map(toOpenAITool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        ...(params.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' as const } }),
        ...(params.responseFormat?.type === 'json_schema' && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: toOpenAIParameters(params.responseFormat.schema),
              ...(params.responseFormat.strict !== undefined && { strict: params.responseFormat.strict }),
            },
          },
        }),
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params (per provider-spec.md).
        // T06: filtered against OPENAI_EXTRA_ALLOW_LIST; unknown keys are
        // dropped-with-warn, or raise ADAPTER_INVALID_EXTRA under strictExtra.
        ...filterExtra(params.config?.extra, strictExtra, logger),
      }, { signal: params.signal });

      const choice = response.choices[0];
      if (!choice) {
        throw new HarnessError('OpenAI returned no choices', 'PROVIDER_ERROR', 'Check if the model and API key are valid');
      }

      // SPEC-015: warn once per model when non-stream usage data is missing.
      const usage = response.usage;
      const missingInput = usage?.prompt_tokens === undefined || usage?.prompt_tokens === null;
      const missingOutput = usage?.completion_tokens === undefined || usage?.completion_tokens === null;
      if ((missingInput || missingOutput) && !_zeroUsageWarnedModels.has(model)) {
        _zeroUsageWarnedModels.add(model);
        logger.warn(
          `[harness-one/openai] chat() response for model "${model}" had missing prompt/completion token counts — cost tracking will under-report. (This warning is emitted once per model.)`,
        );
      }

      return {
        message: toHarnessMessage(choice),
        usage: toTokenUsage(usage),
      };
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const stream = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map(toOpenAITool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        ...(params.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' as const } }),
        ...(params.responseFormat?.type === 'json_schema' && {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'response',
              schema: toOpenAIParameters(params.responseFormat.schema),
              ...(params.responseFormat.strict !== undefined && { strict: params.responseFormat.strict }),
            },
          },
        }),
        stream: true,
        stream_options: { include_usage: true },
        // Spec: LLMConfig.extra MUST be forwarded to the provider. Merge LAST
        // so caller-supplied unknown keys win over base params.
        // T06: filtered against OPENAI_EXTRA_ALLOW_LIST; unknown keys are
        // dropped-with-warn, or raise ADAPTER_INVALID_EXTRA under strictExtra.
        ...filterExtra(params.config?.extra, strictExtra, logger),
      }, { signal: params.signal });

      const toolCallAccum = new Map<
        string,
        { id: string; name: string; arguments: string }
      >();
      // Secondary map: index -> ID, so continuation chunks without an id field
      // can be resolved to the correct accumulator entry via their positional index.
      const indexToId = new Map<number, string>();

      // Safety limits to prevent OOM from malformed streams
      const MAX_TOOL_CALLS = 128;
      const MAX_TOOL_ARG_BYTES = 1_048_576; // 1MB

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // Determine the lookup key: prefer tc.id, fall back to index-to-ID map,
            // and finally generate a fallback ID from the index.
            const id = tc.id ?? indexToId.get(tc.index) ?? `tool_${tc.index}`;

            // Skip new tool calls beyond the safety limit
            if (toolCallAccum.size >= MAX_TOOL_CALLS && !toolCallAccum.has(id)) {
              continue;
            }

            let accum = toolCallAccum.get(id);
            if (!accum) {
              accum = { id, name: '', arguments: '' };
              toolCallAccum.set(id, accum);
            }
            // Update the index-to-ID mapping whenever we see an id for an index
            if (tc.id) {
              indexToId.set(tc.index, tc.id);
              accum.id = tc.id;
            }
            if (tc.function?.name) accum.name = tc.function.name;
            if (tc.function?.arguments) {
              // Skip arguments that would exceed the size limit
              if (accum.arguments.length + tc.function.arguments.length > MAX_TOOL_ARG_BYTES) {
                continue;
              }
              accum.arguments += tc.function.arguments;
            }

            yield {
              type: 'tool_call_delta',
              toolCall: {
                ...(accum.id ? { id: accum.id } : {}),
                ...(accum.name ? { name: accum.name } : {}),
                ...(tc.function?.arguments !== undefined && { arguments: tc.function.arguments }),
              },
            };
          }
        }

        // OpenAI sends usage data in the final stream chunk.
        // We emit 'done' and return immediately upon receiving it.
        // If OpenAI changes this behavior (e.g., sends usage before final chunk),
        // subsequent chunks would be silently dropped — review this logic if that happens.
        if (chunk.usage) {
          yield { type: 'done', usage: toTokenUsage(chunk.usage) };
          return; // usage chunk is the final event — don't emit another done
        }
      }

      // Only emit bare done if stream ended without a usage chunk
      logger.warn(
        '[harness-one/openai] Stream ended without usage data — token counts will be zero. This may affect cost tracking.',
      );
      yield {
        type: 'done' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

/**
 * Test-only: reset the module-scoped "zero-usage warn once" dedupe set.
 *
 * Library consumers should NOT need to call this. It exists so unit tests can
 * exercise the one-time-warn behaviour across multiple `it()` cases without
 * leaking state between tests.
 *
 * @internal
 */
export function _resetOpenAIWarnState(): void {
  _zeroUsageWarnedModels.clear();
}
