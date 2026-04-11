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

/**
 * Minimal tracing interface accepted by AgentLoop.
 *
 * Structurally compatible with the full `TraceManager` from the observe module
 * so that consumers can pass one directly without importing it into the core
 * module (avoids a circular dependency between core and observe).
 */
export interface AgentLoopTraceManager {
  startTrace(name: string, metadata?: Record<string, unknown>): string;
  startSpan(traceId: string, name: string, parentId?: string): string;
  setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void;
  endSpan(spanId: string, status?: 'completed' | 'error'): void;
  endTrace(traceId: string, status?: 'completed' | 'error'): void;
}

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  readonly adapter: AgentAdapter;
  readonly maxIterations?: number;
  readonly maxTotalTokens?: number;
  readonly signal?: AbortSignal;
  /**
   * Callback invoked when the LLM requests a tool call.
   *
   * Returns `Promise<unknown>` intentionally: tool results are inherently
   * dynamic — each tool produces its own result shape (string, object, error
   * envelope, etc.), and the AgentLoop serializes the result to a string for
   * the LLM regardless of type. Typing this more narrowly would force every
   * tool handler to conform to a single return type, which would be incorrect.
   *
   * The AgentLoop treats the resolved value as opaque data: it is stringified
   * via `JSON.stringify` (or `.toString()` for non-objects) and fed back as a
   * tool-result message.
   */
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly tools?: ToolSchema[];
  readonly maxConversationMessages?: number;
  readonly streaming?: boolean;
  readonly parallel?: boolean;
  readonly maxParallelToolCalls?: number;
  /**
   * Custom execution strategy for tool calls.
   *
   * When provided, this strategy takes precedence over the `parallel` flag.
   * If omitted, a default strategy is selected automatically:
   * - `parallel: true` creates a default parallel strategy (with
   *   `maxParallelToolCalls` concurrency).
   * - Otherwise a sequential strategy is used.
   *
   * Inject a custom strategy to control ordering, batching, retries,
   * or any other execution concern without modifying the AgentLoop itself.
   *
   * @example
   * ```ts
   * const loop = new AgentLoop({
   *   adapter,
   *   executionStrategy: myCustomStrategy,
   * });
   * ```
   */
  readonly executionStrategy?: ExecutionStrategy;
  readonly isSequentialTool?: (name: string) => boolean;
  /**
   * Optional trace manager for automatic observability.
   *
   * When provided, `run()` automatically creates a trace on start, a span for
   * each iteration, child spans for each tool call, and ends the trace on
   * completion. This wires the AgentLoop to the observability layer without
   * requiring manual instrumentation.
   */
  readonly traceManager?: AgentLoopTraceManager;
  /**
   * Optional timeout in milliseconds for individual tool executions.
   *
   * When set, any tool call that does not resolve within this duration
   * is aborted with a timeout error and the result is fed back to the LLM.
   */
  readonly toolTimeoutMs?: number;
  /**
   * Maximum accumulated stream content size in bytes per iteration.
   *
   * Defaults to 10 MB (10 * 1024 * 1024). Set a lower value to reduce
   * memory pressure when processing large streaming responses.
   */
  readonly maxStreamBytes?: number;
  /**
   * Maximum size in bytes for a single tool-call's accumulated arguments.
   *
   * Defaults to 5 MB (5 * 1024 * 1024). Prevents oversized payloads from
   * being forwarded to tool handlers.
   */
  readonly maxToolArgBytes?: number;
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
  private readonly traceManager?: AgentLoopTraceManager | undefined;
  private readonly toolTimeoutMs?: number | undefined;
  private readonly maxStreamBytes: number;
  private readonly maxToolArgBytes: number;

  private abortController: AbortController;
  private _externalAbortHandler: (() => void) | undefined;
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
    this.maxConversationMessages = config.maxConversationMessages ?? 200;
    this.streaming = config.streaming ?? false;
    this.isSequentialTool = config.isSequentialTool;
    this.traceManager = config.traceManager;
    this.toolTimeoutMs = config.toolTimeoutMs;
    this.maxStreamBytes = config.maxStreamBytes ?? AgentLoop.MAX_STREAM_BYTES;
    this.maxToolArgBytes = config.maxToolArgBytes ?? AgentLoop.MAX_TOOL_ARG_BYTES;

    if (config.executionStrategy) {
      this.executionStrategy = config.executionStrategy;
    } else if (config.parallel) {
      this.executionStrategy = createParallelStrategy({
        maxConcurrency: config.maxParallelToolCalls ?? 5,
      });
    } else {
      this.executionStrategy = createSequentialStrategy();
    }

    // H3: Create internal AbortController (external signal linking deferred to run())
    this.abortController = new AbortController();
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
    // Remove external signal listener to prevent memory leaks when the external
    // signal outlives this loop instance.
    if (this._externalAbortHandler && this.externalSignal) {
      this.externalSignal.removeEventListener('abort', this._externalAbortHandler);
      this._externalAbortHandler = undefined;
    }
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
    let finalEventEmitted = false;

    // Attach external signal listener at run() start (not constructor) so it
    // is always cleaned up in the finally block, even if dispose() is never called.
    if (this.externalSignal) {
      if (this.externalSignal.aborted) {
        this.abortController.abort();
      } else {
        this._externalAbortHandler = () => {
          this.abortController.abort();
        };
        this.externalSignal.addEventListener('abort', this._externalAbortHandler, { once: true });
      }
    }

    // Auto-tracing: create a trace for this run when a traceManager is wired.
    const tm = this.traceManager;
    const traceId = tm ? tm.startTrace('agent-loop-run', { messageCount: messages.length }) : undefined;
    let iterationSpanId: string | undefined;
    // Cumulative stream byte counter across all iterations for DoS protection
    let cumulativeStreamBytes = 0;
    const maxCumulativeStreamBytes = this.maxIterations * this.maxStreamBytes;

    try {
      while (true) {
        // Check abort
        if (this.isAborted()) {
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          yield { type: 'error', error: new AbortedError() };
          finalEventEmitted = true;
          yield this.doneEvent('aborted');
          return;
        }

        // Check max iterations
        iteration++;
        this._iteration = iteration;
        if (iteration > this.maxIterations) {
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          const err = new MaxIterationsError(this.maxIterations);
          yield { type: 'error', error: err };
          finalEventEmitted = true;
          yield this.doneEvent('max_iterations');
          return;
        }

        // Check token budget before calling LLM
        const totalTokens = this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
        if (totalTokens > this.maxTotalTokens) {
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          const err = new TokenBudgetExceededError(totalTokens, this.maxTotalTokens);
          yield { type: 'error', error: err };
          finalEventEmitted = true;
          yield this.doneEvent('token_budget');
          return;
        }

        // H4: Check conversation length and prune if exceeded
        if (this.maxConversationMessages !== undefined && conversation.length > this.maxConversationMessages) {
          yield {
            type: 'warning',
            message: `Conversation pruned from ${conversation.length} to ${this.maxConversationMessages} messages`,
          };
          // Preserve all leading system messages (there may be 0 or more)
          let systemCount = 0;
          while (systemCount < conversation.length && conversation[systemCount].role === 'system') {
            systemCount++;
          }
          const head = conversation.slice(0, Math.max(1, systemCount));
          const tailSize = this.maxConversationMessages - head.length;
          const tail = conversation.slice(-Math.max(1, tailSize));
          conversation.length = 0;
          conversation.push(...head, ...tail);
        }

        // End previous iteration span if one is still open
        if (iterationSpanId && tm) { tm.endSpan(iterationSpanId); iterationSpanId = undefined; }

        // Start a new span for this iteration
        if (tm && traceId) {
          iterationSpanId = tm.startSpan(traceId, `iteration-${iteration}`);
        }

        yield { type: 'iteration_start', iteration };

        // C5: Wrap adapter call in try-catch to handle exceptions gracefully
        let assistantMsg: Message;
        let responseUsage: TokenUsage;

        if (this.streaming && this.adapter.stream) {
          // Streaming path: use adapter.stream()
          const streamResult = yield* this.handleStream(conversation, cumulativeStreamBytes, maxCumulativeStreamBytes);
          if (streamResult) {
            cumulativeStreamBytes += streamResult.bytesRead;
          } else {
            // Stream error already handled via error event.
            // Reset cumulativeStreamBytes to prevent phantom accumulation from
            // a failed/aborted stream that only partially wrote data.
            cumulativeStreamBytes = 0;
            if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
            finalEventEmitted = true;
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
            if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
            yield { type: 'error', error: err instanceof HarnessError ? err : new HarnessError(
              err instanceof Error ? err.message : String(err),
              AgentLoop.categorizeAdapterError(err),
              'Check adapter configuration and API credentials',
              err instanceof Error ? err : undefined,
            ) };
            finalEventEmitted = true;
            yield this.doneEvent('error');
            return;
          }
        }

        // Record usage on the iteration span
        if (iterationSpanId && tm) {
          tm.setSpanAttributes(iterationSpanId, {
            inputTokens: responseUsage.inputTokens,
            outputTokens: responseUsage.outputTokens,
          });
        }

        // Check abort after adapter call (abort() may have been called during in-flight request)
        if (this.isAborted()) {
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          yield { type: 'error', error: new AbortedError() };
          finalEventEmitted = true;
          yield this.doneEvent('aborted');
          return;
        }

        // Accumulate usage (clamp to safe bounds to prevent underflow bypass or overflow from buggy adapters)
        const safeInput = Math.min(Math.max(0, responseUsage.inputTokens), 1_000_000_000);
        const safeOutput = Math.min(Math.max(0, responseUsage.outputTokens), 1_000_000_000);
        this.cumulativeUsage.inputTokens += safeInput;
        this.cumulativeUsage.outputTokens += safeOutput;

        // H2: Check token budget immediately after accumulating tokens
        const postCallTokens = this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
        if (postCallTokens > this.maxTotalTokens) {
          // Budget exceeded after this response; emit message (for content) then stop
          yield { type: 'message', message: assistantMsg, usage: responseUsage };
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          const err = new TokenBudgetExceededError(postCallTokens, this.maxTotalTokens);
          yield { type: 'error', error: err };
          finalEventEmitted = true;
          yield this.doneEvent('token_budget');
          return;
        }

        const toolCalls = assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined;

        // If no tool calls or empty tool calls -> end turn
        if (!toolCalls || toolCalls.length === 0) {
          yield { type: 'message', message: assistantMsg, usage: responseUsage };
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId); iterationSpanId = undefined; }
          finalEventEmitted = true;
          yield this.doneEvent('end_turn');
          return;
        }

        // Process tool calls via execution strategy
        conversation.push(assistantMsg);

        // Yield all tool_call events first (deterministic ordering)
        for (const toolCall of toolCalls) {
          yield { type: 'tool_call', toolCall, iteration };
        }

        // Execute via strategy, with optional per-tool-call tracing
        const executionResults = await this.executionStrategy.execute(
          toolCalls,
          async (call) => {
            // Create a child span for each tool call when tracing is enabled
            const toolSpanId = (tm && traceId && iterationSpanId)
              ? tm.startSpan(traceId, `tool:${call.name}`, iterationSpanId)
              : undefined;
            try {
              const toolPromise = this.onToolCall
                ? this.onToolCall(call)
                : Promise.resolve({ error: `No onToolCall handler registered for tool "${call.name}"` });

              let result: unknown;
              if (this.toolTimeoutMs !== undefined) {
                // Race tool execution against a timeout
                const timeoutMs = this.toolTimeoutMs;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const timeoutPromise = new Promise<{ error: string }>((resolve) => {
                    timer = setTimeout(
                      () => resolve({ error: `Tool "${call.name}" timed out after ${timeoutMs}ms` }),
                      timeoutMs,
                    );
                    // Ensure timer doesn't keep the process alive
                    if (typeof timer === 'object' && 'unref' in timer) {
                      (timer as NodeJS.Timeout).unref();
                    }
                  });
                  result = await Promise.race([toolPromise, timeoutPromise]);
                } finally {
                  // Always clear the timer to prevent it from running after the
                  // tool resolves, avoiding resource waste and phantom callbacks.
                  if (timer !== undefined) clearTimeout(timer);
                }
              } else {
                result = await toolPromise;
              }

              if (toolSpanId && tm) { tm.endSpan(toolSpanId); }
              return result;
            } catch (toolErr) {
              if (toolSpanId && tm) { tm.endSpan(toolSpanId, 'error'); }
              throw toolErr;
            }
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
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          yield { type: 'error', error: new AbortedError() };
          finalEventEmitted = true;
          yield this.doneEvent('aborted');
          return;
        }
      }
    } finally {
      // Clean up external signal listener to prevent memory leaks even if
      // dispose() is never called. This is the primary cleanup path.
      if (this._externalAbortHandler && this.externalSignal) {
        this.externalSignal.removeEventListener('abort', this._externalAbortHandler);
        this._externalAbortHandler = undefined;
      }
      // End any open iteration span
      if (iterationSpanId && tm) {
        try { tm.endSpan(iterationSpanId, 'error'); } catch { /* span may already be ended */ }
      }
      // End the trace
      if (traceId && tm) {
        try { tm.endTrace(traceId, finalEventEmitted ? 'completed' : 'error'); } catch { /* trace may already be ended */ }
      }
      if (!finalEventEmitted) {
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
  static readonly MAX_STREAM_BYTES = 10 * 1024 * 1024;
  /** Maximum size per tool-call argument (5 MB) to prevent oversized payloads. */
  private static readonly MAX_TOOL_ARG_BYTES = 5 * 1024 * 1024;

  private async *handleStream(
    conversation: Message[],
    cumulativeStreamBytes: number,
    maxCumulativeStreamBytes: number,
  ): AsyncGenerator<AgentEvent, { message: Message; usage: TokenUsage; bytesRead: number } | null> {
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
          if (accumulatedBytes > this.maxStreamBytes) {
            yield { type: 'error', error: new Error(`Stream exceeded maximum size (${this.maxStreamBytes} bytes)`) };
            return null;
          }
          // Cumulative cross-iteration check
          if (cumulativeStreamBytes + accumulatedBytes > maxCumulativeStreamBytes) {
            yield { type: 'error', error: new Error('Cumulative stream size exceeded maximum across all iterations') };
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
            if (accumulatedBytes > this.maxStreamBytes) {
              yield { type: 'error', error: new Error(`Stream exceeded maximum size (${this.maxStreamBytes} bytes)`) };
              return null;
            }
            // Cumulative cross-iteration check
            if (cumulativeStreamBytes + accumulatedBytes > maxCumulativeStreamBytes) {
              yield { type: 'error', error: new Error('Cumulative stream size exceeded maximum across all iterations') };
              return null;
            }
          }

          if (partial.id) {
            const existing = accumulatedToolCalls.get(partial.id);
            if (existing) {
              if (partial.name) existing.name = partial.name;
              if (partial.arguments) existing.arguments += partial.arguments;
              // Per-tool-call argument size limit
              if (existing.arguments.length > this.maxToolArgBytes) {
                yield { type: 'error', error: new Error(`Tool call "${existing.name}" arguments exceeded maximum size (${this.maxToolArgBytes} bytes)`) };
                return null;
              }
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
              // Per-tool-call argument size limit
              if (last.arguments.length > this.maxToolArgBytes) {
                yield { type: 'error', error: new Error(`Tool call "${last.name}" arguments exceeded maximum size (${this.maxToolArgBytes} bytes)`) };
                return null;
              }
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

    return { message, usage, bytesRead: accumulatedBytes };
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
