/**
 * Unit tests for the Wave-21 `iteration-lifecycle.ts` extraction.
 *
 * The module owns span+hook lifecycle and the five terminal generators
 * (`bailEndTurn`, `bailTokenBudget`, `bailAborted`, `bailError`,
 * `bailGuardrail`) that `IterationRunner` dispatches to. These tests
 * fence the event-sequencing invariant for every bail path + the
 * idempotency of `fireIterationEnd` + the defensive behaviour of
 * `endSpan` when the trace manager throws. Wave-23 backfill: before
 * this file the module was covered only indirectly via
 * `agent-loop.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createIterationLifecycle,
  type IterationContextLike,
  type IterationLifecycleConfig,
} from '../iteration-lifecycle.js';
import type { AgentEvent } from '../events.js';
import type { AgentLoopTraceManager } from '../trace-interface.js';
import type { AgentLoopHookDispatcher } from '../hook-dispatcher.js';
import { HarnessError, HarnessErrorCode } from '../errors.js';

function makeCtx(overrides: Partial<IterationContextLike> = {}): IterationContextLike {
  return {
    conversation: [],
    iteration: 1,
    cumulativeStreamBytes: { value: 0 },
    iterationSpanId: 'span-1',
    traceId: 'trace-1',
    cumulativeUsage: { inputTokens: 10, outputTokens: 20 },
    toolCallCounter: { value: 0 },
    iterationEndFired: { value: false },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<IterationLifecycleConfig> = {}): {
  config: IterationLifecycleConfig;
  runHookCalls: Array<{ event: string; info: unknown }>;
  tmCalls: Array<{ method: string; args: unknown[] }>;
  abortController: AbortController;
} {
  const runHookCalls: Array<{ event: string; info: unknown }> = [];
  const runHook: AgentLoopHookDispatcher = ((event, info) => {
    runHookCalls.push({ event: event as string, info });
  }) as AgentLoopHookDispatcher;

  const tmCalls: Array<{ method: string; args: unknown[] }> = [];
  const traceManager: AgentLoopTraceManager = {
    startTrace: vi.fn(() => 'trace-1'),
    startSpan: vi.fn(() => 'span-1'),
    setSpanAttributes: vi.fn(),
    addSpanEvent: vi.fn(),
    endSpan: (spanId: string, status?: 'completed' | 'error') => {
      tmCalls.push({ method: 'endSpan', args: [spanId, status] });
    },
    endTrace: (traceId: string, status?: 'completed' | 'error') => {
      tmCalls.push({ method: 'endTrace', args: [traceId, status] });
    },
  };
  const abortController = new AbortController();
  const config: IterationLifecycleConfig = {
    traceManager,
    runHook,
    abortController,
    ...overrides,
  };
  return { config, runHookCalls, tmCalls, abortController };
}

async function drain(
  gen: AsyncGenerator<AgentEvent, { kind: 'terminated'; reason: unknown; totalUsage: unknown }>,
): Promise<{ events: AgentEvent[]; outcome: { kind: 'terminated'; reason: unknown; totalUsage: unknown } }> {
  const events: AgentEvent[] = [];
  while (true) {
    const step = await gen.next();
    if (step.done) {
      return { events, outcome: step.value };
    }
    events.push(step.value);
  }
}

describe('endSpan', () => {
  it('calls trace manager endSpan with the given status and clears the slot', () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    lifecycle.endSpan(ctx, 'completed');
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'completed'] }]);
    expect(ctx.iterationSpanId).toBeUndefined();
  });

  it('is a no-op when iterationSpanId is already cleared', () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx({ iterationSpanId: undefined });
    lifecycle.endSpan(ctx, 'completed');
    expect(tmCalls).toEqual([]);
  });

  it('is a no-op when no trace manager is configured', () => {
    const { config } = makeDeps({ traceManager: undefined });
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    expect(() => lifecycle.endSpan(ctx, 'completed')).not.toThrow();
    expect(ctx.iterationSpanId).toBe('span-1');
  });

  it('swallows exceptions from trace manager endSpan and still clears the slot', () => {
    const { config } = makeDeps();
    config.traceManager!.endSpan = () => {
      throw new Error('tm-boom');
    };
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    expect(() => lifecycle.endSpan(ctx, 'error')).not.toThrow();
    expect(ctx.iterationSpanId).toBeUndefined();
  });
});

describe('fireIterationEnd', () => {
  it('fires onIterationEnd with iteration + done payload once', () => {
    const { config, runHookCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx({ iteration: 3 });
    lifecycle.fireIterationEnd(ctx, true);
    expect(runHookCalls).toEqual([{ event: 'onIterationEnd', info: { iteration: 3, done: true } }]);
    expect(ctx.iterationEndFired.value).toBe(true);
  });

  it('is idempotent — second call is a no-op', () => {
    const { config, runHookCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    lifecycle.fireIterationEnd(ctx, false);
    lifecycle.fireIterationEnd(ctx, true);
    expect(runHookCalls).toHaveLength(1);
    // Second call is a no-op even with a different `done`.
    expect(runHookCalls[0].info).toEqual({ iteration: 1, done: false });
  });
});

describe('bailEndTurn', () => {
  it('yields the message event then closes span with completed status', async () => {
    const { config, runHookCalls, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const messageEvent: AgentEvent = {
      type: 'message',
      message: { role: 'assistant', content: 'done' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
    const { events, outcome } = await drain(lifecycle.bailEndTurn(ctx, messageEvent));
    expect(events).toEqual([messageEvent]);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'completed'] }]);
    expect(runHookCalls).toEqual([{ event: 'onIterationEnd', info: { iteration: 1, done: true } }]);
    expect(outcome).toEqual({
      kind: 'terminated',
      reason: 'end_turn',
      totalUsage: { inputTokens: 10, outputTokens: 20 },
    });
  });
});

describe('bailTokenBudget', () => {
  it('yields message then error, closes span error, terminates token_budget', async () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const messageEvent: AgentEvent = {
      type: 'message',
      message: { role: 'assistant', content: 'partial' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const errorEvent: AgentEvent = {
      type: 'error',
      error: new HarnessError('budget', HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED),
    };
    const { events, outcome } = await drain(lifecycle.bailTokenBudget(ctx, messageEvent, errorEvent));
    expect(events.map((e) => e.type)).toEqual(['message', 'error']);
    expect(events[1]).toBe(errorEvent);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'error'] }]);
    expect(outcome.reason).toBe('token_budget');
  });
});

describe('bailAborted', () => {
  it('yields error event, closes span error, terminates aborted', async () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const errorEvent: AgentEvent = {
      type: 'error',
      error: new HarnessError('aborted', HarnessErrorCode.CORE_ABORTED),
    };
    const { events, outcome } = await drain(lifecycle.bailAborted(ctx, errorEvent));
    expect(events).toEqual([errorEvent]);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'error'] }]);
    expect(outcome.reason).toBe('aborted');
  });
});

describe('bailError', () => {
  it('yields error event when NOT already yielded', async () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const errorEvent: AgentEvent = {
      type: 'error',
      error: new HarnessError('adapter', HarnessErrorCode.ADAPTER_NETWORK),
    };
    const { events, outcome } = await drain(lifecycle.bailError(ctx, errorEvent, false));
    expect(events).toEqual([errorEvent]);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'error'] }]);
    expect(outcome.reason).toBe('error');
  });

  it('skips error event when already yielded upstream (streaming path)', async () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const errorEvent: AgentEvent = {
      type: 'error',
      error: new HarnessError('adapter', HarnessErrorCode.ADAPTER_NETWORK),
    };
    const { events, outcome } = await drain(lifecycle.bailError(ctx, errorEvent, true));
    expect(events).toEqual([]);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'error'] }]);
    expect(outcome.reason).toBe('error');
  });

  it('still terminates cleanly when errorEvent is undefined', async () => {
    const { config, tmCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const { events, outcome } = await drain(lifecycle.bailError(ctx, undefined, false));
    expect(events).toEqual([]);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'error'] }]);
    expect(outcome.reason).toBe('error');
  });
});

describe('bailGuardrail', () => {
  it('aborts upstream, yields guardrail then error, closes span error, terminates error', async () => {
    const { config, tmCalls, abortController } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const guardrailEvent: AgentEvent = {
      type: 'guardrail_blocked',
      phase: 'input',
      guardName: 'pii-detector',
    };
    const errorEvent: AgentEvent = {
      type: 'error',
      error: new HarnessError('blocked', HarnessErrorCode.GUARD_BLOCKED),
    };
    expect(abortController.signal.aborted).toBe(false);
    const { events, outcome } = await drain(
      lifecycle.bailGuardrail(ctx, guardrailEvent, errorEvent),
    );
    expect(abortController.signal.aborted).toBe(true);
    expect(events).toEqual([guardrailEvent, errorEvent]);
    expect(tmCalls).toEqual([{ method: 'endSpan', args: ['span-1', 'error'] }]);
    expect(outcome.reason).toBe('error');
  });

  it('is safe even when abortController is already aborted', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const { config } = makeDeps({ abortController: preAborted });
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const guardrailEvent: AgentEvent = {
      type: 'guardrail_blocked',
      phase: 'output',
      guardName: 'schema-validator',
    };
    const errorEvent: AgentEvent = {
      type: 'error',
      error: new HarnessError('blocked', HarnessErrorCode.GUARD_BLOCKED),
    };
    const { events } = await drain(lifecycle.bailGuardrail(ctx, guardrailEvent, errorEvent));
    expect(events).toEqual([guardrailEvent, errorEvent]);
    expect(preAborted.signal.aborted).toBe(true);
  });
});

describe('cross-path invariants', () => {
  it('every bail path fires onIterationEnd exactly once', async () => {
    const { config, runHookCalls } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();

    const msg: AgentEvent = {
      type: 'message',
      message: { role: 'assistant', content: 'x' },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const err: AgentEvent = { type: 'error', error: new Error('x') };
    const grd: AgentEvent = { type: 'guardrail_blocked', phase: 'input', guardName: 'x' };

    await drain(lifecycle.bailEndTurn(ctx, msg));
    // Second call on the same ctx is a no-op.
    await drain(lifecycle.bailError(ctx, err, false));
    await drain(lifecycle.bailAborted(ctx, err));
    await drain(lifecycle.bailTokenBudget(ctx, msg, err));
    await drain(lifecycle.bailGuardrail(ctx, grd, err));

    const endEvents = runHookCalls.filter((c) => c.event === 'onIterationEnd');
    expect(endEvents).toHaveLength(1);
  });

  it('every bail path clears the iterationSpanId slot', async () => {
    const makeFreshCtx = (): IterationContextLike => makeCtx();
    const { config } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const msg: AgentEvent = {
      type: 'message',
      message: { role: 'assistant', content: 'x' },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const err: AgentEvent = { type: 'error', error: new Error('x') };
    const grd: AgentEvent = { type: 'guardrail_blocked', phase: 'input', guardName: 'x' };

    for (const run of [
      (ctx: IterationContextLike) => drain(lifecycle.bailEndTurn(ctx, msg)),
      (ctx: IterationContextLike) => drain(lifecycle.bailError(ctx, err, false)),
      (ctx: IterationContextLike) => drain(lifecycle.bailAborted(ctx, err)),
      (ctx: IterationContextLike) => drain(lifecycle.bailTokenBudget(ctx, msg, err)),
      (ctx: IterationContextLike) => drain(lifecycle.bailGuardrail(ctx, grd, err)),
    ]) {
      const ctx = makeFreshCtx();
      expect(ctx.iterationSpanId).toBe('span-1');
      await run(ctx);
      expect(ctx.iterationSpanId).toBeUndefined();
    }
  });

  it('totalUsage is a snapshot — mutations to ctx after terminate do not leak back', async () => {
    const { config } = makeDeps();
    const lifecycle = createIterationLifecycle(config);
    const ctx = makeCtx();
    const msg: AgentEvent = {
      type: 'message',
      message: { role: 'assistant', content: 'x' },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const { outcome } = await drain(lifecycle.bailEndTurn(ctx, msg));
    expect(outcome.totalUsage).toEqual({ inputTokens: 10, outputTokens: 20 });
    ctx.cumulativeUsage.inputTokens = 999;
    // Already-returned snapshot must not observe the mutation.
    expect((outcome as { totalUsage: { inputTokens: number } }).totalUsage.inputTokens).toBe(10);
  });
});
