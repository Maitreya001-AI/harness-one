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

/**
 * Well-known OpenAI-compatible provider base URLs.
 *
 * Usage:
 *   createOpenAIAdapter({ ...providers.groq, apiKey: '...', model: 'llama-3.3-70b-versatile' })
 */
export const providers = {
  openrouter: { baseURL: 'https://openrouter.ai/api/v1' },
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  deepseek: { baseURL: 'https://api.deepseek.com' },
  together: { baseURL: 'https://api.together.xyz/v1' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1' },
  perplexity: { baseURL: 'https://api.perplexity.ai' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  ollama: { baseURL: 'http://localhost:11434/v1' },
} as const;

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

/** Map OpenAI's usage to harness-one's TokenUsage. */
function toTokenUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
): TokenUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
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

  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map(toOpenAITool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.maxTokens !== undefined && { max_tokens: params.config.maxTokens }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
      }, { signal: params.signal });

      const choice = response.choices[0];
      if (!choice) {
        throw new HarnessError('OpenAI returned no choices', 'PROVIDER_ERROR', 'Check if the model and API key are valid');
      }

      return {
        message: toHarnessMessage(choice),
        usage: toTokenUsage(response.usage),
      };
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const stream = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        ...(params.tools && { tools: params.tools.map(toOpenAITool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop: params.config.stopSequences as string[] }),
        stream: true,
      }, { signal: params.signal });

      const toolCallAccum = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let accum = toolCallAccum.get(tc.index);
            if (!accum) {
              accum = { id: tc.id ?? '', name: '', arguments: '' };
              toolCallAccum.set(tc.index, accum);
            }
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name = tc.function.name;
            if (tc.function?.arguments) {
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
      yield {
        type: 'done' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
