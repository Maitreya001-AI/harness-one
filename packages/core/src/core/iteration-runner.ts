/**
 * IterationRunner — runs exactly one agent iteration.
 *
 * Wave-5B Step 3: extracted from `AgentLoop.run()` (former L642-L997). Owns
 * the in-iteration choreography: input guardrail → adapter call delegation
 * → post-call abort/budget checks → output guardrail (when no tool calls)
 * → tool execution via `ExecutionStrategy` → tool_output guardrails →
 * conversation mutation. Pre-iteration checks (initial abort, max-iterations,
 * pre-call token budget) STAY in `run()`.
 *
 * **Statelessness invariant** (ADR §2.3 / §9 R8 / R9): IterationRunner
 * carries NO per-run state on its closure. Every mutable counter — cumulative
 * usage, tool-call counter, span id, end-fired flag — lives on
 * {@link IterationContext}, which is freshly allocated per `run()`. Reusing
 * a single IterationRunner across multiple runs is safe because there is
 * nothing to reset.
 *
 * See `docs/forge-fix/wave-5/wave-5b-adr-v2.md` §2.3, §3, §4, §6, §7 Step 3.
 *
 * @module
 */

import type { ExecutionStrategy, Message, TokenUsage, ToolCallRequest } from './types.js';
import type { AgentEvent, DoneReason } from './events.js';
import { assertNever } from './events.js';
import { AbortedError, HarnessError, TokenBudgetExceededError } from './errors.js';
import type { AgentLoopHook } from './agent-loop.js';
import type { AdapterCaller } from './adapter-caller.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { GuardrailPipeline } from '../guardrails/pipeline.js';
import { runInput, runOutput, runToolOutput } from '../guardrails/pipeline.js';
import { findLatestUserMessage, pickBlockingGuardName } from './guardrail-helpers.js';

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
 * the `usage` getter remain accurate (see ADR §7 Step 3 field migration).
 */
export interface IterationContext {
  /** Caller-owned mutable conversation buffer. runIteration pushes assistant + tool messages. */
  readonly conversation: Message[];
  /** 1-based iteration counter; the orchestrator pre-increments before each runIteration call. */
  iteration: number;
  /** Cumulative stream bytes across prior iterations; runIteration updates in place. */
  readonly cumulativeStreamBytes: { value: number };
  /** Active iteration span id; runIteration manages endSpan; run()'s outer finally also reads this (R5). */
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
// Private bailOut input shapes (discriminated union — ADR §4)
// ---------------------------------------------------------------------------

type ErrorBail = {
  /**
   * `'max_iterations'` is intentionally absent: per ADR-v2 §4, the
   * max-iterations terminal is emitted by `AgentLoop`'s `emitTerminal`
   * path, not through `bailOut`. Narrowing here prevents a future code
   * path from accidentally routing it through the runner.
   */
  readonly reason: 'error' | 'aborted';
  readonly errorEvent?: Extract<AgentEvent, { type: 'error' }>;
  /**
   * Skip yielding errorEvent when the event is already on the wire
   * (streaming failure path — StreamHandler yielded it). Default: false.
   */
  readonly errorAlreadyYielded?: boolean;
};

type GuardrailBail = {
  readonly reason: 'error';
  /** Required — guardrail blocks ALWAYS abort upstream work. */
  readonly abort: true;
  readonly guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>;
  readonly errorEvent: Extract<AgentEvent, { type: 'error' }>;
};

type BudgetBail = {
  readonly reason: 'token_budget';
  /** Required — today's L780 yields the message before the error. */
  readonly messageEvent: Extract<AgentEvent, { type: 'message' }>;
  readonly errorEvent: Extract<AgentEvent, { type: 'error' }>;
};

type EndTurnBail = {
  readonly reason: 'end_turn';
  /** Required — end_turn MUST yield the final assistant message. */
  readonly messageEvent: Extract<AgentEvent, { type: 'message' }>;
};

type BailOutInput = ErrorBail | GuardrailBail | BudgetBail | EndTurnBail;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum serialized tool result size (1 MiB). */
const MAX_TOOL_RESULT_BYTES = 1 * 1024 * 1024;
/** Maximum object nesting depth for tool-result serialization. */
const MAX_TOOL_RESULT_DEPTH = 10;

/**
 * PERF-004: defensive serialization for tool-call results. Moved here
 * from `AgentLoop.safeStringifyToolResult`; no copy remains on AgentLoop.
 * Depth-limited replacer + 1 MiB byte cap + cycle detection.
 */
function safeStringifyToolResult(value: unknown): string {
  const stack: Array<object> = [];

  const replacer = function (this: unknown, _key: string, val: unknown): unknown {
    if (val === null || typeof val !== 'object') return val;
    if (this && typeof this === 'object') {
      const parentIdx = stack.lastIndexOf(this as object);
      if (parentIdx >= 0) stack.length = parentIdx + 1;
    }
    if (stack.includes(val as object)) return '[circular]';
    if (stack.length >= MAX_TOOL_RESULT_DEPTH) return '[max depth exceeded]';
    stack.push(val as object);
    return val;
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(value, replacer);
  } catch {
    return '[Object could not be serialized]';
  }
  if (serialized === undefined) return '[result not serializable]';
  if (serialized.length > MAX_TOOL_RESULT_BYTES) return '[result too large]';
  return serialized;
}

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

  /** Run all registered hooks for `event`; swallow + log per-hook errors. */
  function runHook<E extends keyof AgentLoopHook>(
    event: E,
    info: Parameters<NonNullable<AgentLoopHook[E]>>[0],
  ): void {
    if (config.hooks.length === 0) return;
    for (const hook of config.hooks) {
      const fn = hook[event];
      if (typeof fn !== 'function') continue;
      try {
        (fn as (i: typeof info) => void).call(hook, info);
      } catch (err) {
        if (config.logger) {
          try {
            config.logger.warn('[harness-one/agent-loop] hook threw', {
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

  /**
   * Discriminated-union terminal — yields the right event sequence and
   * returns a {@link IterationOutcome}. ADR §4 v2.
   */
  async function* bailOut(
    ctx: IterationContext,
    input: BailOutInput,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    switch (input.reason) {
      case 'end_turn': {
        yield input.messageEvent;
        endSpan(ctx, 'completed');
        fireIterationEnd(ctx, true);
        return {
          kind: 'terminated',
          reason: 'end_turn',
          totalUsage: snapshotUsage(ctx.cumulativeUsage),
        };
      }
      case 'token_budget': {
        yield input.messageEvent;
        yield input.errorEvent;
        endSpan(ctx, 'error');
        fireIterationEnd(ctx, true);
        return {
          kind: 'terminated',
          reason: 'token_budget',
          totalUsage: snapshotUsage(ctx.cumulativeUsage),
        };
      }
      case 'error':
      case 'aborted': {
        // ErrorBail OR GuardrailBail (both discriminate on reason:'error').
        if ('abort' in input && input.abort) config.abortController.abort();
        if ('guardrailEvent' in input) yield input.guardrailEvent;
        const alreadyYielded =
          'errorAlreadyYielded' in input && input.errorAlreadyYielded === true;
        if (!alreadyYielded && input.errorEvent) yield input.errorEvent;
        endSpan(ctx, 'error');
        fireIterationEnd(ctx, true);
        return {
          kind: 'terminated',
          reason: input.reason,
          totalUsage: snapshotUsage(ctx.cumulativeUsage),
        };
      }
      default:
        // Compile-time exhaustiveness: adding a new `reason` to
        // {@link BailOutInput} without a matching case will fail here.
        return assertNever(input);
    }
  }

  // -----------------------------------------------------------------------
  // runIteration body
  // -----------------------------------------------------------------------

  async function* runIteration(
    ctx: IterationContext,
  ): AsyncGenerator<AgentEvent, IterationOutcome> {
    // [1] Input guardrail (Wave-5A hook point).
    if (config.inputPipeline) {
      const latestUser = findLatestUserMessage(ctx.conversation);
      if (latestUser !== undefined) {
        const result = await runInput(config.inputPipeline, { content: latestUser });
        if (!result.passed && result.verdict.action === 'block') {
          const guardName = pickBlockingGuardName(result, 'input');
          const reason = result.verdict.reason;
          const guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }> = {
            type: 'guardrail_blocked',
            phase: 'input',
            guardName,
            details: { reason },
          };
          const errorEvent: Extract<AgentEvent, { type: 'error' }> = {
            type: 'error',
            error: new HarnessError(
              `guardrail "${guardName}" blocked input — ${reason}`,
              'GUARDRAIL_VIOLATION',
              'Review the input pipeline configuration and sanitize the user message',
            ),
          };
          return yield* bailOut(ctx, {
            reason: 'error',
            abort: true,
            guardrailEvent,
            errorEvent,
          });
        }
      }
    }

    // [2] Adapter call (delegated to AdapterCaller; per-call onRetry binds
    //     to the current iteration span so adapter_retry events land on the
    //     right span without a side-channel).
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
          },
        });
      },
    );

    if (!result.ok) {
      const { error: err, errorCategory, path } = result;
      if (ctx.iterationSpanId && tm) {
        tm.setSpanAttributes(ctx.iterationSpanId, {
          errorCategory,
          path,
          ...(path === 'chat'
            ? { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }
            : {}),
        });
      }

      if (errorCategory === 'ABORTED') {
        // Abort fired during backoff (synthetic category from AdapterCaller).
        return yield* bailOut(ctx, {
          reason: 'aborted',
          errorEvent: { type: 'error', error: new AbortedError() },
        });
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
        return yield* bailOut(ctx, { reason: 'error', errorEvent });
      }
      // path === 'stream' — StreamHandler already yielded the {type:'error'}
      // event inside handle(); re-yielding would double-emit (ADR §9 R1).
      return yield* bailOut(ctx, { reason: 'error', errorAlreadyYielded: true });
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
      });
    }

    // [3] Post-call abort check.
    if (isAborted()) {
      return yield* bailOut(ctx, {
        reason: 'aborted',
        errorEvent: { type: 'error', error: new AbortedError() },
      });
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
      return yield* bailOut(ctx, {
        reason: 'token_budget',
        messageEvent: { type: 'message', message: assistantMsg, usage: responseUsage },
        errorEvent: {
          type: 'error',
          error: new TokenBudgetExceededError(postCallTokens, config.maxTotalTokens),
        },
      });
    }

    const toolCalls =
      assistantMsg.role === 'assistant' ? assistantMsg.toolCalls : undefined;

    // [5] No tool calls → output guardrail then end_turn.
    if (!toolCalls || toolCalls.length === 0) {
      if (config.outputPipeline) {
        const finalContent = assistantMsg.content ?? '';
        const outputResult = await runOutput(config.outputPipeline, {
          content: finalContent,
        });
        if (!outputResult.passed && outputResult.verdict.action === 'block') {
          const guardName = pickBlockingGuardName(outputResult, 'output');
          const reason = outputResult.verdict.reason;
          const guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }> = {
            type: 'guardrail_blocked',
            phase: 'output',
            guardName,
            details: { reason },
          };
          const errorEvent: Extract<AgentEvent, { type: 'error' }> = {
            type: 'error',
            error: new HarnessError(
              `guardrail "${guardName}" blocked output — ${reason}`,
              'GUARDRAIL_VIOLATION',
              'Review the output pipeline configuration and the model response',
            ),
          };
          return yield* bailOut(ctx, {
            reason: 'error',
            abort: true,
            guardrailEvent,
            errorEvent,
          });
        }
      }
      return yield* bailOut(ctx, {
        reason: 'end_turn',
        messageEvent: { type: 'message', message: assistantMsg, usage: responseUsage },
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

      // Tool-output guardrail (Wave-5A hook point) — block REWRITES the
      // tool result into a stub; loop continues. No bailOut, no abort.
      if (config.outputPipeline) {
        const originTool = toolCalls.find((c) => c.id === execResult.toolCallId);
        const toolGuardResult = await runToolOutput(
          config.outputPipeline,
          resultContent,
          originTool?.name,
        );
        if (!toolGuardResult.passed && toolGuardResult.verdict.action === 'block') {
          const guardName = pickBlockingGuardName(toolGuardResult, 'output');
          const reason = toolGuardResult.verdict.reason;
          yield {
            type: 'guardrail_blocked',
            phase: 'tool_output',
            guardName,
            details: {
              toolCallId: execResult.toolCallId,
              toolName: originTool?.name,
              reason,
            },
          };
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
      ctx.conversation.push(toolResultMsg);
    }

    // [7] Post-tools abort check.
    if (isAborted()) {
      return yield* bailOut(ctx, {
        reason: 'aborted',
        errorEvent: { type: 'error', error: new AbortedError() },
      });
    }

    // [8] Iteration completed normally; fire onIterationEnd(done=false), keep
    //     the span open for the orchestrator to close on its next pass through
    //     the while loop (matches today's L611 "end previous iteration span").
    fireIterationEnd(ctx, false);
    return { kind: 'continue' };
  }

  return { runIteration };
}
