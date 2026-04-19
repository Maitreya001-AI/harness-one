import { describe, it, expect, vi } from 'vitest';
import { createPipeline, runInput, runOutput, runToolOutput } from '../pipeline.js';
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

  it('propagates modified content to subsequent guardrails instead of short-circuiting', async () => {
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
    expect(result.results).toHaveLength(2);
    expect(secondGuard).toHaveBeenCalled();
    expect(result.modifiedContent).toBe('changed');
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

describe('fail-open still emits events for crashed guardrails', () => {
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

describe('pipeline edge cases', () => {
  it('modify verdict: pipeline returns modified content and propagates to next guardrail', async () => {
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
    // Second guardrail SHOULD be called with modified content
    expect(secondGuard).toHaveBeenCalled();
    expect(result.modifiedContent).toBe('this is good content');
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
    // a `guard_timeout` span event is now emitted alongside the
    // existing fail-open verdict event for the timed-out guard, so the total
    // event count is 3 (span + fail-open + allow) instead of 2.
    const verdictEvents = eventsOpen.filter(
      (e) =>
        typeof e.verdict.reason !== 'string' ||
        !e.verdict.reason.startsWith('guard_timeout:'),
    );
    expect(verdictEvents).toHaveLength(2);
    const spanEvents = eventsOpen.filter(
      (e) =>
        typeof e.verdict.reason === 'string' &&
        e.verdict.reason.startsWith('guard_timeout:'),
    );
    expect(spanEvents).toHaveLength(1);
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

describe('modify verdict propagation', () => {
  it('passes modified content to subsequent guardrails instead of short-circuiting', async () => {
    const receivedContents: string[] = [];
    const piiRedactor: Guardrail = (ctx) => {
      receivedContents.push(ctx.content);
      if (ctx.content.includes('SSN:123')) {
        return { action: 'modify', modified: ctx.content.replace('SSN:123', 'SSN:[REDACTED]'), reason: 'PII redacted' };
      }
      return { action: 'allow' };
    };
    const toxicityChecker: Guardrail = (ctx) => {
      receivedContents.push(ctx.content);
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [
        { name: 'pii', guard: piiRedactor },
        { name: 'toxicity', guard: toxicityChecker },
      ],
    });
    const result = await runInput(pipeline, { content: 'my SSN:123 is secret' });
    expect(result.passed).toBe(true);
    // The toxicity checker should have received the redacted content
    expect(receivedContents[1]).toBe('my SSN:[REDACTED] is secret');
    // Result should carry the modified content
    expect(result.modifiedContent).toBe('my SSN:[REDACTED] is secret');
  });

  it('chains multiple modify verdicts correctly', async () => {
    const guardA: Guardrail = (ctx) => {
      return { action: 'modify', modified: ctx.content.replace('foo', 'bar'), reason: 'replaced foo' };
    };
    const guardB: Guardrail = (ctx) => {
      return { action: 'modify', modified: ctx.content.replace('bar', 'baz'), reason: 'replaced bar' };
    };
    const pipeline = createPipeline({
      input: [
        { name: 'a', guard: guardA },
        { name: 'b', guard: guardB },
      ],
    });
    const result = await runInput(pipeline, { content: 'hello foo world' });
    expect(result.passed).toBe(true);
    expect(result.modifiedContent).toBe('hello baz world');
    // Final verdict should reflect modify
    expect(result.verdict.action).toBe('modify');
  });

  it('block after modify still blocks', async () => {
    const modifier: Guardrail = (ctx) => {
      return { action: 'modify', modified: ctx.content + ' [modified]', reason: 'appended' };
    };
    const blocker: Guardrail = (ctx) => {
      // Should receive modified content
      expect(ctx.content).toBe('hello [modified]');
      return { action: 'block', reason: 'blocked after modify' };
    };
    const pipeline = createPipeline({
      input: [
        { name: 'modifier', guard: modifier },
        { name: 'blocker', guard: blocker },
      ],
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    expect(result.verdict.action).toBe('block');
  });
});

describe('getInternal validation: symbol-based brand pattern', () => {
  it('throws HarnessError when runInput is called with a non-createPipeline object', async () => {
    const fakePipeline = { input: [], output: [], failClosed: true } as unknown as import('../pipeline.js').GuardrailPipeline;
    await expect(runInput(fakePipeline, { content: 'hello' })).rejects.toThrow('Invalid GuardrailPipeline');
  });

  it('throws HarnessError when runOutput is called with a non-createPipeline object', async () => {
    const fakePipeline = {} as unknown as import('../pipeline.js').GuardrailPipeline;
    await expect(runOutput(fakePipeline, { content: 'hello' })).rejects.toThrow('Invalid GuardrailPipeline');
  });

  it('rejects objects with a string key matching the brand name (symbol-based brand is unforgeable)', async () => {
    const forgedPipeline = {
      GuardrailPipeline: { input: [], output: [], failClosed: true },
    } as unknown as import('../pipeline.js').GuardrailPipeline;
    await expect(runInput(forgedPipeline, { content: 'hello' })).rejects.toThrow('Invalid GuardrailPipeline');
  });

  it('accepts a pipeline created by createPipeline (symbol brand present)', async () => {
    const validPipeline = createPipeline({
      input: [{ name: 'g1', guard: allowGuard }],
    });
    const result = await runInput(validPipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });
});

describe('runToolOutput', () => {
  it('filters tool output through output guardrails', async () => {
    const pipeline = createPipeline({
      output: [{ name: 'blocker', guard: (ctx) =>
        ctx.content.includes('secret')
          ? { action: 'block', reason: 'Contains secret data' }
          : { action: 'allow' }
      }],
    });

    const clean = await runToolOutput(pipeline, 'file contents here');
    expect(clean.passed).toBe(true);

    const blocked = await runToolOutput(pipeline, 'the secret is 12345');
    expect(blocked.passed).toBe(false);
  });

  it('passes tool name in meta', async () => {
    let receivedMeta: Record<string, unknown> | undefined;
    const pipeline = createPipeline({
      output: [{ name: 'spy', guard: (ctx) => { receivedMeta = ctx.meta; return { action: 'allow' }; } }],
    });
    await runToolOutput(pipeline, 'data', 'readFile');
    expect(receivedMeta).toEqual({ toolName: 'readFile' });
  });
});

describe('Fix 9: default timeout for guards', () => {
  it('applies default 5000ms timeout to guards without explicit timeoutMs', async () => {
    const hangingGuard: Guardrail = () => new Promise(() => {}); // never resolves
    const pipeline = createPipeline({
      input: [{ name: 'hanger', guard: hangingGuard }],
      // No timeoutMs on guard, default 5000ms applies
      // Use a short defaultTimeoutMs for test speed
      defaultTimeoutMs: 50,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    if (result.verdict.action === 'block') {
      expect(result.verdict.reason).toContain('timed out');
    }
  });

  it('guard-level timeoutMs overrides pipeline defaultTimeoutMs', async () => {
    const fastGuard: Guardrail = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { action: 'allow' };
    };
    const pipeline = createPipeline({
      input: [{ name: 'fast', guard: fastGuard, timeoutMs: 5000 }],
      defaultTimeoutMs: 10, // very short default, but guard overrides with 5000
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });

  it('defaultTimeoutMs: 0 disables default timeout', async () => {
    const fastGuard: Guardrail = () => ({ action: 'allow' });
    const pipeline = createPipeline({
      input: [{ name: 'fast', guard: fastGuard }],
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });
});

describe('Fix 10: fail-closed/fail-open semantics', () => {
  it('failClosed=true blocks on guardrail exception (safe default)', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'thrower', guard: throwGuard }],
      failClosed: true,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
    expect(result.verdict.action).toBe('block');
  });

  it('failClosed=false allows on guardrail exception (fail-open)', async () => {
    const pipeline = createPipeline({
      input: [
        { name: 'thrower', guard: throwGuard },
        { name: 'allow', guard: allowGuard },
      ],
      failClosed: false,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });

  it('defaults to failClosed=true when not specified', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'thrower', guard: throwGuard }],
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(false);
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

// =============================================================================
// Fix 7: Pipeline shallow copy fix - deep clone meta
// =============================================================================

describe('Fix 7: Pipeline deep clones meta on modify', () => {
  it('does not allow guardrail to mutate shared meta between pipeline stages', async () => {
    const originalMeta = { toolName: 'readFile', sensitive: true };
    const mutatingGuard: Guardrail = (ctx) => {
      // Attempt to mutate meta
      if (ctx.meta) {
        (ctx.meta as Record<string, unknown>).injected = 'malicious';
      }
      return { action: 'modify', modified: ctx.content + ' [cleaned]', reason: 'cleaned' };
    };
    const inspectingGuard: Guardrail = (ctx) => {
      // The inspecting guardrail should NOT see the mutation from the previous guardrail
      expect(ctx.meta).toBeDefined();
      expect((ctx.meta as Record<string, unknown>).injected).toBeUndefined();
      return { action: 'allow' };
    };

    const pipeline = createPipeline({
      input: [
        { name: 'mutator', guard: mutatingGuard },
        { name: 'inspector', guard: inspectingGuard },
      ],
    });

    const result = await runInput(pipeline, { content: 'hello', meta: originalMeta });
    expect(result.passed).toBe(true);
    // Original meta should not be mutated
    expect((originalMeta as Record<string, unknown>).injected).toBeUndefined();
  });

  it('preserves meta values through modify verdicts', async () => {
    const modGuard: Guardrail = () => {
      return { action: 'modify', modified: 'changed', reason: 'modified' };
    };
    const checkGuard: Guardrail = (ctx) => {
      expect(ctx.meta).toEqual({ userId: '123', role: 'admin' });
      return { action: 'allow' };
    };

    const pipeline = createPipeline({
      input: [
        { name: 'mod', guard: modGuard },
        { name: 'check', guard: checkGuard },
      ],
    });

    const result = await runInput(pipeline, {
      content: 'original',
      meta: { userId: '123', role: 'admin' },
    });
    expect(result.passed).toBe(true);
    expect(result.modifiedContent).toBe('changed');
  });

  it('handles undefined meta gracefully during modify', async () => {
    const modGuard: Guardrail = () => {
      return { action: 'modify', modified: 'changed', reason: 'modified' };
    };
    const checkGuard: Guardrail = (ctx) => {
      // meta should remain undefined, not become {}
      expect(ctx.meta).toBeUndefined();
      return { action: 'allow' };
    };

    const pipeline = createPipeline({
      input: [
        { name: 'mod', guard: modGuard },
        { name: 'check', guard: checkGuard },
      ],
    });

    // No meta provided
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.passed).toBe(true);
  });

  it('each modify creates independent meta copies', async () => {
    const metas: Record<string, unknown>[] = [];
    const modGuard1: Guardrail = (ctx) => {
      if (ctx.meta) metas.push(ctx.meta);
      return { action: 'modify', modified: 'v1', reason: 'mod1' };
    };
    const modGuard2: Guardrail = (ctx) => {
      if (ctx.meta) {
        metas.push(ctx.meta);
        // Mutate meta - should not affect guard1's captured meta
        (ctx.meta as Record<string, unknown>).guard2Added = true;
      }
      return { action: 'modify', modified: 'v2', reason: 'mod2' };
    };
    const finalGuard: Guardrail = (ctx) => {
      if (ctx.meta) metas.push(ctx.meta);
      return { action: 'allow' };
    };

    const pipeline = createPipeline({
      input: [
        { name: 'mod1', guard: modGuard1 },
        { name: 'mod2', guard: modGuard2 },
        { name: 'final', guard: finalGuard },
      ],
    });

    await runInput(pipeline, { content: 'start', meta: { original: true } });
    // guard2's mutation should not leak to guard3's meta
    expect(metas.length).toBe(3);
    // guard1 sees original meta
    expect(metas[0]).toEqual({ original: true });
    // guard3 sees a fresh copy that doesn't have guard2's mutation
    expect((metas[2] as Record<string, unknown>).guard2Added).toBeUndefined();
  });
});

// =============================================================================
// Issue 1: Timer leak fix — clearTimeout after race resolves
// =============================================================================

describe('Issue 1: timer leak fix — clearTimeout after guardrail completes', () => {
  it('does not leave dangling timers when fast guardrail wins the race', async () => {
    const timerIds: ReturnType<typeof setTimeout>[] = [];
    const originalClearTimeout = globalThis.clearTimeout;
    const clearedIds: ReturnType<typeof setTimeout>[] = [];
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
      if (id !== undefined) clearedIds.push(id as ReturnType<typeof setTimeout>);
      return originalClearTimeout(id);
    });
    const originalSetTimeout = globalThis.setTimeout;
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      const id = originalSetTimeout(fn as () => void, ms, ...args);
      timerIds.push(id);
      return id;
    });

    const fastGuard: Guardrail = () => ({ action: 'allow' });
    const pipeline = createPipeline({
      input: [{ name: 'fast', guard: fastGuard, timeoutMs: 5000 }],
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'hello' });

    clearSpy.mockRestore();
    setSpy.mockRestore();

    // Every timer that was set for the guardrail race should have been cleared
    for (const id of timerIds) {
      expect(clearedIds).toContain(id);
    }
  });

  it('clears timer even when guardrail throws (failClosed path)', async () => {
    const clearedIds: ReturnType<typeof setTimeout>[] = [];
    const originalClearTimeout = globalThis.clearTimeout;
    const originalSetTimeout = globalThis.setTimeout;
    const timerIds: ReturnType<typeof setTimeout>[] = [];

    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      const id = originalSetTimeout(fn as () => void, ms, ...args);
      timerIds.push(id);
      return id;
    });
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
      if (id !== undefined) clearedIds.push(id as ReturnType<typeof setTimeout>);
      return originalClearTimeout(id);
    });

    const throwGuard: Guardrail = () => { throw new Error('boom'); };
    const pipeline = createPipeline({
      input: [{ name: 'thrower', guard: throwGuard, timeoutMs: 5000 }],
      defaultTimeoutMs: 0,
    });
    await runInput(pipeline, { content: 'hello' });

    setSpy.mockRestore();
    clearSpy.mockRestore();

    // Timer should still be cleared even when guard threw
    for (const id of timerIds) {
      expect(clearedIds).toContain(id);
    }
  });
});

// =============================================================================
// Issue 2: Unbounded results array — maxResults cap
// =============================================================================

describe('Issue 2: maxResults cap — results array stays bounded', () => {
  it('caps results at maxResults, evicting oldest non-block events', async () => {
    const guards = Array.from({ length: 10 }, (_, i) => ({
      name: `g${i}`,
      guard: allowGuard,
    }));
    const pipeline = createPipeline({
      input: guards,
      maxResults: 5,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    // Results should never exceed maxResults
    expect(result.results.length).toBeLessThanOrEqual(5);
  });

  it('defaults to maxResults=1000 (accepts 1000 events without eviction)', async () => {
    const guards = Array.from({ length: 100 }, (_, i) => ({
      name: `g${i}`,
      guard: allowGuard,
    }));
    const pipeline = createPipeline({
      input: guards,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    // All 100 events fit within default 1000 cap
    expect(result.results.length).toBe(100);
  });

  it('retains all block events even when cap is exceeded', async () => {
    // 3 allow guards + 1 block guard, maxResults=2
    const pipeline = createPipeline({
      input: [
        { name: 'a1', guard: allowGuard },
        { name: 'a2', guard: allowGuard },
        { name: 'blocker', guard: blockGuard },
      ],
      maxResults: 2,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    // Results should be capped at 2 and include the block event
    expect(result.results.length).toBeLessThanOrEqual(2);
    const hasBlock = result.results.some((e) => e.verdict.action === 'block');
    expect(hasBlock).toBe(true);
  });

  it('maxResults=1 keeps only the most recent event', async () => {
    const pipeline = createPipeline({
      input: [
        { name: 'g1', guard: allowGuard },
        { name: 'g2', guard: allowGuard },
        { name: 'g3', guard: allowGuard },
      ],
      maxResults: 1,
      defaultTimeoutMs: 0,
    });
    const result = await runInput(pipeline, { content: 'hello' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].guardrail).toBe('g3');
  });

  // ---- PERF-005: O(1) amortized eviction via maintained pointer ----

  describe('bounded event buffer with tracked non-block pointer', () => {
    it('evicts oldest non-block first, preserving block events in FIFO order', async () => {
      // Interleave allow + block guards. When maxResults is reached, allow
      // events should be evicted while block events remain. A block terminates
      // the pipeline, so we need to build up the buffer via fail-open path.
      const events: GuardrailEvent[] = [];
      const pipeline = createPipeline({
        input: [
          { name: 'a1', guard: allowGuard },
          { name: 'a2', guard: allowGuard },
          { name: 'a3', guard: allowGuard },
          { name: 'thrower', guard: throwGuard }, // fail-closed -> block
        ],
        maxResults: 2,
        failClosed: true,
        defaultTimeoutMs: 0,
        onEvent: (e) => events.push(e),
      });
      const result = await runInput(pipeline, { content: 'hello' });

      // Pipeline stopped on block; results.length <= maxResults
      expect(result.results.length).toBeLessThanOrEqual(2);
      // The block event MUST survive eviction
      expect(result.results.some((e) => e.verdict.action === 'block')).toBe(true);
      // onEvent was called for every event, independent of buffer size
      expect(events.length).toBe(4);
    });

    it('stays under maxResults even with many allow events', async () => {
      const guards = Array.from({ length: 200 }, (_, i) => ({
        name: `g${i}`,
        guard: allowGuard,
      }));
      const pipeline = createPipeline({
        input: guards,
        maxResults: 10,
        defaultTimeoutMs: 0,
      });
      const result = await runInput(pipeline, { content: 'x' });
      expect(result.results.length).toBeLessThanOrEqual(10);
    });

    it('handles buffer eviction quickly even at high maxResults (O(1) amortized pointer)', async () => {
      // 10,000 allow guards with maxResults=1000 means ~9,000 evictions.
      // The old findIndex-based pushEvent was O(maxResults) per eviction,
      // i.e. ~9M comparisons. The new pointer is O(1) amortized and should
      // complete in well under 1s even on slow CI.
      const guards = Array.from({ length: 10_000 }, (_, i) => ({
        name: `g${i}`,
        guard: allowGuard,
      }));
      const pipeline = createPipeline({
        input: guards,
        maxResults: 1_000,
        defaultTimeoutMs: 0,
      });

      const start = performance.now();
      const result = await runInput(pipeline, { content: 'bench' });
      const elapsed = performance.now() - start;

      expect(result.results.length).toBe(1_000);
      expect(elapsed).toBeLessThan(2_000);
    });
  });
});
