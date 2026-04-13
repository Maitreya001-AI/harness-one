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
import { categorizeAdapterError } from './error-classifier.js';
import { pruneConversation } from './conversation-pruner.js';

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
  /**
   * Record a timestamped event within a span — used by AgentLoop to record
   * adapter retries and other diagnostic markers without creating child spans.
   */
  addSpanEvent(spanId: string, event: { name: string; attributes?: Record<string, unknown> }): void;
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
  /**
   * Maximum number of retries for retryable adapter errors (e.g. rate-limit).
   *
   * Defaults to 0 (no retries). Set to a positive number to enable automatic
   * retry with exponential backoff for retryable errors.
   */
  readonly maxAdapterRetries?: number;
  /**
   * Base delay in milliseconds for exponential backoff between retries.
   *
   * Actual delay is `baseRetryDelayMs * 2^attempt + jitter`.
   * Defaults to 1000.
   */
  readonly baseRetryDelayMs?: number;
  /**
   * Error categories eligible for retry.
   *
   * Defaults to `['ADAPTER_RATE_LIMIT']`. Set to include `'ADAPTER_NETWORK'`
   * to also retry transient network errors.
   */
  readonly retryableErrors?: readonly string[];
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
  private readonly executionStrategy: ExecutionStrategy;
  private readonly isSequentialTool?: (name: string) => boolean;
  private readonly traceManager?: AgentLoopTraceManager;
  private readonly toolTimeoutMs?: number;
  private readonly maxStreamBytes: number;
  private readonly maxToolArgBytes: number;
  private readonly maxAdapterRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly retryableErrors: readonly string[];

  private abortController: AbortController;
  private _externalAbortHandler: (() => void) | undefined;
  /** Tracks the error category from the last failed handleStream call for retry decisions. */
  private _lastStreamErrorCategory: string | undefined;
  /**
   * PERF-025: Pre-built options bag handed to `executionStrategy.execute()`
   * for every tool-call batch. Previously this object was re-constructed with
   * `Object.assign({signal}, isSequentialTool ? {getToolMeta} : {})` inside
   * the hot loop, producing one allocation per tool batch. Building it once
   * at construction time — after `abortController` and `isSequentialTool`
   * settle — lets us reuse the same frozen reference across all batches.
   */
  private readonly _strategyOptions: {
    readonly signal: AbortSignal;
    readonly getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
  };
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
    // CQ-035: Under `exactOptionalPropertyTypes`, these optional fields are
    // typed as `readonly field?: Type` (no explicit `| undefined`). Assign
    // only when the source value is defined so we never set the property to
    // `undefined` — leaving it absent instead.
    if (config.signal !== undefined) this.externalSignal = config.signal;
    if (config.onToolCall !== undefined) this.onToolCall = config.onToolCall;
    if (config.tools !== undefined) this.tools = config.tools;
    this.maxConversationMessages = config.maxConversationMessages ?? 200;
    this.streaming = config.streaming ?? false;
    if (config.isSequentialTool !== undefined) this.isSequentialTool = config.isSequentialTool;
    if (config.traceManager !== undefined) this.traceManager = config.traceManager;
    if (config.toolTimeoutMs !== undefined) this.toolTimeoutMs = config.toolTimeoutMs;
    this.maxStreamBytes = config.maxStreamBytes ?? AgentLoop.MAX_STREAM_BYTES;
    this.maxToolArgBytes = config.maxToolArgBytes ?? AgentLoop.MAX_TOOL_ARG_BYTES;
    this.maxAdapterRetries = config.maxAdapterRetries ?? 0;
    this.baseRetryDelayMs = config.baseRetryDelayMs ?? 1000;
    this.retryableErrors = config.retryableErrors ?? ['ADAPTER_RATE_LIMIT'];

    if (this.maxIterations < 1) {
      throw new HarnessError('maxIterations must be >= 1', 'INVALID_CONFIG', 'Provide a positive maxIterations value');
    }
    if (this.maxTotalTokens <= 0) {
      throw new HarnessError('maxTotalTokens must be > 0', 'INVALID_CONFIG', 'Provide a positive maxTotalTokens value');
    }
    if (this.maxStreamBytes <= 0) {
      throw new HarnessError('maxStreamBytes must be > 0', 'INVALID_CONFIG', 'Provide a positive maxStreamBytes value');
    }
    if (this.maxToolArgBytes <= 0) {
      throw new HarnessError('maxToolArgBytes must be > 0', 'INVALID_CONFIG', 'Provide a positive maxToolArgBytes value');
    }
    if (this.toolTimeoutMs !== undefined && this.toolTimeoutMs <= 0) {
      throw new HarnessError('toolTimeoutMs must be > 0', 'INVALID_CONFIG', 'Provide a positive toolTimeoutMs value');
    }

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

    // PERF-025: Pre-build the strategy options bag once. `isSequentialTool`
    // never changes after construction and `abortController.signal` is stable
    // for the lifetime of this loop, so the same object is reused for every
    // tool-call batch below. `Object.freeze` gives us structural immutability
    // so strategy implementations can safely cache or share the reference.
    this._strategyOptions = Object.freeze(
      this.isSequentialTool
        ? {
            signal: this.abortController.signal,
            getToolMeta: (name: string): { sequential?: boolean } | undefined => ({
              sequential: this.isSequentialTool?.(name) ?? false,
            }),
          }
        : { signal: this.abortController.signal },
    );
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
    // PERF-013: Remove external signal listener to prevent memory leaks when
    // the external signal outlives this loop instance. Wrap removal in
    // try/catch so an exception from the signal implementation cannot leave
    // the listener attached (it must always be detached to avoid a leak).
    if (this._externalAbortHandler && this.externalSignal) {
      try {
        this.externalSignal.removeEventListener('abort', this._externalAbortHandler);
      } catch {
        // Non-fatal — we still drop our reference below.
      }
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
    // Re-entrancy guard: two concurrent run() calls on the same instance
    // would race on _iteration, cumulativeUsage, and abortController. The
    // supported pattern is "one run per AgentLoop instance" or "serialize
    // calls". Detect misuse and fail loudly instead of silently corrupting
    // state.
    if (this._status === 'running') {
      throw new HarnessError(
        'AgentLoop.run() is already running — re-entrancy is not supported',
        'INVALID_STATE',
        'Await the first run() before calling again, or use separate AgentLoop instances for parallel execution',
      );
    }
    const conversation = [...messages];
    this._status = 'running';
    let iteration = 0;
    let finalEventEmitted = false;

    // Attach external signal listener at run() start (not constructor) so it
    // is always cleaned up in the finally block, even if dispose() is never called.
    // PERF-013: `{ once: true }` means the listener auto-detaches when abort
    // fires, but when abort never fires we still depend on manual removal in
    // finally. If removeEventListener throws for any reason (e.g., external
    // signal has been garbage-collected or replaced), the listener reference
    // would leak — wrap the removal in try/catch where we call it so we never
    // leave the handler registered on a still-live external signal.
    if (this.externalSignal) {
      if (this.externalSignal.aborted) {
        this.abortController.abort();
      } else {
        // A1-20 (Wave 4b): the listener must short-circuit once dispose() has
        // run. Previously dispose() nulled `_externalAbortHandler` but a
        // listener already queued by the signal's `abort` event could still
        // execute afterwards, invoking abort() on a disposed loop (and, when
        // the order of operations in dispose() was unlucky, touching the
        // nulled reference). Guard the body with a `disposed` status check so
        // a post-dispose abort is a silent no-op, AND keep `{ once: true }` so
        // the runtime auto-detaches on fire.
        this._externalAbortHandler = () => {
          if (this._status === 'disposed') return;
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
          const pruneResult = pruneConversation(conversation, this.maxConversationMessages);
          if (pruneResult.warning) {
            yield { type: 'warning', message: pruneResult.warning };
          }
          // PERF-010: `length = 0` followed by `push(...)` causes V8 to
          // deallocate then re-grow the backing store. `splice` replaces in
          // place, reusing the existing buffer. Semantics are identical:
          // same array identity, final contents equal `pruneResult.pruned`.
          conversation.splice(0, conversation.length, ...pruneResult.pruned);
        }

        // End previous iteration span if one is still open
        if (iterationSpanId && tm) { tm.endSpan(iterationSpanId); iterationSpanId = undefined; }

        // Start a new span for this iteration.
        // Attach diagnostic attributes so incident responders can filter by
        // iteration index / model / context depth without parsing span names.
        if (tm && traceId) {
          iterationSpanId = tm.startSpan(traceId, `iteration-${iteration}`);
          tm.setSpanAttributes(iterationSpanId, {
            iteration,
            adapter: this.adapter.name ?? 'unknown',
            conversationLength: conversation.length,
            streaming: this.streaming,
          });
        }

        yield { type: 'iteration_start', iteration };

        // C5: Wrap adapter call in try-catch to handle exceptions gracefully
        // With retry logic for retryable errors (e.g. rate-limit, network)
        // These are guaranteed to be assigned when adapterCallSucceeded is true.
        // The definite assignment assertion (!) tells TypeScript to trust us.
        let assistantMsg!: Message;
        let responseUsage!: TokenUsage;
        let adapterCallSucceeded = false;

        for (let attempt = 0; attempt <= this.maxAdapterRetries; attempt++) {
          // Check abort before each retry attempt
          if (attempt > 0 && this.isAborted()) {
            if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
            yield { type: 'error', error: new AbortedError() };
            finalEventEmitted = true;
            yield this.doneEvent('aborted');
            return;
          }

          if (this.streaming && this.adapter.stream) {
            // Streaming path: use adapter.stream()
            const streamResult = yield* this.handleStream(conversation, cumulativeStreamBytes, maxCumulativeStreamBytes);
            if (streamResult) {
              cumulativeStreamBytes += streamResult.bytesRead;
              assistantMsg = streamResult.message;
              responseUsage = streamResult.usage;
              adapterCallSucceeded = true;
              break;
            } else {
              // handleStream returned null — check if the error is retryable
              const errorCategory = this._lastStreamErrorCategory;
              this._lastStreamErrorCategory = undefined;

              if (errorCategory && this.retryableErrors.includes(errorCategory) && attempt < this.maxAdapterRetries) {
                if (iterationSpanId && tm) {
                  tm.addSpanEvent(iterationSpanId, {
                    name: 'adapter_retry',
                    attributes: { attempt, errorCategory, path: 'stream' },
                  });
                }
                try {
                  await this.backoff(attempt);
                } catch {
                  // Abort fired during backoff — fall through to abort check at retry loop top
                }
                continue;
              }

              // Not retryable or retries exhausted — annotate span before closing.
              if (iterationSpanId && tm) {
                tm.setSpanAttributes(iterationSpanId, {
                  errorCategory: errorCategory ?? 'unknown',
                  path: 'stream',
                });
                tm.endSpan(iterationSpanId, 'error');
                iterationSpanId = undefined;
              }
              finalEventEmitted = true;
              yield this.doneEvent('error');
              return;
            }
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
              adapterCallSucceeded = true;
              break;
            } catch (err) {
              const errorCategory = AgentLoop.categorizeAdapterError(err);
              const isRetryable = this.retryableErrors.includes(errorCategory);

              if (isRetryable && attempt < this.maxAdapterRetries) {
                if (iterationSpanId && tm) {
                  tm.addSpanEvent(iterationSpanId, {
                    name: 'adapter_retry',
                    attributes: {
                      attempt,
                      errorCategory,
                      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
                      path: 'chat',
                    },
                  });
                }
                try {
                  await this.backoff(attempt);
                } catch {
                  // Abort fired during backoff — fall through to abort check at retry loop top
                }
                continue;
              }

              // Not retryable or retries exhausted — annotate span, then emit error.
              if (iterationSpanId && tm) {
                tm.setSpanAttributes(iterationSpanId, {
                  errorCategory,
                  error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
                  path: 'chat',
                });
                tm.endSpan(iterationSpanId, 'error');
                iterationSpanId = undefined;
              }
              yield { type: 'error', error: err instanceof HarnessError ? err : new HarnessError(
                err instanceof Error ? err.message : String(err),
                errorCategory,
                'Check adapter configuration and API credentials',
                err instanceof Error ? err : undefined,
              ) };
              finalEventEmitted = true;
              yield this.doneEvent('error');
              return;
            }
          }
        }

        if (!adapterCallSucceeded) {
          // Safety: should not reach here, but guard against it
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          finalEventEmitted = true;
          yield this.doneEvent('error');
          return;
        }

        // Record usage + tool-count on the iteration span. toolCount is the
        // basic signal for tool-loop and tool-call-explosion diagnostics.
        if (iterationSpanId && tm) {
          tm.setSpanAttributes(iterationSpanId, {
            inputTokens: responseUsage.inputTokens,
            outputTokens: responseUsage.outputTokens,
            toolCount: assistantMsg.role === 'assistant' && assistantMsg.toolCalls
              ? assistantMsg.toolCalls.length
              : 0,
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

        // PERF-034: Yield tool_call events first (deterministic ordering).
        // The earlier "two-pass" structure (yield, then schedule execution)
        // was replaced with a single pass: the yield loop below + the
        // executionStrategy.execute call form one linear sequence per
        // iteration, with tool_result events yielded after execute resolves.
        // Keeping yield-before-execute order is required so observers see the
        // full tool_call batch before any result.
        for (const toolCall of toolCalls) {
          yield { type: 'tool_call', toolCall, iteration };
        }

        // Execute via strategy, with optional per-tool-call tracing
        const executionResults = await this.executionStrategy.execute(
          toolCalls,
          async (call) => {
            // Create a child span for each tool call when tracing is enabled.
            // Attach `toolName` as an attribute (not just span name) so trace
            // backends can aggregate tool-error rates without parsing names.
            const toolSpanId = (tm && traceId && iterationSpanId)
              ? tm.startSpan(traceId, `tool:${call.name}`, iterationSpanId)
              : undefined;
            if (toolSpanId && tm) {
              tm.setSpanAttributes(toolSpanId, {
                toolName: call.name,
                toolCallId: call.id,
              });
            }
            try {
              const toolPromise = this.onToolCall
                ? this.onToolCall(call)
                : Promise.resolve({ error: `No onToolCall handler registered for tool "${call.name}"` });

              let result: unknown;
              if (this.toolTimeoutMs !== undefined) {
                // Race tool execution against a timeout.
                // PERF-020: the timeout's setTimeout callback may fire after
                // the tool has already resolved — particularly when the event
                // loop is saturated. Without a `settled` guard the timeout
                // would resolve a second time (harmless for Promise.race,
                // but wasteful and keeps a phantom reference). We flip
                // `settled` both on success and on timeout so each side is
                // idempotent.
                const timeoutMs = this.toolTimeoutMs;
                let timer: ReturnType<typeof setTimeout> | undefined;
                let settled = false;
                try {
                  const timeoutPromise = new Promise<{ error: string }>((resolve) => {
                    timer = setTimeout(
                      () => {
                        if (settled) return; // tool already resolved; drop
                        settled = true;
                        resolve({ error: `Tool "${call.name}" timed out after ${timeoutMs}ms` });
                      },
                      timeoutMs,
                    );
                    // Ensure timer doesn't keep the process alive
                    if (typeof timer === 'object' && 'unref' in timer) {
                      (timer as NodeJS.Timeout).unref();
                    }
                  });
                  const raced = await Promise.race([
                    toolPromise.then((r) => {
                      // Mark settled BEFORE clearTimeout so a racing timer
                      // callback that happens to fire between resolve and
                      // the finally block still short-circuits.
                      settled = true;
                      if (timer !== undefined) clearTimeout(timer);
                      return r;
                    }),
                    timeoutPromise,
                  ]);
                  result = raced;
                } finally {
                  // Defensive: always clear the timer even if race threw.
                  if (timer !== undefined) clearTimeout(timer);
                }
              } else {
                result = await toolPromise;
              }

              if (toolSpanId && tm) { tm.endSpan(toolSpanId); }
              return result;
            } catch (toolErr) {
              if (toolSpanId && tm) {
                tm.setSpanAttributes(toolSpanId, {
                  errorMessage: (toolErr instanceof Error ? toolErr.message : String(toolErr)).slice(0, 500),
                  errorName: toolErr instanceof Error ? toolErr.name : 'Unknown',
                });
                tm.endSpan(toolSpanId, 'error');
              }
              throw toolErr;
            }
          },
          // PERF-025: Reuse the frozen options bag hoisted in the constructor
          // instead of allocating a fresh `Object.assign` on every batch.
          this._strategyOptions,
        );

        // Yield all tool_result events in original order (deterministic)
        for (const execResult of executionResults) {
          yield { type: 'tool_result', toolCallId: execResult.toolCallId, result: execResult.result };
          this._totalToolCalls++;

          let resultContent: string;
          try {
            resultContent = typeof execResult.result === 'string'
              ? execResult.result
              : AgentLoop.safeStringifyToolResult(execResult.result);
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
      // PERF-013: wrap removeEventListener in try/catch — if the signal
      // implementation throws (e.g., mocked/polyfilled signals in tests, or
      // detached after a host shutdown), swallow the error so we can still
      // clear `_externalAbortHandler` and avoid keeping a stale reference.
      if (this._externalAbortHandler && this.externalSignal) {
        try {
          this.externalSignal.removeEventListener('abort', this._externalAbortHandler);
        } catch {
          // Listener removal failure is non-fatal — we still drop our
          // reference so this AgentLoop can be garbage-collected.
        }
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
  /** Maximum serialized tool result size (1 MiB). Oversized results are replaced with a placeholder. */
  private static readonly MAX_TOOL_RESULT_BYTES = 1 * 1024 * 1024;
  /** Maximum object nesting depth for tool-result serialization. */
  private static readonly MAX_TOOL_RESULT_DEPTH = 10;

  /**
   * PERF-004: Serialize a tool-call result defensively. A naive
   * `JSON.stringify(result)` will happily follow a deeply nested object or
   * a multi-megabyte payload and freeze the event loop, or OOM the process.
   * Instead we:
   *   - apply a depth-limited replacer that truncates beyond depth 10 with a
   *     "[max depth exceeded]" sentinel,
   *   - then check the resulting string against a 1 MiB cap and return a
   *     "[result too large]" placeholder when exceeded.
   * Depth tracking uses a WeakSet-based stack so we also catch cycles.
   */
  private static safeStringifyToolResult(value: unknown): string {
    const maxDepth = AgentLoop.MAX_TOOL_RESULT_DEPTH;
    const maxBytes = AgentLoop.MAX_TOOL_RESULT_BYTES;
    const stack: Array<object> = [];

    const replacer = function (this: unknown, _key: string, val: unknown): unknown {
      if (val === null || typeof val !== 'object') return val;
      // Measure depth by how many enclosing containers we're currently inside.
      // Trim the stack whenever we pop back to an ancestor (detected by `this`).
      if (this && typeof this === 'object') {
        const parentIdx = stack.lastIndexOf(this as object);
        if (parentIdx >= 0) stack.length = parentIdx + 1;
      }
      if (stack.includes(val as object)) {
        // Cycle — replace with a sentinel rather than infinite-recurse.
        return '[circular]';
      }
      if (stack.length >= maxDepth) {
        return '[max depth exceeded]';
      }
      stack.push(val as object);
      return val;
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(value, replacer);
    } catch {
      return '[Object could not be serialized]';
    }
    if (serialized === undefined) {
      // JSON.stringify returns undefined for functions/symbols at the root
      return '[result not serializable]';
    }
    if (serialized.length > maxBytes) {
      return '[result too large]';
    }
    return serialized;
  }

  private async *handleStream(
    conversation: Message[],
    cumulativeStreamBytes: number,
    maxCumulativeStreamBytes: number,
  ): AsyncGenerator<AgentEvent, { message: Message; usage: TokenUsage; bytesRead: number } | null> {
    let accumulatedText = '';
    let accumulatedBytes = 0;
    // PERF-024 / PERF-032: Maintain the Map for O(1) id lookups AND a parallel
    // array that mirrors insertion order. The array is the snapshot fed to the
    // assistant message at stream end (PERF-032) and is also the structure we
    // index directly when a delta arrives without an id (previously required
    // `[...map.values()]` per chunk). The array only grows when a new tool-call
    // id is seen, so mutate-in-place deltas do NOT allocate.
    const accumulatedToolCalls: Map<string, { id: string; name: string; arguments: string }> = new Map();
    const toolCallList: Array<{ id: string; name: string; arguments: string }> = [];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      const stream = (this.adapter.stream as NonNullable<typeof this.adapter.stream>)({
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
              // PERF-024: New tool call — push once into the parallel array so
              // subsequent deltas mutate in place via the map reference.
              const entry = {
                id: partial.id,
                name: partial.name ?? '',
                arguments: partial.arguments ?? '',
              };
              accumulatedToolCalls.set(partial.id, entry);
              toolCallList.push(entry);
            }
          } else {
            // PERF-024: If no id, append to the most-recent tool call via the
            // parallel array (O(1) — no `[...map.values()]` allocation per chunk).
            if (toolCallList.length > 0) {
              const last = toolCallList[toolCallList.length - 1];
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
      const errorCategory = AgentLoop.categorizeAdapterError(err);
      this._lastStreamErrorCategory = errorCategory;
      yield { type: 'error', error: err instanceof HarnessError ? err : new HarnessError(
        err instanceof Error ? err.message : String(err),
        errorCategory,
        'Check adapter configuration and API credentials',
        err instanceof Error ? err : undefined,
      ) };
      return null;
    }

    // PERF-032: Reuse the parallel array maintained above — no final
    // `[...accumulatedToolCalls.values()]` spread.
    const toolCalls: ToolCallRequest[] = toolCallList;

    const message: Message = {
      role: 'assistant',
      content: accumulatedText,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return { message, usage, bytesRead: accumulatedBytes };
  }

  /** @deprecated Use the standalone `categorizeAdapterError` from `error-classifier.js` instead. */
  private static categorizeAdapterError(err: unknown): string {
    return categorizeAdapterError(err);
  }

  private isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  private doneEvent(reason: DoneReason): AgentEvent {
    this._status = 'completed';
    return { type: 'done', reason, totalUsage: this.usage };
  }

  /**
   * Sleep for exponential backoff with jitter.
   *
   * Returns a promise that resolves after `baseRetryDelayMs * 2^attempt + jitter`.
   * The timer is unref'd so it doesn't keep the process alive.
   * Rejects with AbortedError if the abort signal fires during the wait.
   */
  private backoff(attempt: number): Promise<void> {
    const base = this.baseRetryDelayMs * Math.pow(2, attempt);
    // Add random jitter: 0-25% of the base delay
    const jitter = Math.floor(Math.random() * base * 0.25);
    const delay = base + jitter;

    return new Promise<void>((resolve, reject) => {
      if (this.isAborted()) {
        reject(new AbortedError());
        return;
      }

      let settled = false;

      const onAbort = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new AbortedError());
        }
      };

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.abortController.signal.removeEventListener('abort', onAbort);
          resolve();
        }
      }, delay);

      // Ensure timer doesn't keep the process alive
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }

      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Functional alias for `new AgentLoop(config)`. Prefer this form when you
 * want consistency with the rest of the `harness-one` API (every other
 * primitive is a `createX()` factory) or when you plan to wrap the loop
 * in middleware — composition is easier against a plain object than a
 * class with private fields.
 *
 * @example
 * ```ts
 * import { createAgentLoop } from 'harness-one/core';
 * const loop = createAgentLoop({ adapter, traceManager });
 * for await (const event of loop.run(messages)) { ... }
 * ```
 */
export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  return new AgentLoop(config);
}
