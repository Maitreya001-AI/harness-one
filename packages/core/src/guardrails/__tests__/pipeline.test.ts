import { describe, it, expect, vi } from 'vitest';
import { createPipeline, runInput, runOutput } from '../pipeline.js';
import type { Guardrail, GuardrailEvent } from '../types.js';

const allowGuard: Guardrail = () => ({ action: 'allow' });
const blockGuard: Guardrail = () => ({ action: 'block', reason: 'blocked' });
const modifyGuard: Guardrail = () => ({ action: 'modify', modified: 'changed', reason: 'modified' });
const throwGuard: Guardrail = () => { throw new Error('boom'); };

describe('createPipeline + runInput', () => {
  it('returns allow when all guardrails pass', async () => {
    const pipeline = createPipeline({
      input: [
        { name: 'g1', guard: allowGuard },
        { name: 'g2', guard: allowGuard },
      ],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.results).toHaveLength(2);
  });

  it('returns allow when no guardrails configured', async () => {
    const pipeline = createPipeline({});
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.verdict).toEqual({ action: 'allow' });
    expect(result.results).toHaveLength(0);
  });

  it('short-circuits on first block verdict', async () => {
    const secondGuard = vi.fn(allowGuard);
    const pipeline = createPipeline({
      input: [
        { name: 'blocker', guard: blockGuard },
        { name: 'second', guard: secondGuard },
      ],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    expect(result.verdict).toEqual({ action: 'block', reason: 'blocked' });
    expect(result.results).toHaveLength(1);
    expect(secondGuard).not.toHaveBeenCalled();
  });

  it('short-circuits on first modify verdict', async () => {
    const secondGuard = vi.fn(allowGuard);
    const pipeline = createPipeline({
      input: [
        { name: 'modifier', guard: modifyGuard },
        { name: 'second', guard: secondGuard },
      ],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.verdict).toEqual({ action: 'modify', modified: 'changed', reason: 'modified' });
    expect(result.results).toHaveLength(1);
    expect(secondGuard).not.toHaveBeenCalled();
  });

  it('blocks on throw when failClosed is true (default)', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'thrower', guard: throwGuard }],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    expect(result.verdict.action).toBe('block');
    if (result.verdict.action === 'block') {
      expect(result.verdict.reason).toContain('Guardrail error: boom');
    }
  });

  it('skips throwing guardrail when failClosed is false', async () => {
    const pipeline = createPipeline({
      input: [
        { name: 'thrower', guard: throwGuard },
        { name: 'allow', guard: allowGuard },
      ],
      failClosed: false,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.verdict).toEqual({ action: 'allow' });
    // Both guardrails produce events: the thrower (with allow verdict) and the allow guard
    expect(result.results).toHaveLength(2);
    expect(result.results[0].guardrail).toBe('thrower');
    expect(result.results[1].guardrail).toBe('allow');
  });

  it('calls onEvent for each guardrail with timing info', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [
        { name: 'g1', guard: allowGuard },
        { name: 'g2', guard: allowGuard },
      ],
      onEvent: (e) => events.push(e),
    });
    await runInput(pipeline, { content: 'hello' });
    expect(events).toHaveLength(2);
    expect(events[0].guardrail).toBe('g1');
    expect(events[0].direction).toBe('input');
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(events[1].guardrail).toBe('g2');
  });

  it('handles async guardrails', async () => {
    const asyncGuard: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'async', guard: asyncGuard }],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    expect(result.results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runOutput', () => {
  it('runs output guardrails with direction=output', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      output: [{ name: 'out', guard: allowGuard }],
      onEvent: (e) => events.push(e),
    });
    const result = await runOutput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    expect(events[0].direction).toBe('output');
  });
});

describe('H2: per-guardrail timeout', () => {
  it('blocks when a guardrail exceeds its timeout', async () => {
    const slowGuard: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'slow', guard: slowGuard, timeoutMs: 50 }],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    if (result.verdict.action === 'block') {
      expect(result.verdict.reason).toContain('timed out');
    }
  });

  it('allows fast guardrails with timeout configured', async () => {
    const fastGuard: Guardrail = () => ({ action: 'allow' });
    const pipeline = createPipeline({
      input: [{ name: 'fast', guard: fastGuard, timeoutMs: 5000 }],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });

  it('works without per-guardrail timeout (backward compatible)', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'g1', guard: allowGuard }],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });
});

describe('FIX-5: fail-open still emits events for crashed guardrails', () => {
  it('emits an event via onEvent when failClosed=false and guardrail throws', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [
        { name: 'thrower', guard: throwGuard },
        { name: 'allow', guard: allowGuard },
      ],
      failClosed: false,
      onEvent: (e) => events.push(e),
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
    // The thrower guardrail should have emitted an event even though it was skipped
    const throwerEvent = events.find((e) => e.guardrail === 'thrower');
    expect(throwerEvent).toBeDefined();
    expect(throwerEvent!.verdict.action).toBe('allow'); // or some error indicator
  });
});

describe('FIX-6: budget.ts throws HarnessError', () => {
  it('is covered in budget.test.ts', () => {
    // Placeholder - actual test is in budget.test.ts
    expect(true).toBe(true);
  });
});

describe('pipeline edge cases', () => {
  it('modify verdict: pipeline returns modified content and short-circuits', async () => {
    const modifierGuard: Guardrail = (ctx) => {
      if (ctx.content.includes('bad')) {
        return { action: 'modify', modified: ctx.content.replace('bad', 'good'), reason: 'cleaned up' };
      }
      return { action: 'allow' };
    };
    const secondGuard = vi.fn(allowGuard);
    const pipeline = createPipeline({
      input: [
        { name: 'modifier', guard: modifierGuard },
        { name: 'second', guard: secondGuard },
      ],
    });
    const result = await runInput(pipeline, { content: 'this is bad content' });
    expect(result.passed).toBe(true);
    expect(result.verdict.action).toBe('modify');
    if (result.verdict.action === 'modify') {
      expect(result.verdict.modified).toBe('this is good content');
    }
    // Second guardrail should NOT have been called (short-circuit on modify)
    expect(secondGuard).not.toHaveBeenCalled();
  });

  it('first allows, second blocks: verifies short-circuit on second guardrail', async () => {
    const thirdGuard = vi.fn(allowGuard);
    const pipeline = createPipeline({
      input: [
        { name: 'allower', guard: allowGuard },
        { name: 'blocker', guard: blockGuard },
        { name: 'third', guard: thirdGuard },
      ],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    expect(result.verdict).toEqual({ action: 'block', reason: 'blocked' });
    // Two events: allower (allow) and blocker (block)
    expect(result.results).toHaveLength(2);
    expect(result.results[0].guardrail).toBe('allower');
    expect(result.results[0].verdict.action).toBe('allow');
    expect(result.results[1].guardrail).toBe('blocker');
    expect(result.results[1].verdict.action).toBe('block');
    // Third guardrail was never reached
    expect(thirdGuard).not.toHaveBeenCalled();
  });

  it('event callback receives correct timing (latencyMs > 0) for slow guardrail', async () => {
    const events: GuardrailEvent[] = [];
    const slowGuard: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'slow', guard: slowGuard }],
      onEvent: (e) => events.push(e),
    });
    await runInput(pipeline, { content: 'hello' });
    expect(events).toHaveLength(1);
    expect(events[0].latencyMs).toBeGreaterThan(0);
    // Should be at least ~20ms since the guardrail sleeps 20ms
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(15);
  });

  it('per-guardrail timeout: guardrail exceeds timeoutMs, handled by failClosed logic', async () => {
    const hangingGuard: Guardrail = () => new Promise(() => {}); // never resolves
    const events: GuardrailEvent[] = [];

    // failClosed = true (default): should block
    const pipelineClosed = createPipeline({
      input: [{ name: 'hanger', guard: hangingGuard, timeoutMs: 50 }],
      failClosed: true,
      onEvent: (e) => events.push(e),
    });
    const resultClosed = await runInput(pipelineClosed, { content: 'hello' });
    expect(resultClosed.passed).toBe(false);
    expect(resultClosed.verdict.action).toBe('block');
    if (resultClosed.verdict.action === 'block') {
      expect(resultClosed.verdict.reason).toContain('timed out');
    }
    expect(events.length).toBeGreaterThanOrEqual(1);

    // failClosed = false: should skip and allow
    const eventsOpen: GuardrailEvent[] = [];
    const pipelineOpen = createPipeline({
      input: [
        { name: 'hanger', guard: hangingGuard, timeoutMs: 50 },
        { name: 'allower', guard: allowGuard },
      ],
      failClosed: false,
      onEvent: (e) => eventsOpen.push(e),
    });
    const resultOpen = await runInput(pipelineOpen, { content: 'hello' });
    expect(resultOpen.passed).toBe(true);
    expect(eventsOpen).toHaveLength(2);
  });

  it('PermissionLevel is passed through context to guardrails', async () => {
    const receivedLevels: (string | undefined)[] = [];
    const capturingGuard: Guardrail = (ctx) => {
      receivedLevels.push(ctx.permissionLevel);
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [
        { name: 'g1', guard: capturingGuard },
        { name: 'g2', guard: capturingGuard },
      ],
    });
    await runInput(pipeline, { content: 'test', permissionLevel: 'permissive' });
    expect(receivedLevels).toEqual(['permissive', 'permissive']);
  });
});

describe('Gap 2: permissionLevel in GuardrailContext', () => {
  it('passes permissionLevel through to guardrail functions', async () => {
    let receivedCtx: import('../types.js').GuardrailContext | undefined;
    const capturingGuard: Guardrail = (ctx) => {
      receivedCtx = ctx;
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'capture', guard: capturingGuard }],
    });
    await runInput(pipeline, { content: 'hello', permissionLevel: 'strict' });
    expect(receivedCtx).toBeDefined();
    expect(receivedCtx!.permissionLevel).toBe('strict');
  });

  it('defaults permissionLevel to undefined when not provided', async () => {
    let receivedCtx: import('../types.js').GuardrailContext | undefined;
    const capturingGuard: Guardrail = (ctx) => {
      receivedCtx = ctx;
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'capture', guard: capturingGuard }],
    });
    await runInput(pipeline, { content: 'hello' });
    expect(receivedCtx).toBeDefined();
    expect(receivedCtx!.permissionLevel).toBeUndefined();
  });

  it('supports all three permission levels', async () => {
    const levels: import('../types.js').PermissionLevel[] = ['strict', 'default', 'permissive'];
    for (const level of levels) {
      let receivedLevel: string | undefined;
      const guard: Guardrail = (ctx) => {
        receivedLevel = ctx.permissionLevel;
        return { action: 'allow' };
      };
      const pipeline = createPipeline({
        input: [{ name: 'check', guard }],
      });
      await runInput(pipeline, { content: 'test', permissionLevel: level });
      expect(receivedLevel).toBe(level);
    }
  });
});
