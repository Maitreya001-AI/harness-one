/**
 * iteration-coordinator.ts — Wave-15 extracted the event-sequencing state
 * machine from AgentLoop; this suite pins down the observable contract
 * (yield ordering, pre-iteration exit codes, external-signal teardown)
 * directly against the coordinator, without having to wire a full loop.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  startRun,
  checkPreIteration,
  startIteration,
  finalizeRun,
  type CoordinatorDeps,
  type CoordinatorState,
} from '../iteration-coordinator.js';
import type { IterationContext } from '../iteration-runner.js';
import type { AgentEvent } from '../events.js';
import { AbortedError, MaxIterationsError, TokenBudgetExceededError } from '../errors.js';

function freshState(): CoordinatorState {
  return {
    noPipelineWarned: false,
    status: 'idle',
    iterationObserved: 0,
    cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
    externalAbortHandler: undefined,
  };
}

function freshDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    abortController: new AbortController(),
    maxIterations: 5,
    maxTotalTokens: 10_000,
    adapterName: 'test-adapter',
    streaming: false,
    hasInputPipeline: false,
    hasOutputPipeline: false,
    runHook: () => { /* noop */ },
    ...overrides,
  };
}

async function drain(gen: Generator<AgentEvent, unknown>): Promise<{ events: AgentEvent[]; done: unknown }> {
  const events: AgentEvent[] = [];
  let result: IteratorResult<AgentEvent, unknown>;
  while (!(result = gen.next()).done) {
    events.push(result.value);
  }
  return { events, done: result.value };
}

describe('iteration-coordinator', () => {
  describe('startRun', () => {
    it('flips status to running and allocates a fresh iteration context', () => {
      const state = freshState();
      const deps = freshDeps();
      const { ctx, traceId } = startRun(deps, state, []);
      expect(state.status).toBe('running');
      expect(traceId).toBeUndefined();
      expect(ctx.iteration).toBe(0);
      expect(ctx.cumulativeUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('aborts immediately when the external signal is already aborted', () => {
      const state = freshState();
      const controller = new AbortController();
      const external = new AbortController();
      external.abort();
      const deps = freshDeps({
        abortController: controller,
        externalSignal: external.signal,
      });
      startRun(deps, state, []);
      expect(controller.signal.aborted).toBe(true);
    });

    it('emits the no-pipeline warning exactly once', () => {
      const state = freshState();
      const warn = vi.fn();
      const deps = freshDeps({ logger: { warn } });
      startRun(deps, state, []);
      // Reset status so startRun can run again (simulates a second run() on
      // the same instance).
      state.status = 'idle';
      startRun(deps, state, []);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('skips the warning when a pipeline is configured', () => {
      const state = freshState();
      const warn = vi.fn();
      const deps = freshDeps({ logger: { warn }, hasInputPipeline: true });
      startRun(deps, state, []);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('checkPreIteration', () => {
    it('emits abort + done and signals stop when the controller is already aborted', async () => {
      const state = freshState();
      const deps = freshDeps();
      deps.abortController.abort();
      const { ctx } = startRun(deps, state, []);
      let iteration = 0;
      const gen = checkPreIteration(
        deps, state, ctx, undefined,
        () => iteration, (n) => { iteration = n; },
        { inputTokens: 0, outputTokens: 0 },
      );
      const { events, done } = await drain(gen);
      expect(done).toBe(true);
      expect(events[0]).toMatchObject({ type: 'error' });
      expect((events[0] as { error: unknown }).error).toBeInstanceOf(AbortedError);
      expect(events[1]).toMatchObject({ type: 'done', reason: 'aborted' });
    });

    it('trips max_iterations after the configured cap', async () => {
      const state = freshState();
      const deps = freshDeps({ maxIterations: 1 });
      const { ctx } = startRun(deps, state, []);
      // First call: iteration becomes 1 (ok). Second call: iteration=2 > 1.
      let iteration = 0;
      const firstGen = checkPreIteration(
        deps, state, ctx, undefined,
        () => iteration, (n) => { iteration = n; },
        { inputTokens: 0, outputTokens: 0 },
      );
      const first = await drain(firstGen);
      expect(first.done).toBe(false);

      const secondGen = checkPreIteration(
        deps, state, ctx, undefined,
        () => iteration, (n) => { iteration = n; },
        { inputTokens: 0, outputTokens: 0 },
      );
      const second = await drain(secondGen);
      expect(second.done).toBe(true);
      expect((second.events[0] as { error: unknown }).error).toBeInstanceOf(MaxIterationsError);
    });

    it('trips the token budget when cumulative usage exceeds the cap', async () => {
      const state = freshState();
      const deps = freshDeps({ maxTotalTokens: 5 });
      const { ctx } = startRun(deps, state, []);
      ctx.cumulativeUsage = { inputTokens: 10, outputTokens: 0 };
      let iteration = 0;
      const gen = checkPreIteration(
        deps, state, ctx, undefined,
        () => iteration, (n) => { iteration = n; },
        { inputTokens: 10, outputTokens: 0 },
      );
      const { events, done } = await drain(gen);
      expect(done).toBe(true);
      expect((events[0] as { error: unknown }).error).toBeInstanceOf(TokenBudgetExceededError);
    });
  });

  describe('startIteration', () => {
    it('yields iteration_start and fires the hook', async () => {
      const state = freshState();
      const runHook = vi.fn();
      const deps = freshDeps({ runHook });
      const { ctx, traceId } = startRun(deps, state, []);
      const gen = startIteration(deps, ctx, undefined, traceId, 1);
      const { events } = await drain(gen);
      expect(events).toEqual([{ type: 'iteration_start', iteration: 1 }]);
      expect(runHook).toHaveBeenCalledWith('onIterationStart', { iteration: 1 });
    });

    it('prunes over-long conversations and emits a warning', async () => {
      const state = freshState();
      const deps = freshDeps({ maxConversationMessages: 2 });
      const messages: IterationContext['conversation'] = [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'user', content: 'd' },
      ];
      const originalLength = messages.length;
      const { ctx, traceId } = startRun(deps, state, messages);
      const gen = startIteration(deps, ctx, undefined, traceId, 1);
      const { events } = await drain(gen);
      expect(events.some((e) => e.type === 'warning')).toBe(true);
      // Pruning must have shortened the conversation below the original length.
      expect(ctx.conversation.length).toBeLessThan(originalLength);
    });
  });

  describe('finalizeRun', () => {
    it('removes the external abort handler to prevent leaks', () => {
      const state = freshState();
      const external = new AbortController();
      const deps = freshDeps({ externalSignal: external.signal });
      const { ctx, traceId } = startRun(deps, state, []);
      expect(state.externalAbortHandler).toBeDefined();
      finalizeRun(deps, state, ctx, undefined, traceId, true);
      expect(state.externalAbortHandler).toBeUndefined();
    });

    it('aborts the internal controller when run() was closed externally', () => {
      const state = freshState();
      const deps = freshDeps();
      const { ctx, traceId } = startRun(deps, state, []);
      finalizeRun(deps, state, ctx, undefined, traceId, false);
      expect(deps.abortController.signal.aborted).toBe(true);
    });
  });
});
