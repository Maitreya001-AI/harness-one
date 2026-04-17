/**
 * Wave-13 E-6: per-guard fairness — clamp guard timeoutMs to remaining
 * global budget and emit a `guard_timeout` span event on guard-level timeout.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPipeline, runInput } from '../pipeline.js';
import type { Guardrail, GuardrailEvent } from '../types.js';

// A guard that sleeps for `ms` before returning allow.
const sleepGuard = (ms: number): Guardrail => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return { action: 'allow' };
};

describe('createPipeline Wave-13 E-6: per-guard fairness', () => {
  it('clamps guard timeoutMs to remaining global budget', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      // 50ms global budget, guard asks for 500ms — should be clamped to <=50ms
      totalTimeoutMs: 50,
      failClosed: true,
      onEvent: (e) => events.push(e),
      input: [
        { name: 'slow', guard: sleepGuard(200), timeoutMs: 500 },
      ],
    });
    const start = Date.now();
    const result = await runInput(pipeline, { content: 'x' });
    const elapsed = Date.now() - start;

    // The pipeline should reject (failClosed) well before 500ms.
    expect(result.passed).toBe(false);
    expect(elapsed).toBeLessThan(400);
  });

  it('emits guard_timeout span event on guard-level timeout', async () => {
    const onEventSpy = vi.fn<(e: GuardrailEvent) => void>();
    const pipeline = createPipeline({
      totalTimeoutMs: 1000,
      failClosed: true,
      onEvent: onEventSpy,
      input: [
        { name: 'slow', guard: sleepGuard(200), timeoutMs: 20 },
      ],
    });
    await runInput(pipeline, { content: 'x' });

    const guardTimeoutEvents = onEventSpy.mock.calls
      .map((c) => c[0])
      .filter((e) =>
        e.verdict.action === 'block' &&
        typeof e.verdict.reason === 'string' &&
        e.verdict.reason.startsWith('guard_timeout:'),
      );
    expect(guardTimeoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(guardTimeoutEvents[0].guardrail).toBe('slow');
    expect(guardTimeoutEvents[0].direction).toBe('input');
  });

  it('does not clamp when no totalTimeoutMs is configured', async () => {
    const pipeline = createPipeline({
      totalTimeoutMs: 0, // disabled
      failClosed: true,
      input: [
        // Fast guard — shouldn't time out with a large own-timeout.
        { name: 'fast', guard: sleepGuard(5), timeoutMs: 5000 },
      ],
    });
    const result = await runInput(pipeline, { content: 'x' });
    expect(result.passed).toBe(true);
  });

  it('honors guard timeoutMs when smaller than global remaining', async () => {
    const onEventSpy = vi.fn<(e: GuardrailEvent) => void>();
    const pipeline = createPipeline({
      totalTimeoutMs: 10_000,
      failClosed: true,
      onEvent: onEventSpy,
      input: [
        { name: 'tight', guard: sleepGuard(200), timeoutMs: 20 },
      ],
    });
    await runInput(pipeline, { content: 'x' });
    // Should still emit a guard_timeout because the guard can't finish in 20ms.
    const timeoutEvents = onEventSpy.mock.calls
      .map((c) => c[0])
      .filter((e) =>
        typeof e.verdict.reason === 'string' &&
        e.verdict.reason.startsWith('guard_timeout:'),
      );
    expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
  });
});
