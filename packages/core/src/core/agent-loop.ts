/**
 * AgentLoop — the core agent execution loop.
 *
 * Calls the LLM adapter in a loop, dispatching tool calls and feeding
 * results back until the LLM stops requesting tools, or a safety valve
 * triggers. The class owns configuration, lifecycle state, and
 * composition; the event-sequencing state machine (startRun,
 * checkPreIteration, startIteration, finalizeRun) lives in
 * `./iteration-coordinator.ts`.
 *
 * @module
 */

import type { Message, TokenUsage } from './types.js';
import type { AgentEvent } from './events.js';
import { HarnessError, HarnessErrorCode } from './errors.js';
import { createAdapterCaller, type AdapterCaller } from './adapter-caller.js';
import { createStreamHandler } from './stream-handler.js';
// Per-iteration choreography lives in IterationRunner.
import {
  createIterationRunner,
  type IterationRunner,
} from './iteration-runner.js';
import type { AgentLoopConfig } from './agent-loop-types.js';
import { createHookDispatcher } from './hook-dispatcher.js';
import {
  resolveAgentLoopConfig,
  type ResolvedAgentLoopConfig,
  MAX_STREAM_BYTES,
} from './agent-loop-config.js';
import {
  startRun,
  checkPreIteration,
  startIteration,
  finalizeRun,
  releaseExternalSignal,
  type CoordinatorDeps,
  type CoordinatorState,
} from './iteration-coordinator.js';

export type { AgentLoopTraceManager } from './trace-interface.js';
export type { AgentLoopConfig, AgentLoopHook } from './agent-loop-types.js';

/**
 * Stateful agent loop that calls an LLM adapter in a loop, handling tool calls.
 *
 * Prefer {@link createAgentLoop} for construction; reach for the class only
 * when a TYPE reference is required (return types, `instanceof` narrowing).
 *
 * @example
 * ```ts
 * const loop = createAgentLoop({ adapter, onToolCall: handleTool });
 * for await (const event of loop.run(messages)) {
 *   console.log(event.type);
 * }
 * ```
 */
export class AgentLoop {
  private readonly resolved: ResolvedAgentLoopConfig;
  private readonly adapterCaller: AdapterCaller;
  private readonly iterationRunner: IterationRunner;
  private readonly runHook: ReturnType<typeof createHookDispatcher>;
  private readonly abortController: AbortController;
  private readonly state: CoordinatorState;
  /** Frozen deps bag shared with `./iteration-coordinator.ts`. */
  private readonly coordDeps: CoordinatorDeps;
  /**
   * Pre-built options bag handed to `executionStrategy.execute()` for every
   * tool-call batch. Built once at construction so the same frozen reference
   * is reused across batches instead of allocating per-batch.
   */
  private readonly _strategyOptions: {
    readonly signal: AbortSignal;
    readonly getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
  };

  constructor(config: AgentLoopConfig) {
    this.resolved = resolveAgentLoopConfig(config);
    const { hooks, observability, limits, pipelines, streaming } = this.resolved;

    this.runHook = createHookDispatcher({
      hooks: hooks.registered,
      strictHooks: hooks.strict,
      ...(observability.logger !== undefined && { logger: observability.logger }),
    });

    this.abortController = new AbortController();
    this.state = {
      noPipelineWarned: false,
      status: 'idle',
      iterationObserved: 0,
      cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
      externalAbortHandler: undefined,
    };
    this.coordDeps = Object.freeze<CoordinatorDeps>({
      abortController: this.abortController,
      ...(this.resolved.externalSignal !== undefined && {
        externalSignal: this.resolved.externalSignal,
      }),
      ...(observability.traceManager !== undefined && {
        traceManager: observability.traceManager,
      }),
      ...(observability.logger !== undefined && { logger: observability.logger }),
      maxIterations: limits.maxIterations,
      maxTotalTokens: limits.maxTotalTokens,
      ...(limits.maxConversationMessages !== undefined && {
        maxConversationMessages: limits.maxConversationMessages,
      }),
      adapterName: this.resolved.adapter.name ?? 'unknown',
      streaming,
      hasInputPipeline: pipelines.input !== undefined,
      hasOutputPipeline: pipelines.output !== undefined,
      runHook: this.runHook,
    });

    const seqToolPredicate = this.resolved.isSequentialTool;
    this._strategyOptions = Object.freeze(
      seqToolPredicate
        ? {
            signal: this.abortController.signal,
            getToolMeta: (name: string): { sequential?: boolean } | undefined => ({
              sequential: seqToolPredicate(name),
            }),
          }
        : { signal: this.abortController.signal },
    );

    const streamHandler = createStreamHandler({
      adapter: this.resolved.adapter,
      signal: this.abortController.signal,
      maxStreamBytes: limits.maxStreamBytes,
      maxToolArgBytes: limits.maxToolArgBytes,
      // Secondary cumulative backstop: one pathological loop that never
      // trips `maxStreamBytes` on a single iteration could still burn
      // unbounded memory by streaming ~maxStreamBytes on every iteration.
      // Capping at `maxIterations × maxStreamBytes` keeps total buffered
      // bytes bounded by the configured product; the per-iteration cap
      // is the real knob operators should tune. See `MAX_STREAM_BYTES`
      // TSDoc for the full semantics.
      maxCumulativeStreamBytes: limits.maxIterations * limits.maxStreamBytes,
      ...(this.resolved.tools !== undefined && { tools: this.resolved.tools }),
    });

    const effectiveStreaming =
      streaming && typeof this.resolved.adapter.stream === 'function';

    this.adapterCaller = createAdapterCaller({
      adapter: this.resolved.adapter,
      signal: this.abortController.signal,
      streaming: effectiveStreaming,
      maxAdapterRetries: limits.maxAdapterRetries,
      baseRetryDelayMs: limits.baseRetryDelayMs,
      retryableErrors: limits.retryableErrors,
      streamHandler,
      ...(this.resolved.tools !== undefined && { tools: this.resolved.tools }),
    });

    this.iterationRunner = createIterationRunner({
      adapterCaller: this.adapterCaller,
      executionStrategy: this.resolved.executionStrategy,
      strategyOptions: this._strategyOptions,
      abortController: this.abortController,
      maxTotalTokens: limits.maxTotalTokens,
      // Share the single dispatcher so both the coordinator and the runner
      // fire the same hook instances with the same strictness/logger bundle.
      runHook: this.runHook,
      ...(this.resolved.onToolCall !== undefined && { onToolCall: this.resolved.onToolCall }),
      ...(limits.toolTimeoutMs !== undefined && { toolTimeoutMs: limits.toolTimeoutMs }),
      ...(pipelines.input !== undefined && { inputPipeline: pipelines.input }),
      ...(pipelines.output !== undefined && { outputPipeline: pipelines.output }),
      ...(observability.traceManager !== undefined && {
        traceManager: observability.traceManager,
      }),
    });
  }

  /** Get cumulative token usage across all iterations. */
  get usage(): TokenUsage {
    return {
      inputTokens: this.state.cumulativeUsage.inputTokens,
      outputTokens: this.state.cumulativeUsage.outputTokens,
    };
  }

  /** Abort the loop at the next safe point and cancel in-flight adapter calls. */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Dispose the loop, releasing resources and cancelling any pending operations.
   *
   * When the execution strategy implements the optional `dispose()` method,
   * we forward the call (fire-and-forget) so long-lived strategies (worker
   * pools, persistent queues, etc.) can release their resources at loop
   * shutdown. Errors from strategy dispose are swallowed — the loop's own
   * teardown must not be blocked by strategy-specific failures.
   */
  dispose(): void {
    try {
      // Single-owner listener cleanup. If finalizeRun() already detached
      // the handler, releaseExternalSignal is a cheap no-op; if dispose()
      // runs first (e.g. the consumer never called run()), we ensure no
      // dangling listener survives.
      releaseExternalSignal(this.coordDeps, this.state);
      this.abortController.abort();
      const strategyDispose = this.resolved.executionStrategy.dispose;
      if (typeof strategyDispose === 'function') {
        try {
          const p = strategyDispose.call(this.resolved.executionStrategy);
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
      this.state.status = 'disposed';
    }
  }

  /** Last-observed total tool-call count, stamped by run() each iteration. */
  private _lastTotalToolCalls = 0;

  /** Get a snapshot of the loop's current metrics. */
  getMetrics(): { iteration: number; totalToolCalls: number; usage: TokenUsage } {
    return {
      iteration: this.state.iterationObserved,
      totalToolCalls: this._lastTotalToolCalls,
      usage: this.usage,
    };
  }

  /**
   * Current lifecycle status of the loop.
   *
   * See {@link AgentLoopStatus} for the full shape.
   * `'completed'` is reserved for normal `end_turn` terminations; abnormal
   * exits (abort, max_iterations, token_budget, guardrail block, error)
   * land on `'errored'`. Once `dispose()` has been called the status is
   * permanently `'disposed'` — a concurrent in-flight `run()` cannot
   * overwrite it.
   */
  get status(): import('./types.js').AgentLoopStatus {
    return this.state.status;
  }

  /**
   * Run the agent loop, yielding events as they occur.
   *
   * Orchestration only — the ceremony lives in `./iteration-coordinator.ts`.
   *
   * @example
   * ```ts
   * for await (const event of loop.run(messages)) {
   *   if (event.type === 'done') break;
   * }
   * ```
   */
  async *run(messages: Message[]): AsyncGenerator<AgentEvent> {
    if (this.state.status === 'running') {
      throw new HarnessError(
        'AgentLoop.run() is already running — re-entrancy is not supported',
        HarnessErrorCode.CORE_INVALID_STATE,
        'Await the first run() before calling again, or use separate AgentLoop instances for parallel execution',
      );
    }

    const { ctx, tm, traceId } = startRun(this.coordDeps, this.state, messages);
    let iteration = 0;
    let totalToolCalls = 0;
    let finalEventEmitted = false;

    try {
      while (true) {
        const stop = yield* checkPreIteration(
          this.coordDeps,
          this.state,
          ctx,
          tm,
          () => iteration,
          (next) => { iteration = next; },
          this.usage,
        );
        if (stop) {
          finalEventEmitted = true;
          return;
        }

        yield* startIteration(this.coordDeps, ctx, tm, traceId, iteration);

        const outcome = yield* this.iterationRunner.runIteration(ctx);

        totalToolCalls = ctx.toolCallCounter.value;
        this.state.cumulativeUsage = {
          inputTokens: ctx.cumulativeUsage.inputTokens,
          outputTokens: ctx.cumulativeUsage.outputTokens,
        };

        if (outcome.kind === 'terminated') {
          // `end_turn` is the only normal terminator; everything else
          // (aborted / max_iterations / token_budget / error) lands on
          // `'errored'`. dispose() has precedence — once disposed, the
          // status cannot be overwritten by a terminal race.
          if (this.state.status !== 'disposed') {
            this.state.status = outcome.reason === 'end_turn' ? 'completed' : 'errored';
          }
          finalEventEmitted = true;
          yield {
            type: 'done',
            reason: outcome.reason,
            totalUsage: outcome.totalUsage,
          };
          return;
        }
      }
    } finally {
      // Stamp the final tool-call tally into getMetrics() before tearing down.
      this._lastTotalToolCalls = totalToolCalls;
      finalizeRun(this.coordDeps, this.state, ctx, tm, traceId, finalEventEmitted);
    }
  }

  /** Maximum accumulated stream content size to prevent memory exhaustion. */
  static readonly MAX_STREAM_BYTES = MAX_STREAM_BYTES;
}

/**
 * Functional alias for `new AgentLoop(config)`. Prefer this form for
 * consistency with the rest of the harness-one API.
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
