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
import { AbortedError, HarnessError, MaxIterationsError, TokenBudgetExceededError, HarnessErrorCode} from './errors.js';
import { createSequentialStrategy, createParallelStrategy } from './execution-strategies.js';
import { createAdapterCaller, type AdapterCaller } from './adapter-caller.js';
import { createStreamHandler } from './stream-handler.js';
import { pruneConversation } from './conversation-pruner.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
// T10 (Wave-5A): guardrail pipeline integration. Types-only import for the
// opaque pipeline token; the runtime helpers now live inside
// `iteration-runner.ts` (Wave-5B Step 3) and `guardrail-helpers.ts`.
import type { GuardrailPipeline } from '../guardrails/pipeline.js';
// Wave-5B Step 3: per-iteration choreography lives in IterationRunner.
import {
  createIterationRunner,
  type IterationContext,
  type IterationRunner,
} from './iteration-runner.js';
import { safeWarn } from '../infra/safe-log.js';
import type { AgentLoopConfig, AgentLoopHook } from './agent-loop-types.js';
import { createHookDispatcher } from './hook-dispatcher.js';

// ARCH-002: `AgentLoopTraceManager` lives in `./trace-interface.js`. Re-export
// here so existing imports from `harness-one/core` (which historically pulled
// the type from `agent-loop.ts`) keep working without a code change.
export type { AgentLoopTraceManager } from './trace-interface.js';
// Re-export the config + hook contracts so existing consumers keep working.
export type { AgentLoopConfig, AgentLoopHook } from './agent-loop-types.js';

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
  /** Wave-5B Step 3: per-iteration choreography runner. Stateless across runs. */
  private readonly iterationRunner: IterationRunner;
  /** ARCH-006: registered iteration-level hooks. Empty array when none. */
  private readonly hooks: readonly AgentLoopHook[];
  private readonly strictHooks: boolean;
  private readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** Shared dispatcher over `hooks` with strictHooks + logger semantics. */
  private readonly runHook: ReturnType<typeof createHookDispatcher>;
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
    this.strictHooks = config.strictHooks ?? false;
    if (config.logger !== undefined) this.logger = config.logger;
    this.runHook = createHookDispatcher({
      hooks: this.hooks,
      strictHooks: this.strictHooks,
      ...(this.logger !== undefined && { logger: this.logger }),
    });
    // T10 (Wave-5A): store optional guardrail pipelines. `exactOptionalPropertyTypes`
    // forbids writing `undefined` to a `readonly pipe?: GuardrailPipeline`, so we
    // gate the assignment behind an explicit presence check.
    if (config.inputPipeline !== undefined) this.inputPipeline = config.inputPipeline;
    if (config.outputPipeline !== undefined) this.outputPipeline = config.outputPipeline;

    if (this.maxIterations < 1) {
      throw new HarnessError('maxIterations must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxIterations value');
    }
    if (this.maxTotalTokens <= 0) {
      throw new HarnessError('maxTotalTokens must be > 0', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxTotalTokens value');
    }
    if (this.maxStreamBytes <= 0) {
      throw new HarnessError('maxStreamBytes must be > 0', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxStreamBytes value');
    }
    if (this.maxToolArgBytes <= 0) {
      throw new HarnessError('maxToolArgBytes must be > 0', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxToolArgBytes value');
    }
    if (this.toolTimeoutMs !== undefined && this.toolTimeoutMs <= 0) {
      throw new HarnessError('toolTimeoutMs must be > 0', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive toolTimeoutMs value');
    }
    if (!Number.isFinite(this.baseRetryDelayMs) || this.baseRetryDelayMs < 0) {
      throw new HarnessError('baseRetryDelayMs must be a non-negative finite number', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a value >= 0');
    }
    if (!Number.isInteger(this.maxAdapterRetries) || this.maxAdapterRetries < 0) {
      throw new HarnessError('maxAdapterRetries must be a non-negative integer', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide an integer >= 0');
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
      // Wave-5B Step 3: onRetry is now provided per-call by IterationRunner
      // so the active iteration span id is captured cleanly via the
      // freshly-allocated IterationContext (no instance side-channel).
      ...(this.tools !== undefined && { tools: this.tools }),
    });

    // Wave-5B Step 3: build the IterationRunner once. The runner is stateless
    // across runs (ADR §2.3 / R8 / R9); all per-run mutable state lives on the
    // IterationContext we hand it inside `run()`.
    this.iterationRunner = createIterationRunner({
      adapterCaller: this.adapterCaller,
      executionStrategy: this.executionStrategy,
      strategyOptions: this._strategyOptions,
      abortController: this.abortController,
      maxTotalTokens: this.maxTotalTokens,
      hooks: this.hooks,
      strictHooks: this.strictHooks,
      ...(this.onToolCall !== undefined && { onToolCall: this.onToolCall }),
      ...(this.toolTimeoutMs !== undefined && { toolTimeoutMs: this.toolTimeoutMs }),
      ...(this.inputPipeline !== undefined && { inputPipeline: this.inputPipeline }),
      ...(this.outputPipeline !== undefined && { outputPipeline: this.outputPipeline }),
      ...(this.traceManager !== undefined && { traceManager: this.traceManager }),
      ...(this.logger !== undefined && { logger: this.logger }),
    });
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

  /**
   * Dispose the loop, releasing resources and cancelling any pending operations.
   *
   * Wave-13 D-10: when the execution strategy implements the optional
   * `dispose()` method, we forward the call (fire-and-forget) so long-lived
   * strategies (worker pools, persistent queues, etc.) can release their
   * resources at loop shutdown. Errors from strategy dispose are swallowed —
   * the loop's own teardown must not be blocked by strategy-specific failures.
   */
  dispose(): void {
    // PERF-013: Remove external signal listener to prevent memory leaks when
    // the external signal outlives this loop instance. Wrap removal in
    // try/catch so an exception from the signal implementation cannot leave
    // the listener attached (it must always be detached to avoid a leak).
    try {
      if (this._externalAbortHandler && this.externalSignal) {
        try {
          this.externalSignal.removeEventListener('abort', this._externalAbortHandler);
        } catch {
          // Non-fatal — we still drop our reference below.
        }
        this._externalAbortHandler = undefined;
      }
      this.abortController.abort();
      // Wave-13 D-10: forward dispose to the execution strategy when present.
      // Fire-and-forget: strategy dispose is async but we keep dispose()
      // synchronous to preserve the pre-Wave-13 signature. Any rejection is
      // silenced via `.catch()` — teardown errors are best-effort.
      const strategyDispose = this.executionStrategy.dispose;
      if (typeof strategyDispose === 'function') {
        try {
          const p = strategyDispose.call(this.executionStrategy);
          if (p && typeof (p as Promise<void>).catch === 'function') {
            (p as Promise<void>).catch(() => {
              /* strategy teardown failure — non-fatal */
            });
          }
        } catch {
          /* synchronous throw from dispose — non-fatal */
        }
      }
    } finally {
      this._status = 'disposed';
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
   * Wave-5B Step 4: orchestration only — the ceremony lives in private
   * helpers (`startRun`, `emitTerminal`, `checkPreIteration`,
   * `startIteration`, `finalizeRun`) so this method stays under the
   * 120-LOC budget mandated by ADR §7.
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
        HarnessErrorCode.CORE_INVALID_STATE,
        'Await the first run() before calling again, or use separate AgentLoop instances for parallel execution',
      );
    }

    const { ctx, tm, traceId } = this.startRun(messages);
    let iteration = 0;
    let finalEventEmitted = false;

    try {
      while (true) {
        // Pre-iteration checks (abort -> max_iterations -> token budget).
        // The helper increments `iteration` for the max-iterations check
        // and writes `this._iteration` so timing matches pre-Step-4.
        const stop = yield* this.checkPreIteration(
          () => iteration,
          (next) => { iteration = next; },
          ctx,
          tm,
        );
        if (stop) {
          finalEventEmitted = true;
          return;
        }

        yield* this.startIteration(iteration, ctx, tm, traceId);

        // Hand off to IterationRunner. The runner yields the same event
        // sequence the consumer used to see and returns an outcome we use
        // to decide whether to continue or terminate the run.
        const outcome = yield* this.iterationRunner.runIteration(ctx);

        // Forward per-iteration counters from context to instance fields
        // (getMetrics / usage getter still read the instance side).
        this._totalToolCalls = ctx.toolCallCounter.value;
        this.cumulativeUsage = {
          inputTokens: ctx.cumulativeUsage.inputTokens,
          outputTokens: ctx.cumulativeUsage.outputTokens,
        };

        if (outcome.kind === 'terminated') {
          this._status = 'completed';
          finalEventEmitted = true;
          yield {
            type: 'done',
            reason: outcome.reason,
            totalUsage: outcome.totalUsage,
          };
          return;
        }
        // outcome.kind === 'continue' — loop into the next iteration.
      }
    } finally {
      this.finalizeRun(ctx, tm, traceId, finalEventEmitted);
    }
  }

  /**
   * Wave-5B Step 4: extract run() ceremony — status flip, no-pipeline
   * warning (T10), external signal wiring (PERF-013 / A1-20), trace
   * creation, and IterationContext allocation. Returns the trio the
   * orchestrator threads through every iteration.
   */
  private startRun(messages: Message[]): {
    ctx: IterationContext;
    tm: AgentLoopTraceManager | undefined;
    traceId: string | undefined;
  } {
    const conversation = [...messages];
    this._status = 'running';

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

    // Wave-5B Step 3: per-run mutable state lives on the IterationContext.
    // Freshly allocated per `run()` so IterationRunner can stay stateless
    // across runs (ADR §2.3 / §9 R8 / R9). The orchestrator reads back
    // `iterationSpanId` from the same context in the outer `finally`
    // (R5 mitigation) and forwards `cumulativeUsage` / `toolCallCounter`
    // to instance fields after each iteration so `getMetrics()` and the
    // `usage` getter remain accurate.
    const ctx: IterationContext = {
      conversation,
      iteration: 0,
      cumulativeStreamBytes: { value: 0 },
      iterationSpanId: undefined,
      traceId,
      cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
      toolCallCounter: { value: 0 },
      iterationEndFired: { value: false },
    };

    return { ctx, tm, traceId };
  }

  /**
   * Wave-5B Step 4: extract the inline emitTerminal closure. Used by the
   * three pre-iteration terminal sites (abort, max_iterations, pre-call
   * token budget). These happen BEFORE any iteration_start / hook firing,
   * so they don't go through bailOut — they don't need to fire
   * onIterationEnd and they skip the guardrail event channel.
   */
  private *emitTerminal(
    reason: DoneReason,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
    ctx: IterationContext,
    tm: AgentLoopTraceManager | undefined,
  ): Generator<AgentEvent> {
    if (ctx.iterationSpanId && tm) {
      try { tm.endSpan(ctx.iterationSpanId, 'error'); } catch { /* defensive */ }
      ctx.iterationSpanId = undefined;
    }
    yield errorEvent;
    this._status = 'completed';
    yield { type: 'done', reason, totalUsage: this.usage };
  }

  /**
   * Wave-5B Step 4: extract the three pre-iteration checks (abort ->
   * max_iterations -> token budget). Order MUST be preserved exactly per
   * ADR §7 Step 4. Increments the iteration counter for the
   * max-iterations check (post-increment to match pre-Step-4 timing) and
   * writes `this._iteration` immediately after the bump, before the
   * runner call — both timings are observable via `getMetrics()`.
   *
   * Returns `true` when the caller should stop and `return` from `run()`.
   */
  private *checkPreIteration(
    getIteration: () => number,
    setIteration: (next: number) => void,
    ctx: IterationContext,
    tm: AgentLoopTraceManager | undefined,
  ): Generator<AgentEvent, boolean> {
    // Pre-iteration check 1: external/internal abort.
    if (this.isAborted()) {
      yield* this.emitTerminal('aborted', { type: 'error', error: new AbortedError() }, ctx, tm);
      return true;
    }

    // Pre-iteration check 2: max iterations (post-increment to match today).
    const next = getIteration() + 1;
    setIteration(next);
    this._iteration = next;
    if (next > this.maxIterations) {
      yield* this.emitTerminal(
        'max_iterations',
        { type: 'error', error: new MaxIterationsError(this.maxIterations) },
        ctx,
        tm,
      );
      return true;
    }

    // Pre-iteration check 3: cumulative token budget.
    const totalTokens = ctx.cumulativeUsage.inputTokens + ctx.cumulativeUsage.outputTokens;
    if (totalTokens > this.maxTotalTokens) {
      yield* this.emitTerminal(
        'token_budget',
        { type: 'error', error: new TokenBudgetExceededError(totalTokens, this.maxTotalTokens) },
        ctx,
        tm,
      );
      return true;
    }

    return false;
  }

  /**
   * Wave-5B Step 4: extract per-iteration setup — H4 prune, end any stale
   * span, open the fresh iteration span with diagnostic attributes, mirror
   * iteration into ctx, reset the iterationEndFired latch, yield
   * `iteration_start`, and fire the ARCH-006 onIterationStart hook in
   * run() (NOT the runner) so a pre-iteration emitTerminal that happens
   * BEFORE we get here would never observe a paired start/end.
   */
  private *startIteration(
    iteration: number,
    ctx: IterationContext,
    tm: AgentLoopTraceManager | undefined,
    traceId: string | undefined,
  ): Generator<AgentEvent> {
    // H4: prune conversation if exceeded.
    // Wave-12 P0-4: avoid `splice(0, n, ...pruned)` which spreads a large
    // array onto the call stack (stack-depth risk on big conversations) and
    // forces an O(n) tail-copy followed by an O(m) insert. An in-place
    // overwrite is O(n) with no spread and no temporary allocation.
    if (
      this.maxConversationMessages !== undefined &&
      ctx.conversation.length > this.maxConversationMessages
    ) {
      const pruneResult = pruneConversation(ctx.conversation, this.maxConversationMessages);
      if (pruneResult.warning) {
        yield { type: 'warning', message: pruneResult.warning };
      }
      const pruned = pruneResult.pruned;
      for (let i = 0; i < pruned.length; i++) {
        ctx.conversation[i] = pruned[i];
      }
      ctx.conversation.length = pruned.length;
    }

    // End any iteration span left open from the previous turn.
    if (ctx.iterationSpanId && tm) {
      tm.endSpan(ctx.iterationSpanId);
      ctx.iterationSpanId = undefined;
    }

    // Open a fresh iteration span; attach diagnostic attributes so
    // incident responders can filter without parsing span names.
    if (tm && traceId) {
      ctx.iterationSpanId = tm.startSpan(traceId, `iteration-${iteration}`);
      tm.setSpanAttributes(ctx.iterationSpanId, {
        iteration,
        adapter: this.adapter.name ?? 'unknown',
        conversationLength: ctx.conversation.length,
        streaming: this.streaming,
      });
    }

    ctx.iteration = iteration;
    ctx.iterationEndFired.value = false;
    yield { type: 'iteration_start', iteration };
    // ARCH-006: fire onIterationStart in run() (not the runner) so a
    // pre-iteration emitTerminal that happens BEFORE we get here would
    // never observe a paired start/end.
    this.runHook('onIterationStart', { iteration });
  }

  /**
   * Wave-5B Step 4: extract the run() finally-block teardown. Cleans up
   * the external signal listener (PERF-013), closes any leaked
   * iteration span via the durable context (R5), ends the trace, and
   * aborts the internal controller when the generator was closed
   * externally via `.return()` / `.throw()`.
   */
  private finalizeRun(
    ctx: IterationContext,
    tm: AgentLoopTraceManager | undefined,
    traceId: string | undefined,
    finalEventEmitted: boolean,
  ): void {
    // Clean up external signal listener (PERF-013). Defensive try/catch:
    // mocked/polyfilled signals can throw on removeEventListener.
    if (this._externalAbortHandler && this.externalSignal) {
      try {
        this.externalSignal.removeEventListener('abort', this._externalAbortHandler);
      } catch {
        // Non-fatal — we still drop our reference.
      }
      this._externalAbortHandler = undefined;
    }
    // R5: read iterationSpanId from the durable context, not a local
    // `let`. The runner closes the span on the happy path; this catches
    // the throw / generator-closed-externally cases.
    if (ctx.iterationSpanId && tm) {
      try { tm.endSpan(ctx.iterationSpanId, 'error'); } catch { /* may already be ended */ }
    }
    // End the trace.
    if (traceId && tm) {
      try {
        tm.endTrace(traceId, finalEventEmitted ? 'completed' : 'error');
      } catch {
        // Non-fatal — trace may already be ended.
      }
    }
    if (!finalEventEmitted) {
      // Generator was closed externally via .return() / .throw()
      this.abortController.abort();
    }
  }

  /** Maximum accumulated stream content size (10 MB) to prevent memory exhaustion. */
  static readonly MAX_STREAM_BYTES = 10 * 1024 * 1024;
  /** Maximum size per tool-call argument (5 MB) to prevent oversized payloads. */
  private static readonly MAX_TOOL_ARG_BYTES = 5 * 1024 * 1024;

  // Wave-5B Step 3: `findLatestUserMessage` + `pickBlockingGuardName` moved
  // to `./guardrail-helpers.ts`; `safeStringifyToolResult` (PERF-004) moved
  // into `iteration-runner.ts`; `doneEvent` inlined into `run()`.

  private isAborted(): boolean {
    return this.abortController.signal.aborted;
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
