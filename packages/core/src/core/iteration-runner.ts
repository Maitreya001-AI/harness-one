/**
 * IterationRunner — runs exactly one agent iteration.
 *
 * Owns the in-iteration choreography: input guardrail → adapter call
 * delegation → post-call abort/budget checks → output guardrail (when no tool
 * calls) → tool execution via `ExecutionStrategy` → tool_output guardrails →
 * conversation mutation. Pre-iteration checks (initial abort, max-iterations,
 * pre-call token budget) STAY in `AgentLoop.run()`.
 *
 * **Statelessness invariant**: IterationRunner carries NO per-run state on
 * its closure. Every mutable counter — cumulative usage, tool-call counter,
 * span id, end-fired flag — lives on {@link IterationContext}, which is
 * freshly allocated per `run()`. Reusing a single IterationRunner across
 * multiple runs is safe because there is nothing to reset.
 *
 * @module
 */

import type { ExecutionStrategy, Message, TokenUsage, ToolCallRequest } from './types.js';
import type { AgentEvent, DoneReason } from './events.js';
import { AbortedError, HarnessError, TokenBudgetExceededError, HarnessErrorCode} from './errors.js';
import type { AgentLoopHook } from './agent-loop-types.js';
import { createHookDispatcher } from './hook-dispatcher.js';
import type { AdapterCaller } from './adapter-caller.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { GuardrailPipeline } from './guardrail-port.js';
import {
  runInputGuardrail,
  runOutputGuardrail,
  runToolOutputGuardrail,
} from './guardrail-runner.js';
import { safeStringifyToolResult } from './tool-serialization.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Outcome returned by {@link IterationRunner.runIteration}.
 *
 * - `continue` — iteration succeeded; the orchestrator should run another
 *   iteration.
 * - `terminated` — the runner already yielded the terminal events
 *   (`message` / `error` / `guardrail_blocked` as required); the orchestrator
 *   should yield a `done` event with the carried `reason` + `totalUsage`
 *   and exit the loop.
 */
export type IterationOutcome =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'terminated';
      readonly reason: DoneReason;
      readonly totalUsage: TokenUsage;
    };

/**
 * Per-run mutable state passed to every `runIteration()` call.
 *
 * Freshly allocated by `AgentLoop.run()` for each run; the runner carries
 * no equivalent state. The orchestrator FORWARDS values from this context
 * back to its instance fields after each iteration so `getMetrics()` and
 * the `usage` getter remain accurate.
 */
export interface IterationContext {
  /** Caller-owned mutable conversation buffer. runIteration pushes assistant + tool messages. */
  readonly conversation: Message[];
  /** 1-based iteration counter; the orchestrator pre-increments before each runIteration call. */
  iteration: number;
  /** Cumulative stream bytes across prior iterations; runIteration updates in place. */
  readonly cumulativeStreamBytes: { value: number };
  /** Active iteration span id; runIteration manages endSpan; run()'s outer finally also reads this. */
  iterationSpanId: string | undefined;
  /** Trace id for starting child tool spans. */
  readonly traceId: string | undefined;
  /** Accumulated token usage across iterations; runIteration mutates after each successful adapter call. */
  readonly cumulativeUsage: { inputTokens: number; outputTokens: number };
  /** Tool-call counter across iterations; runIteration increments per tool_result yielded. */
  readonly toolCallCounter: { value: number };
  /** Once-fired flag for `onIterationEnd`; reset to `false` by the orchestrator before each runIteration call. */
  readonly iterationEndFired: { value: boolean };
}

/**
 * Configuration for the IterationRunner.
 *
 * Carries NO mutable boxes — the statelessness invariant relies on the
 * caller (AgentLoop.run()) handing fresh `IterationContext` boxes per run.
 */
export interface IterationRunnerConfig {
  readonly adapterCaller: AdapterCaller;
  readonly executionStrategy: ExecutionStrategy;
  readonly strategyOptions: Readonly<{
    readonly signal: AbortSignal;
    readonly getToolMeta?: (name: string) => { sequential?: boolean } | undefined;
  }>;
  /** AgentLoop's internal abort controller; bailOut aborts via this on hard-block. */
  readonly abortController: AbortController;
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly toolTimeoutMs?: number;
  readonly maxTotalTokens: number;
  readonly inputPipeline?: GuardrailPipeline;
  readonly outputPipeline?: GuardrailPipeline;
  readonly traceManager?: AgentLoopTraceManager;
  readonly hooks: readonly AgentLoopHook[];
  readonly strictHooks?: boolean;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Public surface of the iteration runner. */
export interface IterationRunner {
  /**
   * Run one iteration. Yields the same `AgentEvent`s the consumer would
   * see today; returns an {@link IterationOutcome} the orchestrator uses
   * to decide whether to continue or terminate.
   */
  runIteration(ctx: IterationContext): AsyncGenerator<AgentEvent, IterationOutcome>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function snapshotUsage(u: { inputTokens: number; outputTokens: number }): TokenUsage {
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an {@link IterationRunner} from an immutable config.
 *
 * The returned runner carries no per-run state — see the statelessness
 * invariant in the module docstring.
 */
export function createIterationRunner(config: Readonly<IterationRunnerConfig>): IterationRunner {
  const tm = config.traceManager;

  function isAborted(): boolean {
    return config.abortController.signal.aborted;
  }

  const runHook = createHookDispatcher({
    hooks: config.hooks,
    ...(config.strictHooks !== undefined && { strictHooks: config.strictHooks }),
    ...(config.logger !== undefined && { logger: config.logger }),
  });

  /** Close the active iteration span and clear the slot on the context. */
  function endSpan(ctx: IterationContext, status?: 'completed' | 'error'): void {
    if (ctx.iterationSpanId && tm) {
      try {
        tm.endSpan(ctx.iterationSpanId, status);
      } catch {
        // span may already be ended — non-fatal; outer finally is also defensive.
      }
      ctx.iterationSpanId = undefined;
    }
  }

  /** Fire `onIterationEnd` hooks once per iteration. Idempotent. */
  function fireIterationEnd(ctx: IterationContext, done: boolean): void {
    if (ctx.iterationEndFired.value) return;
    ctx.iterationEndFired.value = true;
    runHook('onIterationEnd', { iteration: ctx.iteration, done });
  }

  // -----------------------------------------------------------------------
  // Terminal helpers — one per {@link DoneReason} the runner is allowed to
  // emit. They replace the Wave-5B `bailOut` discriminated-union dispatcher
  // (round-3 cleanup, commit post-603f526). Each helper owns exactly the
  // yields/side-effects its reason needs:
  //
  //   bailEndTurn    → yield message;              span=completed; fire end(done=true)
  //   bailTokenBudget→ yield message + error;      span=error;     fire end(done=true)
  //   bailAborted    → yield error?;               span=error;     fire end(done=true)
  //   bailError      → yield error (or skip);      span=error;     fire end(done=true)
  //   bailGuardrail  → abort + yield guardrail+err;span=error;     fire end(done=true)
  //
  // Splitting makes each exit path reviewable on its own; adding a new
  // terminal reason no longer touches a shared switch statement.
  // -----------------------------------------------------------------------

  function terminated(
    ctx: IterationContext,
    reason: DoneReason,
  ): IterationOutcome {
    return {
      kind: 'terminated',
      reason,
      totalUsage: snapshotUsage(ctx.cumulativeUsage),
    };
  }

  async function* bailEndTurn(
    ctx: IterationContext,
    messageEvent: Extract<AgentEvent, { type: 'message' }>,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    yield messageEvent;
    endSpan(ctx, 'completed');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'end_turn');
  }

  async function* bailTokenBudget(
    ctx: IterationContext,
    messageEvent: Extract<AgentEvent, { type: 'message' }>,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    yield messageEvent;
    yield errorEvent;
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'token_budget');
  }

  async function* bailAborted(
    ctx: IterationContext,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    yield errorEvent;
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'aborted');
  }

  /**
   * General error terminal. `errorAlreadyYielded` skips the `error` event when
   * StreamHandler has already yielded it (streaming path) to preserve the
   * "exactly one error event per failed turn" contract.
   */
  async function* bailError(
    ctx: IterationContext,
    errorEvent: Extract<AgentEvent, { type: 'error' }> | undefined,
    errorAlreadyYielded: boolean,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    if (!errorAlreadyYielded && errorEvent) yield errorEvent;
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'error');
  }

  /**
   * Guardrail block terminal — always aborts upstream work and yields the
   * guardrail event before the error event so downstream filters see both.
   */
  async function* bailGuardrail(
    ctx: IterationContext,
    guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    config.abortController.abort();
    yield guardrailEvent;
    yield errorEvent;
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'error');
  }

  // -----------------------------------------------------------------------
  // runIteration body
  // -----------------------------------------------------------------------

  async function* runIteration(
    ctx: IterationContext,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    // [1] Input guardrail.
    {
      const outcome = await runInputGuardrail(ctx.conversation, config.inputPipeline);
      if (outcome.kind === 'blocked') {
        return yield* bailGuardrail(ctx, outcome.guardrailEvent, outcome.errorEvent);
      }
    }

    // [2] Adapter call (delegated to AdapterCaller; per-call onRetry binds
    //     to the current iteration span so adapter_retry events land on the
    //     right span without a side-channel). The adapter_retry span event
    //     carries `backoff_ms` and `retry_number` so operators can correlate
    //     retry latency with backoff strategy tuning.
    const result = yield* config.adapterCaller.call(
      ctx.conversation,
      ctx.cumulativeStreamBytes.value,
      (info) => {
        const spanId = ctx.iterationSpanId;
        if (!tm || !spanId) return;
        tm.addSpanEvent(spanId, {
          name: 'adapter_retry',
          attributes: {
            attempt: info.attempt,
            errorCategory: info.errorCategory,
            path: info.path,
            ...(info.errorPreview !== undefined ? { error: info.errorPreview } : {}),
            ...(info.backoffMs !== undefined ? { backoff_ms: info.backoffMs } : {}),
            ...(info.retryNumber !== undefined ? { retry_number: info.retryNumber } : {}),
          },
        });
      },
    );

    if (!result.ok) {
      const { error: err, errorCategory, path } = result;
      if (ctx.iterationSpanId && tm) {
        // Attach cumulative retry metrics and (on timeout) the configured
        // budget + adapter name so incident responders can distinguish
        // "timeout after N ms across K retries" from a single hard-fail
        // attempt without parsing error messages.
        tm.setSpanAttributes(ctx.iterationSpanId, {
          errorCategory,
          path,
          ...(path === 'chat'
            ? { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
            : {}),
          ...(result.totalBackoffMs !== undefined
            ? { total_backoff_ms: result.totalBackoffMs }
            : {}),
          ...(result.totalDurationMs !== undefined
            ? { total_duration_ms: result.totalDurationMs }
            : {}),
          ...(result.timeoutMs !== undefined ? { timeout_ms: result.timeoutMs } : {}),
          ...(result.adapterName !== undefined ? { adapter: result.adapterName } : {}),
        });
      }

      if (errorCategory === HarnessErrorCode.CORE_ABORTED) {
        // Abort fired during backoff (synthetic category from AdapterCaller).
        return yield* bailAborted(ctx, { type: 'error', error: new AbortedError() });
      }

      if (path === 'chat') {
        const errorEvent: Extract<AgentEvent, { type: 'error' }> = {
          type: 'error',
          error:
            err instanceof HarnessError
              ? err
              : new HarnessError(
                  err instanceof Error ? err.message : String(err),
                  errorCategory,
                  'Check adapter configuration and API credentials',
                  err instanceof Error ? err : undefined,
                ),
        };
        return yield* bailError(ctx, errorEvent, false);
      }
      // path === 'stream' — StreamHandler already yielded the {type:'error'}
      // event inside handle(); re-yielding would double-emit.
      return yield* bailError(ctx, undefined, true);
    }

    // Success: accumulate bytesRead (streaming path only — chat is 0).
    ctx.cumulativeStreamBytes.value += result.bytesRead;
    const assistantMsg = result.message;
    const responseUsage = result.usage;

    if (ctx.iterationSpanId && tm) {
      tm.setSpanAttributes(ctx.iterationSpanId, {
        inputTokens: responseUsage.inputTokens,
        outputTokens: responseUsage.outputTokens,
        toolCount:
          assistantMsg.role === 'assistant' && assistantMsg.toolCalls
            ? assistantMsg.toolCalls.length
            : 0,
        path: result.path,
        attempts: result.attempts,
        // Also annotate the happy path so retry-cost analysis can
        // differentiate "succeeded after N retries" from "succeeded on first
        // try" without cross-referencing adapter_retry events.
        ...(result.totalBackoffMs !== undefined
          ? { total_backoff_ms: result.totalBackoffMs }
          : {}),
        ...(result.totalDurationMs !== undefined
          ? { total_duration_ms: result.totalDurationMs }
          : {}),
      });
    }

    // [3] Post-call abort check.
    if (isAborted()) {
      return yield* bailAborted(ctx, { type: 'error', error: new AbortedError() });
    }

    // Accumulate usage (clamp to safe bounds — paranoia against buggy adapters).
    const safeInput = Math.min(Math.max(0, responseUsage.inputTokens), 1_000_000_000);
    const safeOutput = Math.min(Math.max(0, responseUsage.outputTokens), 1_000_000_000);
    ctx.cumulativeUsage.inputTokens += safeInput;
    ctx.cumulativeUsage.outputTokens += safeOutput;
    runHook('onCost', { iteration: ctx.iteration, usage: responseUsage });

    // [4] Post-call token budget.
    const postCallTokens =
      ctx.cumulativeUsage.inputTokens + ctx.cumulativeUsage.outputTokens;
    if (postCallTokens > config.maxTotalTokens) {
      return yield* bailTokenBudget(
        ctx,
        { type: 'message', message: assistantMsg, usage: responseUsage },
        {
          type: 'error',
          error: new TokenBudgetExceededError(postCallTokens, config.maxTotalTokens),
        },
      );
    }

    const toolCalls =
      assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined;

    // [5] No tool calls → output guardrail then end_turn.
    if (!toolCalls || toolCalls.length === 0) {
      const outcome = await runOutputGuardrail(
        assistantMsg.content ?? '',
        config.outputPipeline,
      );
      if (outcome.kind === 'blocked') {
        return yield* bailGuardrail(ctx, outcome.guardrailEvent, outcome.errorEvent);
      }
      return yield* bailEndTurn(ctx, {
        type: 'message',
        message: assistantMsg,
        usage: responseUsage,
      });
    }

    // [6] Tool calls — push assistant, yield tool_call events, execute.
    ctx.conversation.push(assistantMsg);

    for (const toolCall of toolCalls) {
      yield { type: 'tool_call', toolCall, iteration: ctx.iteration };
      runHook('onToolCall', { iteration: ctx.iteration, toolCall });
    }

    const executionResults = await config.executionStrategy.execute(
      toolCalls,
      async (call) => {
        const toolSpanId =
          tm && ctx.traceId && ctx.iterationSpanId
            ? tm.startSpan(ctx.traceId, `tool:${call.name}`, ctx.iterationSpanId)
            : undefined;
        if (toolSpanId && tm) {
          tm.setSpanAttributes(toolSpanId, {
            toolName: call.name,
            toolCallId: call.id,
          });
        }
        try {
          const toolPromise = config.onToolCall
            ? config.onToolCall(call)
            : Promise.resolve({
                error: `No onToolCall handler registered for tool "${call.name}"`,
              });

          let result: unknown;
          if (config.toolTimeoutMs !== undefined) {
            const timeoutMs = config.toolTimeoutMs;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;
            try {
              const timeoutPromise = new Promise<{ error: string }>((resolve) => {
                timer = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  resolve({
                    error: `Tool "${call.name}" timed out after ${timeoutMs}ms`,
                  });
                }, timeoutMs);
                if (typeof timer === 'object' && 'unref' in timer) {
                  (timer as NodeJS.Timeout).unref();
                }
              });
              const raced = await Promise.race([
                toolPromise.then((r) => {
                  settled = true;
                  if (timer !== undefined) clearTimeout(timer);
                  return r;
                }),
                timeoutPromise,
              ]);
              result = raced;
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          } else {
            result = await toolPromise;
          }

          if (toolSpanId && tm) tm.endSpan(toolSpanId);
          return result;
        } catch (toolErr) {
          if (toolSpanId && tm) {
            tm.setSpanAttributes(toolSpanId, {
              errorMessage: (toolErr instanceof Error
                ? toolErr.message
                : String(toolErr)
              ).slice(0, 500),
              errorName: toolErr instanceof Error ? toolErr.name : 'Unknown',
            });
            tm.endSpan(toolSpanId, 'error');
          }
          throw toolErr;
        }
      },
      config.strategyOptions,
    );

    for (const execResult of executionResults) {
      yield { type: 'tool_result', toolCallId: execResult.toolCallId, result: execResult.result };
      ctx.toolCallCounter.value++;

      let resultContent: string;
      try {
        resultContent =
          typeof execResult.result === 'string'
            ? execResult.result
            : safeStringifyToolResult(execResult.result);
      } catch {
        resultContent = '[Object could not be serialized]';
      }

      // Tool-output guardrail — block REWRITES the tool result into a stub;
      // loop continues. No bail, no abort.
      const originTool = toolCalls.find((c) => c.id === execResult.toolCallId);
      const toolOutcome = await runToolOutputGuardrail(
        resultContent,
        originTool?.name,
        execResult.toolCallId,
        config.outputPipeline,
      );
      if (toolOutcome.kind === 'blocked') {
        yield toolOutcome.guardrailEvent;
        resultContent = toolOutcome.replacementContent;
      }

      const toolResultMsg: Message = {
        role: 'tool',
        content: resultContent,
        toolCallId: execResult.toolCallId,
      };
      ctx.conversation.push(toolResultMsg);
    }

    // [7] Post-tools abort check.
    if (isAborted()) {
      return yield* bailAborted(ctx, { type: 'error', error: new AbortedError() });
    }

    // [8] Iteration completed normally; fire onIterationEnd(done=false), keep
    //     the span open for the orchestrator to close on its next pass through
    //     the while loop.
    fireIterationEnd(ctx, false);
    return { kind: 'continue' };
  }

  return { runIteration };
}
