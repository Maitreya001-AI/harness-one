// Install: npm install openai
//
// This example shows how to implement harness-one's AgentAdapter interface
// for the OpenAI SDK. The adapter translates between harness-one's unified
// message format and OpenAI's chat completions API.
//
// This adapter also works with any OpenAI-compatible provider:
// - Groq:       baseURL: 'https://api.groq.com/openai/v1'
// - DeepSeek:   baseURL: 'https://api.deepseek.com'
// - Together:   baseURL: 'https://api.together.xyz/v1'
// - Fireworks:  baseURL: 'https://api.fireworks.ai/inference/v1'
// - Perplexity: baseURL: 'https://api.perplexity.ai'
// - Mistral:    baseURL: 'https://api.mistral.ai/v1'
// - Ollama:     baseURL: 'http://localhost:11434/v1'

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

// ---------------------------------------------------------------------------
// Helpers: map harness-one types to OpenAI SDK types
// ---------------------------------------------------------------------------

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

  // Default: user
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

/** Map OpenAI's usage back to harness-one's TokenUsage. */
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

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Create an AgentAdapter backed by the OpenAI SDK.
 *
 * Usage:
 *   const adapter = createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY });
 *
 * @param config.maxRetries - Override SDK retry count for transient errors (429, 5xx).
 *   Defaults to 2 (OpenAI SDK default).
 */
export function createOpenAIAdapter(config: {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  maxRetries?: number;
}): AgentAdapter {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxRetries: config.maxRetries,
  });
  const model = config.model ?? 'gpt-4o';

  return {
    // -----------------------------------------------------------------------
    // chat(): single request/response
    // -----------------------------------------------------------------------
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        tools: params.tools?.map(toOpenAITool),
        temperature: params.config?.temperature,
        top_p: params.config?.topP,
        max_tokens: params.config?.maxTokens,
        stop: params.config?.stopSequences as string[] | undefined,
        signal: params.signal,
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

    // -----------------------------------------------------------------------
    // stream(): SSE streaming via async iterator
    // -----------------------------------------------------------------------
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const stream = await client.chat.completions.create({
        model,
        messages: params.messages.map(toOpenAIMessage),
        tools: params.tools?.map(toOpenAITool),
        temperature: params.config?.temperature,
        stream: true,
        signal: params.signal,
      });

      // Track partial tool calls by index
      const toolCallAccum = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        // Tool calls — OpenAI streams these incrementally by index
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

        // Usage is reported in the final chunk (when stream_options.include_usage is set)
        if (chunk.usage) {
          yield {
            type: 'done',
            usage: toTokenUsage(chunk.usage),
          };
        }
      }

      // Ensure a done chunk is always emitted
      yield { type: 'done' };
    },
  };
}
