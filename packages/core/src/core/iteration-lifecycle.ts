/**
 * IterationLifecycle — span + hook lifecycle for one agent iteration.
 *
 * Owns the side-effects each terminal exit path of `IterationRunner` needs:
 *
 *   - closing the active iteration span with the right status,
 *   - firing the once-per-iteration `onIterationEnd` hook,
 *   - emitting the standard sequence of terminal events (`message` / `error`
 *     / `guardrail_blocked`),
 *   - aborting upstream work on hard guardrail blocks.
 *
 * `IterationRunner.runIteration` delegates every terminal exit to one of the
 * `bail*` generators here so the runner body only owns stage choreography.
 *
 * @module
 */

import type { AgentEvent, DoneReason } from './events.js';
import type { TokenUsage } from './types.js';
import type { AgentLoopHookDispatcher } from './hook-dispatcher.js';
import type { AgentLoopTraceManager } from './trace-interface.js';
import { annotateHarnessErrorSpan } from './error-span-attributes.js';

/** See {@link IterationRunner} — re-declared here to avoid a cycle. */
export interface IterationContextLike {
  readonly conversation: unknown;
  iteration: number;
  readonly cumulativeStreamBytes: { value: number };
  iterationSpanId: string | undefined;
  readonly traceId: string | undefined;
  readonly cumulativeUsage: { inputTokens: number; outputTokens: number };
  readonly toolCallCounter: { value: number };
  readonly iterationEndFired: { value: boolean };
}

/** Outcome shape returned by every `bail*` generator. */
export interface IterationTerminated {
  readonly kind: 'terminated';
  readonly reason: DoneReason;
  readonly totalUsage: TokenUsage;
}

export interface IterationLifecycleConfig {
  readonly traceManager?: AgentLoopTraceManager;
  readonly runHook: AgentLoopHookDispatcher;
  readonly abortController: AbortController;
}

export interface IterationLifecycle {
  /** Close the active iteration span and clear the slot on the context. */
  endSpan(ctx: IterationContextLike, status?: 'completed' | 'error'): void;
  /** Fire `onIterationEnd` hooks once per iteration. Idempotent. */
  fireIterationEnd(ctx: IterationContextLike, done: boolean): void;
  bailEndTurn(
    ctx: IterationContextLike,
    messageEvent: Extract<AgentEvent, { type: 'message' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated>;
  bailTokenBudget(
    ctx: IterationContextLike,
    messageEvent: Extract<AgentEvent, { type: 'message' }>,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated>;
  bailAborted(
    ctx: IterationContextLike,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated>;
  /**
   * General error terminal. `errorAlreadyYielded` skips the `error` event when
   * StreamHandler has already yielded it (streaming path) to preserve the
   * "exactly one error event per failed turn" contract.
   */
  bailError(
    ctx: IterationContextLike,
    errorEvent: Extract<AgentEvent, { type: 'error' }> | undefined,
    errorAlreadyYielded: boolean,
  ): AsyncGenerator<AgentEvent, IterationTerminated>;
  /**
   * Guardrail block terminal — always aborts upstream work and yields the
   * guardrail event before the error event so downstream filters see both.
   */
  bailGuardrail(
    ctx: IterationContextLike,
    guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated>;
}

function snapshotUsage(u: { inputTokens: number; outputTokens: number }): TokenUsage {
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

export function createIterationLifecycle(
  config: Readonly<IterationLifecycleConfig>,
): IterationLifecycle {
  const tm = config.traceManager;
  const runHook = config.runHook;

  function endSpan(ctx: IterationContextLike, status?: 'completed' | 'error'): void {
    if (ctx.iterationSpanId && tm) {
      try {
        tm.endSpan(ctx.iterationSpanId, status);
      } catch {
        // span may already be ended — non-fatal; outer finally is also defensive.
      }
      ctx.iterationSpanId = undefined;
    }
  }

  function fireIterationEnd(ctx: IterationContextLike, done: boolean): void {
    if (ctx.iterationEndFired.value) return;
    ctx.iterationEndFired.value = true;
    runHook('onIterationEnd', { iteration: ctx.iteration, done });
  }

  function terminated(ctx: IterationContextLike, reason: DoneReason): IterationTerminated {
    return {
      kind: 'terminated',
      reason,
      totalUsage: snapshotUsage(ctx.cumulativeUsage),
    };
  }

  async function* bailEndTurn(
    ctx: IterationContextLike,
    messageEvent: Extract<AgentEvent, { type: 'message' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated> {
    yield messageEvent;
    endSpan(ctx, 'completed');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'end_turn');
  }

  async function* bailTokenBudget(
    ctx: IterationContextLike,
    messageEvent: Extract<AgentEvent, { type: 'message' }>,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated> {
    yield messageEvent;
    yield errorEvent;
    annotateHarnessErrorSpan(tm, ctx.iterationSpanId, errorEvent.error);
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'token_budget');
  }

  async function* bailAborted(
    ctx: IterationContextLike,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated> {
    yield errorEvent;
    annotateHarnessErrorSpan(tm, ctx.iterationSpanId, errorEvent.error);
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'aborted');
  }

  async function* bailError(
    ctx: IterationContextLike,
    errorEvent: Extract<AgentEvent, { type: 'error' }> | undefined,
    errorAlreadyYielded: boolean,
  ): AsyncGenerator<AgentEvent, IterationTerminated> {
    if (!errorAlreadyYielded && errorEvent) yield errorEvent;
    annotateHarnessErrorSpan(tm, ctx.iterationSpanId, errorEvent?.error);
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'error');
  }

  async function* bailGuardrail(
    ctx: IterationContextLike,
    guardrailEvent: Extract<AgentEvent, { type: 'guardrail_blocked' }>,
    errorEvent: Extract<AgentEvent, { type: 'error' }>,
  ): AsyncGenerator<AgentEvent, IterationTerminated> {
    config.abortController.abort();
    yield guardrailEvent;
    yield errorEvent;
    annotateHarnessErrorSpan(tm, ctx.iterationSpanId, errorEvent.error);
    endSpan(ctx, 'error');
    fireIterationEnd(ctx, true);
    return terminated(ctx, 'error');
  }

  return {
    endSpan,
    fireIterationEnd,
    bailEndTurn,
    bailTokenBudget,
    bailAborted,
    bailError,
    bailGuardrail,
  };
}
