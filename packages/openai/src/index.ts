/**
 * @harness-one/openai — OpenAI SDK adapter for harness-one.
 *
 * Provides a full AgentAdapter implementation backed by the OpenAI SDK,
 * with support for chat, streaming, and tool_calls handling.
 *
 * @module
 */

import type OpenAI from 'openai';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  Message,
  TokenUsage,
  ToolSchema,
} from 'harness-one/core';

/** Configuration for the OpenAI adapter. */
export interface OpenAIAdapterConfig {
  /** A pre-configured OpenAI client instance. */
  readonly client: OpenAI;
  /** Model name. Defaults to 'gpt-4o'. */
  readonly model?: string;
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
      content: msg.content || null,
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

/** Convert a harness-one ToolSchema to OpenAI's tool format. */
function toOpenAITool(
  tool: ToolSchema,
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
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
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Create an AgentAdapter backed by the OpenAI SDK.
 *
 * Supports chat(), stream(), and tool_calls handling.
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): AgentAdapter {
  const { client } = config;
  const model = config.model ?? 'gpt-4o';

  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        tools: params.tools?.map(toOpenAITool),
        temperature: params.config?.temperature,
        top_p: params.config?.topP,
        max_tokens: params.config?.maxTokens,
        stop: params.config?.stopSequences as string[] | undefined,
      });

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('OpenAI returned no choices');
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
        tools: params.tools?.map(toOpenAITool),
        temperature: params.config?.temperature,
        stream: true,
      });

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
                id: accum.id || undefined,
                name: accum.name || undefined,
                arguments: tc.function?.arguments,
              },
            };
          }
        }

        if (chunk.usage) {
          yield { type: 'done', usage: toTokenUsage(chunk.usage) };
        }
      }

      yield { type: 'done' };
    },
  };
}
