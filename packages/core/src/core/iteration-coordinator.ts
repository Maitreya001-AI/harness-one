/**
 * Iteration choreography — the event-sequencing state machine that
 * drives `AgentLoop.run()`.
 *
 * The coordinator owns the ordering contract for yields, hooks, spans,
 * and abort checks. It is deliberately dependency-light: it consumes a
 * {@link CoordinatorDeps} bag (just the fields the state machine needs)
 * and leaves long-lived state — the IterationContext, cumulativeUsage,
 * abort controller — on the AgentLoop instance.
 *
 * @module
 */

import type { AgentEvent, DoneReason } from './events.js';
import {
  AbortedError,
  MaxIterationsError,
  HarnessError,
  HarnessErrorCode,
  TokenBudgetExceededError,
} from './errors.js';
import type { Message, TokenUsage } from './types.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import type { IterationContext } from './iteration-runner.js';
import { pruneConversation } from './conversation-pruner.js';
import { safeWarn } from '../infra/safe-log.js';
import type { AgentLoopLogger } from './agent-loop-config.js';

/** Minimal view the coordinator needs on the owning AgentLoop instance. */
export interface CoordinatorDeps {
  /** Internal abort controller that the loop and coordinator share. */
  readonly abortController: AbortController;
  /** External abort signal, if wired. */
  readonly externalSignal?: AbortSignal;
  /** Resolved trace manager, or undefined when tracing is off. */
  readonly traceManager?: AgentLoopTraceManager;
  /** Resolved logger for the one-time "no pipeline" warning. */
  readonly logger?: AgentLoopLogger;
  /** Max iterations safety valve (strictly greater-than triggers terminal). */
  readonly maxIterations: number;
  /** Cumulative token budget (strictly greater-than triggers terminal). */
  readonly maxTotalTokens: number;
  /** Optional wall-clock budget for a single run. */
  readonly maxDurationMs?: number;
  /** Optional hard cap on messages carried between turns. */
  readonly maxConversationMessages?: number;
  /** Adapter name, attached as a span attribute for filtering. */
  readonly adapterName: string;
  /** Whether streaming is enabled; attached as a span attribute. */
  readonly streaming: boolean;
  /** Whether any input guardrail pipeline is configured. */
  readonly hasInputPipeline: boolean;
  /** Whether any output guardrail pipeline is configured. */
  readonly hasOutputPipeline: boolean;
  /** Fires `onIterationStart` via the shared hook dispatcher. */
  readonly runHook: (event: 'onIterationStart', payload: { iteration: number }) => void;
}

/** Per-run mutable flags owned by the AgentLoop but mutated through the coordinator. */
export interface CoordinatorState {
  /** Whether the "no pipeline" warning has already fired on this instance. */
  noPipelineWarned: boolean;
  /**
   * Public-facing lifecycle status. The coordinator flips it to `'running'`
   * on `startRun` and to either `'completed'` (normal `end_turn`) or
   * `'errored'` (abort / max-iterations / token-budget / guardrail block /
   * adapter or tool error) on terminal. `dispose()` flips it to
   * `'disposed'` and any later terminal emit must respect that.
   */
  status: 'idle' | 'running' | 'completed' | 'errored' | 'disposed';
  /**
   * Observable iteration counter exposed via `AgentLoop.getMetrics()`.
   * Mirrors the local `iteration` variable in `run()` and is bumped by
   * {@link checkPreIteration} before the runner runs.
   */
  iterationObserved: number;
  /** Public cumulative usage snapshot, kept in lockstep with ctx.cumulativeUsage. */
  cumulativeUsage: { inputTokens: number; outputTokens: number };
  /** Handler installed on the external signal; cleared on finalize/dispose. */
  externalAbortHandler: (() => void) | undefined;
}

/** Return-value shape of {@link startRun}. */
export interface StartRunResult {
  ctx: IterationContext;
  tm: AgentLoopTraceManager | undefined;
  traceId: string | undefined;
}

/**
 * run() ceremony — status flip, no-pipeline warning, external-signal wiring,
 * trace creation, and IterationContext allocation. Returns the trio the
 * orchestrator threads through every iteration.
 */
export function startRun(
  deps: CoordinatorDeps,
  state: CoordinatorState,
  messages: Message[],
): StartRunResult {
  const conversation = [...messages];
  state.status = 'running';

  // One-time security warning when neither pipeline is configured.
  if (!state.noPipelineWarned && !deps.hasInputPipeline && !deps.hasOutputPipeline) {
    state.noPipelineWarned = true;
    const msg = 'AgentLoop has no guardrail pipeline — security risk';
    const meta = { hint: 'use createSecurePreset' };
    if (deps.logger) {
      try { deps.logger.warn(msg, meta); } catch { /* logger failure non-fatal */ }
    } else {
      safeWarn(undefined, msg, meta);
    }
  }

  // External signal listener — attached at run() start so finalizeRun can
  // always remove it, even if dispose() is never called.
  if (deps.externalSignal) {
    if (deps.externalSignal.aborted) {
      deps.abortController.abort();
    } else {
      const handler = (): void => {
        if (state.status === 'disposed') return;
        deps.abortController.abort();
      };
      state.externalAbortHandler = handler;
      deps.externalSignal.addEventListener('abort', handler, { once: true });
    }
  }

  const tm = deps.traceManager;
  const traceId = tm
    ? tm.startTrace('agent-loop-run', { messageCount: messages.length })
    : undefined;

  const ctx: IterationContext = {
    conversation,
    iteration: 0,
    cumulativeStreamBytes: { value: 0 },
    iterationSpanId: undefined,
    traceId,
    cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
    toolCallCounter: { value: 0 },
    runStartTimeMs: Date.now(),
    iterationEndFired: { value: false },
  };

  return { ctx, tm, traceId };
}

/**
 * Emit a terminal event pair (`error` + `done`) without going through the
 * iteration runner. Used for the three pre-iteration exits (abort,
 * max_iterations, token_budget) where no iteration_start has been yielded.
 *
 * Sets `state.status = 'errored'` to distinguish abnormal terminals
 * (abort, max_iterations, token_budget) from a normal `end_turn` completion,
 * which goes through `AgentLoop.run` directly and lands on `'completed'`.
 * If `dispose()` has already flipped the state to `'disposed'`, the
 * terminal emit does NOT overwrite it — disposed is a sink state.
 */
function* emitTerminal(
  state: CoordinatorState,
  ctx: IterationContext,
  tm: AgentLoopTraceManager | undefined,
  reason: DoneReason,
  errorEvent: Extract<AgentEvent, { type: 'error' }>,
  usage: TokenUsage,
): Generator<AgentEvent> {
  if (ctx.iterationSpanId && tm) {
    try { tm.endSpan(ctx.iterationSpanId, 'error'); } catch { /* defensive */ }
    ctx.iterationSpanId = undefined;
  }
  yield errorEvent;
  if (state.status !== 'disposed') state.status = 'errored';
  yield { type: 'done', reason, totalUsage: usage };
}

/**
 * Pre-iteration checks in their mandated order: abort → max_iterations →
 * token budget. Mutates the caller's iteration counter via the accessor
 * pair and mirrors the bump into {@link CoordinatorState.iterationObserved}
 * so `getMetrics()` sees it immediately. Returns `true` when the caller
 * should stop and `return` from `run()`.
 */
export function* checkPreIteration(
  deps: CoordinatorDeps,
  state: CoordinatorState,
  ctx: IterationContext,
  tm: AgentLoopTraceManager | undefined,
  getIteration: () => number,
  setIteration: (next: number) => void,
  usage: TokenUsage,
): Generator<AgentEvent, boolean> {
  // 1. Abort (external/internal).
  if (deps.abortController.signal.aborted) {
    yield* emitTerminal(state, ctx, tm, 'aborted',
      { type: 'error', error: new AbortedError() }, usage);
    return true;
  }

  if (deps.maxDurationMs !== undefined) {
    const durationSoFarMs = Date.now() - ctx.runStartTimeMs;
    if (ctx.iterationSpanId && tm) {
      tm.setSpanAttributes(ctx.iterationSpanId, { durationSoFarMs });
    }
    if (durationSoFarMs > deps.maxDurationMs) {
      yield* emitTerminal(state, ctx, tm, 'aborted',
        {
          type: 'error',
          error: new HarnessError(
            `Agent loop exceeded maxDurationMs (${durationSoFarMs}ms > ${deps.maxDurationMs}ms)`,
            HarnessErrorCode.CORE_DURATION_BUDGET_EXCEEDED,
            'Increase maxDurationMs or reduce loop/tool latency',
          ),
        },
        usage,
      );
      return true;
    }
  }

  // 2. Max iterations (post-increment).
  const next = getIteration() + 1;
  setIteration(next);
  state.iterationObserved = next;
  if (next > deps.maxIterations) {
    yield* emitTerminal(state, ctx, tm, 'max_iterations',
      { type: 'error', error: new MaxIterationsError(deps.maxIterations) }, usage);
    return true;
  }

  // 3. Cumulative token budget.
  const totalTokens = ctx.cumulativeUsage.inputTokens + ctx.cumulativeUsage.outputTokens;
  if (totalTokens > deps.maxTotalTokens) {
    yield* emitTerminal(state, ctx, tm, 'token_budget',
      { type: 'error', error: new TokenBudgetExceededError(totalTokens, deps.maxTotalTokens) },
      usage);
    return true;
  }

  return false;
}

/**
 * Per-iteration setup: prune conversation, close any stale iteration span,
 * open a fresh one with diagnostic attributes, mirror iteration into ctx,
 * reset the iterationEndFired latch, yield `iteration_start`, and fire
 * the `onIterationStart` hook. Mirrors the original `AgentLoop.startIteration`
 * semantics exactly so the event stream stays byte-for-byte compatible.
 */
export function* startIteration(
  deps: CoordinatorDeps,
  ctx: IterationContext,
  tm: AgentLoopTraceManager | undefined,
  traceId: string | undefined,
  iteration: number,
): Generator<AgentEvent> {
  if (
    deps.maxConversationMessages !== undefined &&
    ctx.conversation.length > deps.maxConversationMessages
  ) {
    const pruneResult = pruneConversation(ctx.conversation, deps.maxConversationMessages);
    if (pruneResult.warning) {
      yield { type: 'warning', message: pruneResult.warning };
    }
    const pruned = pruneResult.pruned;
    for (let i = 0; i < pruned.length; i++) {
      ctx.conversation[i] = pruned[i];
    }
    ctx.conversation.length = pruned.length;
  }

  if (ctx.iterationSpanId && tm) {
    tm.endSpan(ctx.iterationSpanId);
    ctx.iterationSpanId = undefined;
  }

  if (tm && traceId) {
    ctx.iterationSpanId = tm.startSpan(traceId, `iteration-${iteration}`);
    tm.setSpanAttributes(ctx.iterationSpanId, {
      iteration,
      adapter: deps.adapterName,
      conversationLength: ctx.conversation.length,
      streaming: deps.streaming,
      durationSoFarMs: Date.now() - ctx.runStartTimeMs,
    });
  }

  ctx.iteration = iteration;
  ctx.iterationEndFired.value = false;
  yield { type: 'iteration_start', iteration };
  deps.runHook('onIterationStart', { iteration });
}

/**
 * Detach the external-signal abort listener and null the handler slot.
 *
 * Single owner for listener cleanup: `startRun()` is the only installer;
 * {@link finalizeRun} and `AgentLoop.dispose()` both route through this
 * helper instead of hand-rolling the removal. Idempotent — calling twice
 * is a no-op because the handler slot is cleared on the first call.
 */
export function releaseExternalSignal(
  deps: CoordinatorDeps,
  state: CoordinatorState,
): void {
  const handler = state.externalAbortHandler;
  if (!handler || !deps.externalSignal) return;
  // Spec says `EventTarget#removeEventListener` never throws, but users do
  // sometimes pass custom `AbortSignal`-like mocks (tests, shims for legacy
  // runtimes). Those mocks can throw — and a throw here would propagate out
  // of `dispose()` / `finalizeRun()` and mask the real disposal path. The
  // reference is cleared below regardless.
  try {
    deps.externalSignal.removeEventListener('abort', handler);
  } catch {
    /* non-spec signal impl; drop the ref anyway */
  }
  state.externalAbortHandler = undefined;
}

/**
 * run() finally-block teardown. Releases the external signal listener,
 * closes any leaked iteration span, ends the trace, and aborts the internal
 * controller when the generator was closed externally via `.return()` /
 * `.throw()`. Idempotent and safe to call on disposed instances.
 */
export function finalizeRun(
  deps: CoordinatorDeps,
  state: CoordinatorState,
  ctx: IterationContext,
  tm: AgentLoopTraceManager | undefined,
  traceId: string | undefined,
  finalEventEmitted: boolean,
): void {
  releaseExternalSignal(deps, state);

  if (ctx.iterationSpanId && tm) {
    try { tm.endSpan(ctx.iterationSpanId, 'error'); } catch { /* already ended */ }
  }

  if (traceId && tm) {
    try {
      tm.endTrace(traceId, finalEventEmitted ? 'completed' : 'error');
    } catch {
      // Non-fatal — trace may already be ended.
    }
  }

  if (!finalEventEmitted) {
    deps.abortController.abort();
  }
}
