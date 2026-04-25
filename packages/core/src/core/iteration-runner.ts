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

import type { AgentEvent, DoneReason } from './events.js';
import {
  AbortedError,
  HarnessError,
  HarnessErrorCode,
  TokenBudgetExceededError,
} from './errors.js';
import type { AgentLoopHookDispatcher } from './hook-dispatcher.js';
import type { AdapterCaller } from './adapter-caller.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { GuardrailPipeline } from './guardrail-port.js';
import type { ExecutionStrategy, Message, TokenUsage, ToolCallRequest } from './types.js';
import { annotateHarnessErrorSpan } from './error-span-attributes.js';
import {
  runInputGuardrail,
  runOutputGuardrail,
  runToolArgsGuardrail,
  runToolOutputGuardrail,
} from './guardrail-runner.js';
import { safeStringifyToolResult } from './tool-serialization.js';
import { createIterationLifecycle } from './iteration-lifecycle.js';
import type { BeforeChatHookDispatcher, BeforeToolCallHookDispatcher } from './hook-dispatcher.js';

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
  /** Wall-clock start of the run for duration-budget enforcement. */
  readonly runStartTimeMs: number;
  /**
   * Once-fired flag for `onIterationEnd`.
   *
   * **Caller contract**: the orchestrator (`AgentLoop.run()` via
   * `iteration-coordinator.startIteration`) MUST reset this to `false`
   * before every `runIteration()` call. IterationRunner NEVER touches the
   * box outside `fireIterationEnd()` and assumes a fresh `false` on entry.
   * Violating the contract (re-using a context across iterations without
   * resetting) silently suppresses the `onIterationEnd` hook on subsequent
   * iterations.
   */
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
  /**
   * Shared hook dispatcher owned by {@link AgentLoop}. Injecting the
   * pre-built dispatcher means we don't re-allocate a second one here with
   * potentially-divergent strictHooks / logger config.
   */
  readonly runHook: AgentLoopHookDispatcher;
  /** Shared async interceptors for pre-chat and pre-tool governance hooks. */
  readonly runBeforeChatHook: BeforeChatHookDispatcher;
  readonly runBeforeToolCallHook: BeforeToolCallHookDispatcher;
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
  const runHook = config.runHook;
  // Span + hook lifecycle (close span, fire onIterationEnd, all five
  // terminal-exit generators) lives in a dedicated component so this file
  // only owns stage choreography.
  const lifecycle = createIterationLifecycle({
    runHook,
    abortController: config.abortController,
    ...(tm !== undefined && { traceManager: tm }),
  });
  const { fireIterationEnd, bailEndTurn, bailTokenBudget, bailAborted, bailError, bailGuardrail } = lifecycle;

  function isAborted(): boolean {
    return config.abortController.signal.aborted;
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

    let adapterMessages = await config.runBeforeChatHook({
      messages: ctx.conversation,
      iteration: ctx.iteration,
    });
    if (adapterMessages !== ctx.conversation) {
      adapterMessages = [...adapterMessages];
      if (ctx.iterationSpanId && tm) {
        tm.addSpanEvent(ctx.iterationSpanId, {
          name: 'before_chat_modified',
          attributes: { messageCount: adapterMessages.length },
        });
      }
    }
    if (ctx.iterationSpanId && tm) {
      const provenance = adapterMessages.map((message) => message.meta?.provenance ?? 'unknown');
      tm.setSpanAttributes(ctx.iterationSpanId, {
        messageRoles: adapterMessages.map((message) => message.role),
        messageProvenances: provenance,
      });
    }

    // [2] Adapter call (delegated to AdapterCaller; per-call onRetry binds
    //     to the current iteration span so adapter_retry events land on the
    //     right span without a side-channel). The adapter_retry span event
    //     carries `backoff_ms` and `retry_number` so operators can correlate
    //     retry latency with backoff strategy tuning.
    const result = yield* config.adapterCaller.call(
      adapterMessages,
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
      const harnessError =
        err instanceof HarnessError
          ? err
          : path === 'chat'
            ? new HarnessError(
                err instanceof Error ? err.message : String(err),
                errorCategory,
                'Check adapter configuration and API credentials',
                err instanceof Error ? err : undefined,
              )
            : undefined;
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
        annotateHarnessErrorSpan(tm, ctx.iterationSpanId, harnessError);
      }

      if (errorCategory === HarnessErrorCode.CORE_ABORTED) {
        // Abort fired during backoff (synthetic category from AdapterCaller).
        return yield* bailAborted(ctx, { type: 'error', error: new AbortedError() });
      }

      if (path === 'chat') {
        if (!harnessError) {
          throw new Error('Invariant violation: chat adapter failures must map to HarnessError');
        }
        const errorEvent: Extract<AgentEvent, { type: 'error' }> = {
          type: 'error',
          error: harnessError,
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
    runHook('onTokenUsage', { iteration: ctx.iteration, usage: responseUsage });

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

    // [6] Tool calls — push assistant, run input pipeline on each tool's
    //     serialised arguments (no-op if `inputPipeline` is unset; preset
    //     users hit this path because the preset doesn't pass an input
    //     pipeline to the inner AgentLoop, deferring to its outer wrapper),
    //     then yield tool_call events, execute.
    ctx.conversation.push(assistantMsg);

    for (const toolCall of toolCalls) {
      const argOutcome = await runToolArgsGuardrail(
        toolCall.arguments,
        toolCall.name,
        toolCall.id,
        config.inputPipeline,
      );
      if (argOutcome.kind === 'blocked') {
        return yield* bailGuardrail(ctx, argOutcome.guardrailEvent, argOutcome.errorEvent);
      }
      yield { type: 'tool_call', toolCall, iteration: ctx.iteration };
      runHook('onToolCall', { iteration: ctx.iteration, toolCall });
    }

    const executionResults = await config.executionStrategy.execute(
      toolCalls,
      async (call) => {
        const interceptedCall = await config.runBeforeToolCallHook({
          call,
          iteration: ctx.iteration,
        });
        if ('abort' in interceptedCall && interceptedCall.abort) {
          if (ctx.iterationSpanId && tm) {
            tm.addSpanEvent(ctx.iterationSpanId, {
              name: 'before_tool_call_aborted',
              attributes: {
                toolName: call.name,
                toolCallId: call.id,
                reason: interceptedCall.reason,
              },
            });
          }
          return { error: interceptedCall.reason };
        }
        const actualCall = interceptedCall as ToolCallRequest;
        if (interceptedCall !== call && ctx.iterationSpanId && tm) {
          tm.addSpanEvent(ctx.iterationSpanId, {
            name: 'before_tool_call_modified',
            attributes: {
              toolName: call.name,
              toolCallId: call.id,
              modifiedToolName: actualCall.name,
            },
          });
        }
        const toolSpanId =
          tm && ctx.traceId && ctx.iterationSpanId
            ? tm.startSpan(ctx.traceId, `tool:${actualCall.name}`, ctx.iterationSpanId)
            : undefined;
        if (toolSpanId && tm) {
          tm.setSpanAttributes(toolSpanId, {
            toolName: actualCall.name,
            toolCallId: actualCall.id,
          });
        }
        try {
          const toolPromise = config.onToolCall
            ? config.onToolCall(actualCall)
            : Promise.resolve({
                error: `No onToolCall handler registered for tool "${actualCall.name}"`,
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
                    error: `Tool "${actualCall.name}" timed out after ${timeoutMs}ms`,
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
            annotateHarnessErrorSpan(tm, toolSpanId, toolErr);
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
      } catch (serializeErr) {
        resultContent = '[Object could not be serialized]';
        // Surface the failure so operators see why the tool message became a
        // stub. Silent fallback makes it look like the tool returned the
        // placeholder string, which is confusing at debug time.
        yield {
          type: 'warning',
          message: `Tool result for "${execResult.toolCallId}" failed to serialize (${
            serializeErr instanceof Error ? serializeErr.message : String(serializeErr)
          }); sending "[Object could not be serialized]" to the model.`,
        };
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
        meta: {
          provenance: 'tool_result',
          ...(originTool?.name !== undefined && { provenanceDetail: originTool.name }),
        },
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
