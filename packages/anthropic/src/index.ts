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

/** Configuration for the Anthropic adapter. */
export interface AnthropicAdapterConfig {
  /** A pre-configured Anthropic client instance. */
  readonly client: Anthropic;
  /** Model name. Defaults to 'claude-sonnet-4-20250514'. */
  readonly model?: string;
  /**
   * Maximum number of retries for transient errors (429, 5xx).
   * The Anthropic SDK handles retries at the client level.
   * Configure via `new Anthropic({ maxRetries: N })` when creating the client.
   * @default 2 (SDK default)
   */
  readonly maxRetries?: number;
}

/** Convert a harness-one Message to the Anthropic message format. */
function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
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
      let input: unknown;
      try { input = JSON.parse(tc.arguments); } catch { input = tc.arguments; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: input as Record<string, unknown>,
      });
    }
    return { role: 'assistant', content };
  }

  return {
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  };
}

/** Convert a harness-one ToolSchema to Anthropic's tool format. */
function toAnthropicTool(tool: ToolSchema): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
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

/** Map Anthropic's usage response to harness-one's TokenUsage. */
function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  const ext = usage as unknown as Record<string, unknown>;
  const cacheRead = typeof ext?.cache_read_input_tokens === 'number'
    ? ext.cache_read_input_tokens : 0;
  const cacheCreate = typeof ext?.cache_creation_input_tokens === 'number'
    ? ext.cache_creation_input_tokens : 0;
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

  return {
    async chat(params: ChatParams): Promise<ChatResponse> {
      const { system, rest } = extractSystem(params.messages);

      const response = await client.messages.create({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        ...(system !== undefined && { system }),
        messages: rest.map(toAnthropicMessage),
        ...(params.tools && { tools: params.tools.map(toAnthropicTool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
      }, { signal: params.signal });

      if (!response.content || response.content.length === 0) {
        throw new Error('Anthropic API returned empty content');
      }

      return {
        message: toHarnessMessage(response),
        usage: toTokenUsage(response.usage),
      };
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const { system, rest } = extractSystem(params.messages);

      const stream = client.messages.stream({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        ...(system !== undefined && { system }),
        messages: rest.map(toAnthropicMessage),
        ...(params.tools && { tools: params.tools.map(toAnthropicTool) }),
        ...(params.config?.temperature !== undefined && { temperature: params.config.temperature }),
        ...(params.config?.topP !== undefined && { top_p: params.config.topP }),
        ...(params.config?.stopSequences !== undefined && { stop_sequences: params.config.stopSequences as string[] }),
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

      const finalMessage = await stream.finalMessage();
      yield { type: 'done', usage: toTokenUsage(finalMessage.usage) };
    },
  };
}
