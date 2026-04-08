// Install: npm install @anthropic-ai/sdk
//
// This example shows how to implement harness-one's AgentAdapter interface
// for the Anthropic SDK. The adapter maps between harness-one's message format
// and Anthropic's API, keeping the external dependency isolated to this file.

import Anthropic from '@anthropic-ai/sdk';
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
// Helpers: map harness-one types to Anthropic SDK types
// ---------------------------------------------------------------------------

/** Convert a harness-one Message to the Anthropic message format. */
function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
  // Tool result messages map to Anthropic's tool_result content blocks
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

  // Assistant messages with tool calls map to tool_use content blocks
  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: JSON.parse(tc.arguments),
      });
    }
    return { role: 'assistant', content };
  }

  // Regular user/assistant messages
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

/** Extract the system prompt from the message array (Anthropic uses a separate field). */
function extractSystem(messages: readonly Message[]): {
  system: string | undefined;
  rest: Message[];
} {
  const system = messages.find((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system: system?.content, rest };
}

/** Map Anthropic's usage response back to harness-one's TokenUsage. */
function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    // Anthropic reports cache usage when prompt caching is enabled
    cacheReadTokens: (usage as Record<string, number>).cache_read_input_tokens ?? 0,
    cacheWriteTokens: (usage as Record<string, number>).cache_creation_input_tokens ?? 0,
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
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ---------------------------------------------------------------------------
// The adapter — this is the injection point
// ---------------------------------------------------------------------------

/**
 * Create an AgentAdapter backed by the Anthropic SDK.
 *
 * Usage:
 *   const adapter = createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   // Pass to any harness-one function that accepts an AgentAdapter
 *
 * @param config.maxRetries - Override SDK retry count for transient errors (429, 5xx).
 *   Alternatively, configure retries on the Anthropic client directly:
 *   `new Anthropic({ maxRetries: 5 })`.
 */
export function createAnthropicAdapter(config: {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
}): AgentAdapter {
  const client = new Anthropic({ apiKey: config.apiKey, maxRetries: config.maxRetries });
  const model = config.model ?? 'claude-sonnet-4-20250514';

  return {
    // -----------------------------------------------------------------------
    // chat(): single request/response
    // -----------------------------------------------------------------------
    async chat(params: ChatParams): Promise<ChatResponse> {
      const { system, rest } = extractSystem(params.messages);

      const response = await client.messages.create({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        system: system ?? undefined,
        messages: rest.map(toAnthropicMessage),
        tools: params.tools?.map(toAnthropicTool),
        temperature: params.config?.temperature,
        top_p: params.config?.topP,
        stop_sequences: params.config?.stopSequences as string[] | undefined,
      }, { signal: params.signal });

      return {
        message: toHarnessMessage(response),
        usage: toTokenUsage(response.usage),
      };
    },

    // -----------------------------------------------------------------------
    // stream(): SSE streaming via async iterator
    // -----------------------------------------------------------------------
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const { system, rest } = extractSystem(params.messages);

      const stream = client.messages.stream({
        model,
        max_tokens: params.config?.maxTokens ?? 4096,
        system: system ?? undefined,
        messages: rest.map(toAnthropicMessage),
        tools: params.tools?.map(toAnthropicTool),
        temperature: params.config?.temperature,
      }, { signal: params.signal });

      // Accumulate tool call state across content_block events
      let currentToolId: string | undefined;
      let currentToolName: string | undefined;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            yield {
              type: 'tool_call_delta',
              toolCall: {
                id: currentToolId,
                name: currentToolName,
                arguments: delta.partial_json,
              },
            };
          }
        } else if (event.type === 'message_delta') {
          // Intentionally not yielding done here; finalMessage() below provides
          // the complete, accurate usage data in a single done event.
        }
      }

      // Emit exactly one done chunk using the final, complete usage from the SDK.
      const finalMessage = await stream.finalMessage();
      yield { type: 'done', usage: toTokenUsage(finalMessage.usage) };
    },
  };
}
