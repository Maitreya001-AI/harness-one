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
    // Only the non-throwing guardrail should produce an event
    expect(result.results).toHaveLength(1);
    expect(result.results[0].guardrail).toBe('allow');
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
