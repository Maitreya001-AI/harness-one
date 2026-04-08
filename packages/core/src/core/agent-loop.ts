/**
 * AgentLoop — the core agent execution loop.
 *
 * Calls the LLM adapter in a loop, dispatching tool calls and feeding results
 * back until the LLM stops requesting tools, or a safety valve triggers.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolCallRequest, ToolSchema } from './types.js';
import type { AgentEvent, DoneReason } from './events.js';
import { AbortedError, MaxIterationsError, TokenBudgetExceededError } from './errors.js';

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  readonly adapter: AgentAdapter;
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly tools?: ToolSchema[];
  readonly maxConversationMessages?: number;
  readonly streaming?: boolean;
}

/**
 * Stateful agent loop that calls an LLM adapter in a loop, handling tool calls.
 *
 * @example
 * ```ts
 * const loop = new AgentLoop({ adapter, onToolCall: handleTool });
 * for await (const event of loop.run(messages)) {
 *   console.log(event.type);
 * }
 * ```
 */
export class AgentLoop {
  private readonly adapter: AgentAdapter;
  private readonly maxIterations: number;
  private readonly maxTotalTokens: number;
  private readonly externalSignal?: AbortSignal;
  private readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  private readonly tools?: ToolSchema[];
  private readonly maxConversationMessages?: number;
  private readonly streaming: boolean;

  private abortController: AbortController;
  private aborted = false;
  private cumulativeUsage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };

  constructor(config: AgentLoopConfig) {
    this.adapter = config.adapter;
    this.maxIterations = config.maxIterations ?? 25;
    this.maxTotalTokens = config.maxTotalTokens ?? Infinity;
    this.externalSignal = config.signal;
    this.onToolCall = config.onToolCall;
    this.tools = config.tools;
    this.maxConversationMessages = config.maxConversationMessages;
    this.streaming = config.streaming ?? false;

    // H3: Create internal AbortController; link to external signal if provided
    this.abortController = new AbortController();
    if (this.externalSignal) {
      if (this.externalSignal.aborted) {
        this.abortController.abort();
      } else {
        this.externalSignal.addEventListener('abort', () => {
          this.abortController.abort();
        }, { once: true });
      }
    }
  }

  /** Get cumulative token usage across all iterations. */
  get usage(): TokenUsage {
    return {
      inputTokens: this.cumulativeUsage.inputTokens,
      outputTokens: this.cumulativeUsage.outputTokens,
    };
  }

  /** Abort the loop at the next safe point and cancel in-flight adapter calls. */
  abort(): void {
    this.aborted = true;
    // H3: Also abort the internal controller to cancel in-flight adapter.chat() calls
    this.abortController.abort();
  }

  /**
   * Run the agent loop, yielding events as they occur.
   *
   * @example
   * ```ts
   * for await (const event of loop.run(messages)) {
   *   if (event.type === 'done') break;
   * }
   * ```
   */
  async *run(messages: Message[]): AsyncGenerator<AgentEvent> {
    const conversation = [...messages];
    let iteration = 0;
    let yieldedDone = false;

    try {
      while (true) {
        // Check abort
        if (this.isAborted()) {
          yield { type: 'error', error: new AbortedError() };
          yieldedDone = true;
          yield this.doneEvent('aborted');
          return;
        }

        // Check max iterations
        iteration++;
        if (iteration > this.maxIterations) {
          const err = new MaxIterationsError(this.maxIterations);
          yield { type: 'error', error: err };
          yieldedDone = true;
          yield this.doneEvent('max_iterations');
          return;
        }

        // Check token budget before calling LLM
        const totalTokens = this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
        if (totalTokens > this.maxTotalTokens) {
          const err = new TokenBudgetExceededError(totalTokens, this.maxTotalTokens);
          yield { type: 'error', error: err };
          yieldedDone = true;
          yield this.doneEvent('token_budget');
          return;
        }

        // H4: Check conversation length and emit warning if exceeded
        if (this.maxConversationMessages !== undefined && conversation.length > this.maxConversationMessages) {
          yield {
            type: 'warning',
            message: `Conversation length (${conversation.length}) exceeds maxConversationMessages (${this.maxConversationMessages}). Consider summarizing or trimming.`,
          };
        }

        yield { type: 'iteration_start', iteration };

        // C5: Wrap adapter call in try-catch to handle exceptions gracefully
        let assistantMsg: Message;
        let responseUsage: TokenUsage;

        if (this.streaming && this.adapter.stream) {
          // Streaming path: use adapter.stream()
          const streamResult = yield* this.handleStream(conversation, iteration);
          if (!streamResult) {
            // Stream error already handled via error event
            yieldedDone = true;
            yield this.doneEvent('error');
            return;
          }
          assistantMsg = streamResult.message;
          responseUsage = streamResult.usage;
        } else {
          // Non-streaming path: use adapter.chat()
          try {
            const response = await this.adapter.chat({
              messages: conversation,
              signal: this.abortController.signal,
              tools: this.tools,
            });
            assistantMsg = response.message;
            responseUsage = response.usage;
          } catch (err) {
            // C5: Emit error event and break gracefully
            yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
            yieldedDone = true;
            yield this.doneEvent('error');
            return;
          }
        }

        // Check abort after adapter call (abort() may have been called during in-flight request)
        if (this.isAborted()) {
          yield { type: 'error', error: new AbortedError() };
          yieldedDone = true;
          yield this.doneEvent('aborted');
          return;
        }

        // Accumulate usage (clamp to non-negative to prevent underflow bypass)
        this.cumulativeUsage.inputTokens += Math.max(0, responseUsage.inputTokens);
        this.cumulativeUsage.outputTokens += Math.max(0, responseUsage.outputTokens);

        // H2: Check token budget immediately after accumulating tokens
        const postCallTokens = this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
        if (postCallTokens > this.maxTotalTokens) {
          // Budget exceeded after this response; emit message (for content) then stop
          yield { type: 'message', message: assistantMsg, usage: responseUsage };
          const err = new TokenBudgetExceededError(postCallTokens, this.maxTotalTokens);
          yield { type: 'error', error: err };
          yieldedDone = true;
          yield this.doneEvent('token_budget');
          return;
        }

        const toolCalls = assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined;

        // If no tool calls or empty tool calls -> end turn
        if (!toolCalls || toolCalls.length === 0) {
          yield { type: 'message', message: assistantMsg, usage: responseUsage };
          yieldedDone = true;
          yield this.doneEvent('end_turn');
          return;
        }

        // Process tool calls
        conversation.push(assistantMsg);

        for (const toolCall of toolCalls) {
          yield { type: 'tool_call', toolCall, iteration };

          let result: unknown;
          try {
            if (this.onToolCall) {
              result = await this.onToolCall(toolCall);
            } else {
              result = { error: `No onToolCall handler registered for tool "${toolCall.name}"` };
            }
          } catch (err) {
            if (err instanceof Error) {
              result = {
                error: err.message,
              };
            } else {
              result = {
                error: String(err),
              };
            }
          }

          yield { type: 'tool_result', toolCallId: toolCall.id, result };

          // Add tool result as a message
          const toolResultMsg: Message = {
            role: 'tool',
            content: typeof result === 'string' ? result : JSON.stringify(result),
            toolCallId: toolCall.id,
          };
          conversation.push(toolResultMsg);
        }

        // Check abort after tool calls
        if (this.isAborted()) {
          yield { type: 'error', error: new AbortedError() };
          yieldedDone = true;
          yield this.doneEvent('aborted');
          return;
        }
      }
    } finally {
      if (!yieldedDone) {
        // Generator was closed externally via .return() or .throw()
        // Mark as aborted for cleanup
        this.aborted = true;
      }
    }
  }

  /**
   * Handle streaming response from adapter.stream().
   * Yields text_delta and tool_call_delta events, accumulates the full response.
   * Returns the accumulated message and usage, or null on error.
   */
  /** Maximum accumulated stream content size (10 MB) to prevent memory exhaustion. */
  private static readonly MAX_STREAM_BYTES = 10 * 1024 * 1024;

  private async *handleStream(
    conversation: Message[],
    _iteration: number,
  ): AsyncGenerator<AgentEvent, { message: Message; usage: TokenUsage } | null> {
    let accumulatedText = '';
    let accumulatedBytes = 0;
    const accumulatedToolCalls: Map<string, { id: string; name: string; arguments: string }> = new Map();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      const stream = this.adapter.stream!({
        messages: conversation,
        signal: this.abortController.signal,
        tools: this.tools,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'text_delta' && chunk.text) {
          accumulatedBytes += chunk.text.length;
          if (accumulatedBytes > AgentLoop.MAX_STREAM_BYTES) {
            yield { type: 'error', error: new Error(`Stream exceeded maximum size (${AgentLoop.MAX_STREAM_BYTES} bytes)`) };
            return null;
          }
          accumulatedText += chunk.text;
          yield { type: 'text_delta', text: chunk.text };
        } else if (chunk.type === 'tool_call_delta' && chunk.toolCall) {
          const partial = chunk.toolCall;
          yield { type: 'tool_call_delta', toolCall: partial };

          // Accumulate tool call parts
          if (partial.arguments) {
            accumulatedBytes += partial.arguments.length;
            if (accumulatedBytes > AgentLoop.MAX_STREAM_BYTES) {
              yield { type: 'error', error: new Error(`Stream exceeded maximum size (${AgentLoop.MAX_STREAM_BYTES} bytes)`) };
              return null;
            }
          }

          if (partial.id) {
            const existing = accumulatedToolCalls.get(partial.id);
            if (existing) {
              if (partial.name) existing.name = partial.name;
              if (partial.arguments) existing.arguments += partial.arguments;
            } else {
              accumulatedToolCalls.set(partial.id, {
                id: partial.id,
                name: partial.name ?? '',
                arguments: partial.arguments ?? '',
              });
            }
          } else {
            // If no id, try to append to the last tool call
            const entries = [...accumulatedToolCalls.values()];
            if (entries.length > 0) {
              const last = entries[entries.length - 1];
              if (partial.name) last.name = partial.name;
              if (partial.arguments) last.arguments += partial.arguments;
            }
          }
        } else if (chunk.type === 'done') {
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
      return null;
    }

    const toolCalls: ToolCallRequest[] = [...accumulatedToolCalls.values()];

    const message: Message = {
      role: 'assistant',
      content: accumulatedText,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return { message, usage };
  }

  private isAborted(): boolean {
    return this.aborted || this.abortController.signal.aborted;
  }

  private doneEvent(reason: DoneReason): AgentEvent {
    return { type: 'done', reason, totalUsage: this.usage };
  }
}
