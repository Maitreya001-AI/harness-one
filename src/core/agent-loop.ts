/**
 * AgentLoop — the core agent execution loop.
 *
 * Calls the LLM adapter in a loop, dispatching tool calls and feeding results
 * back until the LLM stops requesting tools, or a safety valve triggers.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolCallRequest } from './types.js';
import type { AgentEvent, DoneReason } from './events.js';
import { AbortedError, MaxIterationsError, TokenBudgetExceededError } from './errors.js';

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  readonly adapter: AgentAdapter;
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
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
  private readonly signal?: AbortSignal;
  private readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;

  private aborted = false;
  private cumulativeUsage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };

  constructor(config: AgentLoopConfig) {
    this.adapter = config.adapter;
    this.maxIterations = config.maxIterations ?? 25;
    this.maxTotalTokens = config.maxTotalTokens ?? Infinity;
    this.signal = config.signal;
    this.onToolCall = config.onToolCall;
  }

  /** Get cumulative token usage across all iterations. */
  get usage(): TokenUsage {
    return {
      inputTokens: this.cumulativeUsage.inputTokens,
      outputTokens: this.cumulativeUsage.outputTokens,
    };
  }

  /** Abort the loop at the next safe point. */
  abort(): void {
    this.aborted = true;
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

    while (true) {
      // Check abort
      if (this.isAborted()) {
        yield { type: 'error', error: new AbortedError() };
        yield this.doneEvent('aborted');
        return;
      }

      // Check max iterations
      iteration++;
      if (iteration > this.maxIterations) {
        const err = new MaxIterationsError(this.maxIterations);
        yield { type: 'error', error: err };
        yield this.doneEvent('max_iterations');
        return;
      }

      // Check token budget before calling LLM
      const totalTokens = this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
      if (totalTokens > this.maxTotalTokens) {
        const err = new TokenBudgetExceededError(totalTokens, this.maxTotalTokens);
        yield { type: 'error', error: err };
        yield this.doneEvent('token_budget');
        return;
      }

      yield { type: 'iteration_start', iteration };

      // Call adapter
      const response = await this.adapter.chat({
        messages: conversation,
        signal: this.signal,
      });

      // Accumulate usage
      this.cumulativeUsage.inputTokens += response.usage.inputTokens;
      this.cumulativeUsage.outputTokens += response.usage.outputTokens;

      const assistantMsg = response.message;
      const toolCalls = assistantMsg.toolCalls;

      // If no tool calls or empty tool calls → end turn
      if (!toolCalls || toolCalls.length === 0) {
        yield { type: 'message', message: assistantMsg, usage: response.usage };
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
          // Errors as Feedback: serialize error and feed back to LLM
          result = {
            error: err instanceof Error ? err.message : String(err),
          };
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
        yield this.doneEvent('aborted');
        return;
      }
    }
  }

  private isAborted(): boolean {
    return this.aborted || (this.signal?.aborted ?? false);
  }

  private doneEvent(reason: DoneReason): AgentEvent {
    return { type: 'done', reason, totalUsage: this.usage };
  }
}
