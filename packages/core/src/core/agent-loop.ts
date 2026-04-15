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
import { createAdapterCaller, type AdapterCaller } from './adapter-caller.js';
import { createStreamHandler } from './stream-handler.js';
import { pruneConversation } from './conversation-pruner.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
// T10 (Wave-5A): guardrail pipeline integration. Types-only import for the
// opaque pipeline token; runtime helpers (`runInput`, `runOutput`,
// `runToolOutput`) are called through named imports below.
import type { GuardrailPipeline } from '../guardrails/pipeline.js';
import type { PipelineResult } from '../guardrails/types.js';
import { runInput, runOutput, runToolOutput } from '../guardrails/pipeline.js';
import { safeWarn } from '../_internal/safe-log.js';

// ARCH-002: `AgentLoopTraceManager` lives in `./trace-interface.js`. Re-export
// here so existing imports from `harness-one/core` (which historically pulled
// the type from `agent-loop.ts`) keep working without a code change.
export type { AgentLoopTraceManager } from './trace-interface.js';

/**
 * ARCH-006: Iteration-level instrumentation hook. Every method is optional;
 * a hook only needs to declare the events it cares about. Hooks are invoked
 * synchronously from the `AgentLoop`. If a hook throws, the error is logged
 * (when a `logger` is configured) and swallowed — hooks must never break
 * the loop.
 *
 * @example
 * ```ts
 * const loop = createAgentLoop({
 *   adapter,
 *   hooks: [{
 *     onIterationStart: ({ iteration }) => console.log('iter', iteration),
 *     onCost: ({ usage }) => metrics.add(usage),
 *   }],
 * });
 * ```
 */
export interface AgentLoopHook {
  /** Fires before any work in an iteration (right after the iteration counter increments). */
  onIterationStart?(info: { iteration: number }): void;
  /** Fires once per tool call yielded to the consumer, before tool execution. */
  onToolCall?(info: { iteration: number; toolCall: ToolCallRequest }): void;
  /** Fires after the adapter returns usage for the iteration. */
  onCost?(info: { iteration: number; usage: TokenUsage }): void;
  /** Fires at the end of the iteration. `done` indicates whether the loop is terminating. */
  onIterationEnd?(info: { iteration: number; done: boolean }): void;
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
  /**
   * ARCH-006: Iteration-level instrumentation hooks. Each registered hook
   * receives `onIterationStart`, `onToolCall`, `onCost`, and
   * `onIterationEnd` callbacks (all optional). Hook errors are logged via
   * `logger` (when set) and swallowed — hooks must never break the loop.
   */
  readonly hooks?: readonly AgentLoopHook[];
  /**
   * Optional structured logger. Used to surface hook failures (ARCH-006)
   * and other diagnostic warnings that previously fell back to
   * `console.warn`. Optional — when omitted, hook failures are silent.
   */
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * T10 (Wave-5A): optional guardrail pipeline applied to the latest user
   * message before every adapter call. A hard-block (`action: 'block'`)
   * terminates the loop with a `guardrail_blocked` AgentEvent followed by an
   * `error` carrying `HarnessErrorCode.GUARDRAIL_VIOLATION` (non-retryable),
   * and aborts the internal AbortController so any in-flight adapter call is
   * torn down. Omitting both pipelines emits a one-time `safeWarn` on the
   * first `run()` — security-relevant configurations should use
   * `createSecurePreset`.
   */
  readonly inputPipeline?: GuardrailPipeline;
  /**
   * T10 (Wave-5A): optional guardrail pipeline applied to
   * (a) each tool execution result — a block rewrites the tool result into a
   *     `GUARDRAIL_VIOLATION: <guardName>` stub so the LLM's tool-use / -result
   *     pairing stays valid and the loop continues, AND
   * (b) the final assistant answer — a block terminates the loop with a
   *     `guardrail_blocked` + `error` pair (see `inputPipeline`).
   */
  readonly outputPipeline?: GuardrailPipeline;
}

/**
 * Stateful agent loop that calls an LLM adapter in a loop, handling tool calls.
 *
 * @deprecated ARCH-011: Prefer {@link createAgentLoop} (factory). The class
 * export will be removed in 0.5.0. The factory returns the same instance
 * shape — no behavioural change is required at the call site.
 *
 * @example
 * ```ts
 * // Preferred:
 * const loop = createAgentLoop({ adapter, onToolCall: handleTool });
 * // Discouraged (still supported through 0.4.x):
 * // const loop = new AgentLoop({ adapter, onToolCall: handleTool });
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
  private readonly adapterCaller: AdapterCaller;
  /** ARCH-006: registered iteration-level hooks. Empty array when none. */
  private readonly hooks: readonly AgentLoopHook[];
  private readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** T10 (Wave-5A): optional input-side guardrail pipeline. */
  private readonly inputPipeline?: GuardrailPipeline;
  /** T10 (Wave-5A): optional output-side guardrail pipeline (tool + final). */
  private readonly outputPipeline?: GuardrailPipeline;
  /**
   * T10 (Wave-5A): guards the "no-guardrail" warn against duplication across
   * multiple run() calls on the same AgentLoop instance. Flip once and never
   * reset — the configuration is immutable per instance.
   */
  private _noPipelineWarned: boolean = false;

  private abortController: AbortController;
  private _externalAbortHandler: (() => void) | undefined;
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
    // ARCH-006: store hooks (defensive empty array, never undefined to
    // simplify per-iteration dispatch). Logger is optional — when omitted,
    // hook errors are swallowed silently.
    this.hooks = config.hooks ?? [];
    if (config.logger !== undefined) this.logger = config.logger;
    // T10 (Wave-5A): store optional guardrail pipelines. `exactOptionalPropertyTypes`
    // forbids writing `undefined` to a `readonly pipe?: GuardrailPipeline`, so we
    // gate the assignment behind an explicit presence check.
    if (config.inputPipeline !== undefined) this.inputPipeline = config.inputPipeline;
    if (config.outputPipeline !== undefined) this.outputPipeline = config.outputPipeline;

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

    // Wave-5B Step 2: build the StreamHandler once; AdapterCaller delegates
    // to it on the streaming path. `maxCumulativeStreamBytes` matches
    // run()'s local derivation (`maxIterations * maxStreamBytes`) so per-run
    // and per-instance limits stay in lockstep.
    const streamHandler = createStreamHandler({
      adapter: this.adapter,
      signal: this.abortController.signal,
      maxStreamBytes: this.maxStreamBytes,
      maxToolArgBytes: this.maxToolArgBytes,
      maxCumulativeStreamBytes: this.maxIterations * this.maxStreamBytes,
      ...(this.tools !== undefined && { tools: this.tools }),
    });

    // Streaming is only effective when the adapter actually exposes
    // `stream`. Today's run() had `if (this.streaming && this.adapter.stream)`
    // guarding the streaming branch; we mirror that here so an adapter
    // without `stream` transparently falls back to chat. (Matches
    // pre-Wave-5B agent-loop.ts L685.)
    const effectiveStreaming = this.streaming && typeof this.adapter.stream === 'function';

    this.adapterCaller = createAdapterCaller({
      adapter: this.adapter,
      signal: this.abortController.signal,
      streaming: effectiveStreaming,
      maxAdapterRetries: this.maxAdapterRetries,
      baseRetryDelayMs: this.baseRetryDelayMs,
      retryableErrors: this.retryableErrors,
      streamHandler,
      // onRetry closes over `this._currentIterationSpanId` so the callback
      // can record the retry as a span event on whichever iteration is
      // active. `run()` updates this field as iterations advance; Step 3
      // will move this plumbing onto IterationContext.
      onRetry: ({ attempt, errorCategory, path, errorPreview }) => {
        const tm = this.traceManager;
        const spanId = this._currentIterationSpanId;
        if (!tm || !spanId) return;
        tm.addSpanEvent(spanId, {
          name: 'adapter_retry',
          attributes: {
            attempt,
            errorCategory,
            path,
            ...(errorPreview !== undefined ? { error: errorPreview } : {}),
          },
        });
      },
      ...(this.tools !== undefined && { tools: this.tools }),
    });
  }

  /**
   * Wave-5B Step 2: holder for the active iteration span id so the
   * `onRetry` callback wired at construction can target the right span.
   * `run()` writes this as iterations advance. Step 3 migrates it onto
   * `IterationContext`.
   */
  private _currentIterationSpanId: string | undefined;

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

  /**
   * ARCH-006: Invoke every registered hook for `event`. Hooks are called
   * synchronously and in registration order. A throwing hook is logged
   * (when a logger is configured) and otherwise silently swallowed —
   * the loop must never observe a hook failure.
   */
  private runHook<E extends keyof AgentLoopHook>(
    event: E,
    info: Parameters<NonNullable<AgentLoopHook[E]>>[0],
  ): void {
    if (this.hooks.length === 0) return;
    for (const hook of this.hooks) {
      const fn = hook[event];
      if (typeof fn !== 'function') continue;
      try {
        // Cast required because TS can't narrow the parameter type from the
        // generic event key without explicit per-event overloads. Hooks are
        // a typed contract at the public boundary (`AgentLoopHook`).
        (fn as (i: typeof info) => void).call(hook, info);
      } catch (err) {
        if (this.logger) {
          try {
            this.logger.warn('[harness-one/agent-loop] hook threw', {
              event,
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {
            // Logger itself failed — nothing more we can safely do.
          }
        }
      }
    }
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

    // T10 (Wave-5A): emit a one-time security warning when neither pipeline
    // is configured. Running an AgentLoop without guardrails is usually a
    // misconfiguration — guide operators towards `createSecurePreset`. The
    // flag lives on the instance so repeated run() calls don't spam logs.
    if (!this._noPipelineWarned && !this.inputPipeline && !this.outputPipeline) {
      this._noPipelineWarned = true;
      const msg = 'AgentLoop has no guardrail pipeline — security risk';
      const meta = { hint: 'use createSecurePreset' };
      if (this.logger) {
        try { this.logger.warn(msg, meta); } catch { /* logger failure non-fatal */ }
      } else {
        safeWarn(undefined, msg, meta);
      }
    }

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
    // Cumulative stream byte counter across all iterations for DoS protection.
    // The cap (maxIterations * maxStreamBytes) is enforced inside StreamHandler
    // via the config wired in the constructor; AdapterCaller forwards the
    // running total on every turn.
    let cumulativeStreamBytes = 0;

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
        // Wave-5B Step 2: publish the active span id so AdapterCaller's
        // onRetry callback (wired at construction) can target it.
        this._currentIterationSpanId = iterationSpanId;

        yield { type: 'iteration_start', iteration };
        // ARCH-006: notify hooks immediately after the public iteration_start
        // event so observers can correlate hook callbacks with the visible
        // event stream. `iterationEndFired` lets us guarantee a paired
        // `onIterationEnd` even on every terminating early-return below.
        this.runHook('onIterationStart', { iteration });
        let iterationEndFired = false;
        const fireIterationEnd = (done: boolean): void => {
          if (iterationEndFired) return;
          iterationEndFired = true;
          this.runHook('onIterationEnd', { iteration, done });
        };

        // T10 (Wave-5A): input guardrail pipeline runs before the adapter call
        // on the latest user-role message. A block tears the loop down hard:
        //   - abort internal signal so in-flight adapter calls (if any) wind
        //     down via their AbortSignal,
        //   - yield `guardrail_blocked` (phase='input') + `error` + `done`,
        //   - classifier tags the error as non-retryable.
        if (this.inputPipeline) {
          const latestUser = AgentLoop.findLatestUserMessage(conversation);
          if (latestUser !== undefined) {
            const result = await runInput(this.inputPipeline, { content: latestUser });
            if (!result.passed && result.verdict.action === 'block') {
              const guardName = AgentLoop.pickBlockingGuardName(result, 'input');
              const reason = result.verdict.reason;
              // Tear down upstream work and emit the hard-block triplet.
              this.abortController.abort();
              yield { type: 'guardrail_blocked', phase: 'input', guardName, details: { reason } };
              yield {
                type: 'error',
                error: new HarnessError(
                  `guardrail "${guardName}" blocked input — ${reason}`,
                  'GUARDRAIL_VIOLATION',
                  'Review the input pipeline configuration and sanitize the user message',
                ),
              };
              if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
              finalEventEmitted = true;
              fireIterationEnd(true);
              yield this.doneEvent('error');
              return;
            }
          }
        }

        // Wave-5B Step 2: delegate the full adapter turn (retry loop + both
        // paths) to AdapterCaller. On streaming path, StreamHandler yields
        // the {type:'error'} event inline on failure; on chat path we yield
        // it here after receiving the failed result. See ADR §9 R1.
        const result = yield* this.adapterCaller.call(conversation, cumulativeStreamBytes);

        if (!result.ok) {
          const { error: err, errorCategory, path } = result;
          if (iterationSpanId && tm) {
            tm.setSpanAttributes(iterationSpanId, {
              errorCategory,
              path,
              ...(path === 'chat'
                ? { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
                : {}),
            });
            tm.endSpan(iterationSpanId, 'error');
            iterationSpanId = undefined;
            this._currentIterationSpanId = undefined;
          }

          if (errorCategory === 'ABORTED') {
            // Abort fired during backoff — synthetic category from AdapterCaller.
            // Mirror today's L632-L638 / L679-L682 abort-during-retry bail
            // (and L711-L729 fallthrough to the abort check): yield an
            // AbortedError and exit with done('aborted'). On the stream
            // path StreamHandler did NOT yield (abort surfaces from backoff,
            // not the stream), so we always yield here.
            yield { type: 'error', error: new AbortedError() };
            finalEventEmitted = true;
            fireIterationEnd(true);
            yield this.doneEvent('aborted');
            return;
          }

          if (path === 'chat') {
            // Chat path: AdapterCaller caught but did NOT yield. Wrap and
            // yield the error event to preserve today's L725-L730 behaviour.
            yield { type: 'error', error: err instanceof HarnessError ? err : new HarnessError(
              err instanceof Error ? err.message : String(err),
              errorCategory,
              'Check adapter configuration and API credentials',
              err instanceof Error ? err : undefined,
            ) };
          }
          // Stream path: StreamHandler already yielded the {type:'error'}
          // event inside handle(); re-yielding would double-emit (ADR §9 R1).
          finalEventEmitted = true;
          fireIterationEnd(true);
          yield this.doneEvent('error');
          return;
        }

        // Success: accumulate bytesRead (streaming path only — chat is 0)
        // and unpack the adapter response. Preserves today's L644 inline
        // cumulative increment and L687-L691 / L732-L733 unpacking.
        cumulativeStreamBytes += result.bytesRead;
        const assistantMsg = result.message;
        const responseUsage = result.usage;

        // Record usage + tool-count on the iteration span. toolCount is the
        // basic signal for tool-loop and tool-call-explosion diagnostics.
        if (iterationSpanId && tm) {
          tm.setSpanAttributes(iterationSpanId, {
            inputTokens: responseUsage.inputTokens,
            outputTokens: responseUsage.outputTokens,
            toolCount: assistantMsg.role === 'assistant' && assistantMsg.toolCalls
              ? assistantMsg.toolCalls.length
              : 0,
            // Wave-5B Step 2: expose AdapterCaller's retry accounting on the
            // iteration span so operators can audit path/attempts without
            // cross-referencing adapter_retry events.
            path: result.path,
            attempts: result.attempts,
          });
        }

        // Check abort after adapter call (abort() may have been called during in-flight request)
        if (this.isAborted()) {
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          yield { type: 'error', error: new AbortedError() };
          finalEventEmitted = true;
          fireIterationEnd(true);
          yield this.doneEvent('aborted');
          return;
        }

        // Accumulate usage (clamp to safe bounds to prevent underflow bypass or overflow from buggy adapters)
        const safeInput = Math.min(Math.max(0, responseUsage.inputTokens), 1_000_000_000);
        const safeOutput = Math.min(Math.max(0, responseUsage.outputTokens), 1_000_000_000);
        this.cumulativeUsage.inputTokens += safeInput;
        this.cumulativeUsage.outputTokens += safeOutput;
        // ARCH-006: notify hooks about per-iteration token cost. Pass the
        // adapter-reported usage (not cumulative) so observers can derive
        // both per-iteration and cumulative metrics.
        this.runHook('onCost', { iteration, usage: responseUsage });

        // H2: Check token budget immediately after accumulating tokens
        const postCallTokens = this.cumulativeUsage.inputTokens + this.cumulativeUsage.outputTokens;
        if (postCallTokens > this.maxTotalTokens) {
          // Budget exceeded after this response; emit message (for content) then stop
          yield { type: 'message', message: assistantMsg, usage: responseUsage };
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
          const err = new TokenBudgetExceededError(postCallTokens, this.maxTotalTokens);
          yield { type: 'error', error: err };
          finalEventEmitted = true;
          fireIterationEnd(true);
          yield this.doneEvent('token_budget');
          return;
        }

        const toolCalls = assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined;

        // If no tool calls or empty tool calls -> end turn
        if (!toolCalls || toolCalls.length === 0) {
          // T10 (Wave-5A): run output guardrail on the final assistant answer
          // BEFORE yielding the `message` event. A block terminates the loop
          // hard — same triplet as the input path (guardrail_blocked + error
          // + done('error')) — and aborts the internal signal to cancel any
          // streaming still holding a reader open.
          if (this.outputPipeline) {
            const finalContent = assistantMsg.content ?? '';
            const result = await runOutput(this.outputPipeline, { content: finalContent });
            if (!result.passed && result.verdict.action === 'block') {
              const guardName = AgentLoop.pickBlockingGuardName(result, 'output');
              const reason = result.verdict.reason;
              this.abortController.abort();
              yield { type: 'guardrail_blocked', phase: 'output', guardName, details: { reason } };
              yield {
                type: 'error',
                error: new HarnessError(
                  `guardrail "${guardName}" blocked output — ${reason}`,
                  'GUARDRAIL_VIOLATION',
                  'Review the output pipeline configuration and the model response',
                ),
              };
              if (iterationSpanId && tm) { tm.endSpan(iterationSpanId, 'error'); iterationSpanId = undefined; }
              finalEventEmitted = true;
              fireIterationEnd(true);
              yield this.doneEvent('error');
              return;
            }
          }
          yield { type: 'message', message: assistantMsg, usage: responseUsage };
          if (iterationSpanId && tm) { tm.endSpan(iterationSpanId); iterationSpanId = undefined; }
          finalEventEmitted = true;
          fireIterationEnd(true);
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
          // ARCH-006: notify hooks once per tool call, after the public
          // event yields so subscribers see the same ordering.
          this.runHook('onToolCall', { iteration, toolCall });
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

          // T10 (Wave-5A): run the output pipeline on tool results. A block
          // does NOT terminate the loop — instead we rewrite the tool result
          // into a stub so the LLM still sees a tool_result for every
          // tool_use (provider schemas reject mismatched pairs). The loop
          // continues to the next iteration; a follow-up `output` block on
          // the final assistant answer is still possible.
          if (this.outputPipeline) {
            const originTool = toolCalls.find((c) => c.id === execResult.toolCallId);
            const result = await runToolOutput(
              this.outputPipeline,
              resultContent,
              originTool?.name,
            );
            if (!result.passed && result.verdict.action === 'block') {
              const guardName = AgentLoop.pickBlockingGuardName(result, 'output');
              const reason = result.verdict.reason;
              yield {
                type: 'guardrail_blocked',
                phase: 'tool_output',
                guardName,
                details: { toolCallId: execResult.toolCallId, toolName: originTool?.name, reason },
              };
              // Rewrite the content to a safe JSON-stringified error stub. The
              // LLM sees a structured `{"error":"GUARDRAIL_VIOLATION: <name>"}`
              // and typically recovers by summarizing or ending the turn.
              resultContent = JSON.stringify({
                error: `GUARDRAIL_VIOLATION: ${guardName}`,
                reason,
              });
            }
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
          fireIterationEnd(true);
          yield this.doneEvent('aborted');
          return;
        }
        // ARCH-006: iteration completed normally and the loop will continue
        // for another iteration. Fire `done: false` so observers can build
        // per-iteration metrics without filtering on the doneEvent reason.
        fireIterationEnd(false);
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
      // Wave-5B Step 2: drop the span-id side-reference so a stale id can
      // never leak into the onRetry callback after this run exits.
      this._currentIterationSpanId = undefined;
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

  /**
   * T10 (Wave-5A): walk the conversation from the tail until we find a user
   * message. Returns its `content` string, or `undefined` when no user message
   * exists (e.g., a pure system-only seed — we skip the input pipeline rather
   * than running it on empty content).
   */
  private static findLatestUserMessage(messages: readonly Message[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user') return m.content;
    }
    return undefined;
  }

  /**
   * T10 (Wave-5A): derive a human-readable guard name from a blocking
   * `PipelineResult`. Prefer the last event (the guard that actually blocked);
   * fall back to a direction-qualified sentinel so logs and events always
   * carry something renderable.
   */
  private static pickBlockingGuardName(
    result: PipelineResult,
    direction: 'input' | 'output',
  ): string {
    const last = result.results[result.results.length - 1];
    if (last && last.verdict.action === 'block') return last.guardrail;
    return `${direction}-guardrail`;
  }

  private isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  private doneEvent(reason: DoneReason): AgentEvent {
    this._status = 'completed';
    return { type: 'done', reason, totalUsage: this.usage };
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
