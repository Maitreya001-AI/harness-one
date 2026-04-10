/**
 * AgentLoop — the core agent execution loop.
 *
 * Calls the LLM adapter in a loop, dispatching tool calls and feeding results
 * back until the LLM stops requesting tools, or a safety valve triggers.
 *
 * @module
 */

import type { AgentAdapter, ExecutionStrategy, Message, TokenUsage, ToolCallRequest, ToolSchema } from './types.js';
import type { AgentEvent, DoneReason } from './events.js';
import { AbortedError, HarnessError, MaxIterationsError, TokenBudgetExceededError } from './errors.js';
import { createSequentialStrategy, createParallelStrategy } from './execution-strategies.js';

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
  readonly parallel?: boolean;
  readonly maxParallelToolCalls?: number;
  readonly executionStrategy?: ExecutionStrategy;
  readonly isSequentialTool?: (name: string) => boolean;
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
  private readonly externalSignal?: AbortSignal | undefined;
  private readonly onToolCall?: ((call: ToolCallRequest) => Promise<unknown>) | undefined;
  private readonly tools?: ToolSchema[] | undefined;
  private readonly maxConversationMessages?: number | undefined;
  private readonly streaming: boolean;
  private readonly executionStrategy: ExecutionStrategy;
  private readonly isSequentialTool?: ((name: string) => boolean) | undefined;

  private abortController: AbortController;
  private cumulativeUsage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  private _iteration = 0;
  private _totalToolCalls = 0;
  private _status: 'idle' | 'running' | 'completed' | 'disposed' = 'idle';

  // If executionStrategy is explicitly provided, it takes precedence over the parallel flag.
  // parallel: true is a shorthand that creates a default parallel strategy.
  constructor(config: AgentLoopConfig) {
    this.adapter = config.adapter;
    this.maxIterations = config.maxIterations ?? 25;
    this.maxTotalTokens = config.maxTotalTokens ?? Infinity;
    this.externalSignal = config.signal;
    this.onToolCall = config.onToolCall;
    this.tools = config.tools;
    this.maxConversationMessages = config.maxConversationMessages;
    this.streaming = config.streaming ?? false;
    this.isSequentialTool = config.isSequentialTool;

    if (config.executionStrategy) {
      this.executionStrategy = config.executionStrategy;
    } else if (config.parallel) {
      this.executionStrategy = createParallelStrategy({
        maxConcurrency: config.maxParallelToolCalls ?? 5,
      });
    } else {
      this.executionStrategy = createSequentialStrategy();
    }

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
    this.abortController.abort();
  }

  /** Dispose the loop, releasing resources and cancelling any pending operations. */
  dispose(): void {
    this._status = 'disposed';
    this.abortController.abort();
  }

  /** Get a snapshot of the loop's current metrics. */
  getMetrics(): { iteration: number; totalToolCalls: number; usage: TokenUsage } {
    return {
      iteration: this._iteration,
      totalToolCalls: this._totalToolCalls,
      usage: this.usage,
    };
  }

  /** Current lifecycle status of the loop. */
  get status(): 'idle' | 'running' | 'completed' | 'disposed' {
    return this._status;
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
    this._status = 'running';
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
        this._iteration = iteration;
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

        // H4: Check conversation length and prune if exceeded
        if (this.maxConversationMessages !== undefined && conversation.length > this.maxConversationMessages) {
          yield {
            type: 'warning',
            message: `Conversation pruned from ${conversation.length} to ${this.maxConversationMessages} messages`,
          };
          // Keep first message (system) + last (maxConversationMessages - 1) messages
          const head = conversation.slice(0, 1);
          const tail = conversation.slice(-(this.maxConversationMessages - 1));
          conversation.length = 0;
          conversation.push(...head, ...tail);
        }

        yield { type: 'iteration_start', iteration };

        // C5: Wrap adapter call in try-catch to handle exceptions gracefully
        let assistantMsg: Message;
        let responseUsage: TokenUsage;

        if (this.streaming && this.adapter.stream) {
          // Streaming path: use adapter.stream()
          const streamResult = yield* this.handleStream(conversation);
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
              ...(this.tools !== undefined && { tools: this.tools }),
            });
            assistantMsg = response.message;
            responseUsage = response.usage;
          } catch (err) {
            // C5: Emit error event and break gracefully
            yield { type: 'error', error: err instanceof HarnessError ? err : new HarnessError(
              err instanceof Error ? err.message : String(err),
              AgentLoop.categorizeAdapterError(err),
              'Check adapter configuration and API credentials',
              err instanceof Error ? err : undefined,
            ) };
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

        // Process tool calls via execution strategy
        conversation.push(assistantMsg);

        // Yield all tool_call events first (deterministic ordering)
        for (const toolCall of toolCalls) {
          yield { type: 'tool_call', toolCall, iteration };
        }

        // Execute via strategy
        const executionResults = await this.executionStrategy.execute(
          toolCalls,
          async (call) => {
            if (this.onToolCall) {
              return this.onToolCall(call);
            }
            return { error: `No onToolCall handler registered for tool "${call.name}"` };
          },
          Object.assign(
            { signal: this.abortController.signal },
            this.isSequentialTool
              ? { getToolMeta: (name: string) => ({ sequential: this.isSequentialTool!(name) }) }
              : {},
          ),
        );

        // Yield all tool_result events in original order (deterministic)
        for (const execResult of executionResults) {
          yield { type: 'tool_result', toolCallId: execResult.toolCallId, result: execResult.result };
          this._totalToolCalls++;

          let resultContent: string;
          try {
            resultContent = typeof execResult.result === 'string'
              ? execResult.result
              : JSON.stringify(execResult.result);
          } catch {
            resultContent = '[Object could not be serialized]';
          }

          const toolResultMsg: Message = {
            role: 'tool',
            content: resultContent,
            toolCallId: execResult.toolCallId,
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
        this.abortController.abort();
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
  ): AsyncGenerator<AgentEvent, { message: Message; usage: TokenUsage } | null> {
    let accumulatedText = '';
    let accumulatedBytes = 0;
    const accumulatedToolCalls: Map<string, { id: string; name: string; arguments: string }> = new Map();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      const stream = this.adapter.stream!({
        messages: conversation,
        signal: this.abortController.signal,
        ...(this.tools !== undefined && { tools: this.tools }),
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
            } else {
              yield { type: 'warning', message: 'Received partial tool call chunk without ID and no accumulated calls' };
            }
          }
        } else if (chunk.type === 'done') {
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof HarnessError ? err : new HarnessError(
        err instanceof Error ? err.message : String(err),
        AgentLoop.categorizeAdapterError(err),
        'Check adapter configuration and API credentials',
        err instanceof Error ? err : undefined,
      ) };
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

  private static categorizeAdapterError(err: unknown): string {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (msg.includes('rate') || msg.includes('429') || msg.includes('too many')) return 'ADAPTER_RATE_LIMIT';
    if (msg.includes('auth') || msg.includes('401') || msg.includes('api key') || msg.includes('unauthorized')) return 'ADAPTER_AUTH';
    if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch')) return 'ADAPTER_NETWORK';
    if (msg.includes('parse') || msg.includes('json') || msg.includes('malformed')) return 'ADAPTER_PARSE';
    return 'ADAPTER_ERROR';
  }

  private isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  private doneEvent(reason: DoneReason): AgentEvent {
    this._status = 'completed';
    return { type: 'done', reason, totalUsage: this.usage };
  }
}
