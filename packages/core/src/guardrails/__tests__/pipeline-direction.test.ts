/**
 * GuardrailEvent / GuardrailContext direction fidelity.
 *
 * `runToolOutput` and `runRagContext` previously ran their guard sets with
 * the collapsed `'output'` / `'input'` direction, so (a) guards branching on
 * `ctx.direction === 'tool_output' | 'rag'` never fired and (b) exporters
 * could not distinguish a tool-output block from a final-answer block.
 * These tests pin the full four-value direction contract.
 */

import { describe, it, expect } from 'vitest';
import { createPipeline } from '../pipeline.js';
import type { GuardrailContext, GuardrailDirection, GuardrailEvent } from '../types.js';

function captureGuard(seen: GuardrailContext[]) {
  return (ctx: GuardrailContext) => {
    seen.push(ctx);
    return { action: 'allow' as const };
  };
}

describe('guardrail direction fidelity', () => {
  it('runInput tags context and events with direction "input"', async () => {
    const seen: GuardrailContext[] = [];
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [{ name: 'capture', guard: captureGuard(seen) }],
      onEvent: (e) => events.push(e),
    });

    const result = await pipeline.runInput({ content: 'hello' });

    expect(result.passed).toBe(true);
    expect(seen[0].direction).toBe('input');
    expect(events[0].direction).toBe('input');
    expect(result.results[0].direction).toBe('input');
  });

  it('runOutput tags context and events with direction "output"', async () => {
    const seen: GuardrailContext[] = [];
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      output: [{ name: 'capture', guard: captureGuard(seen) }],
      onEvent: (e) => events.push(e),
    });

    await pipeline.runOutput({ content: 'answer' });

    expect(seen[0].direction).toBe('output');
    expect(events[0].direction).toBe('output');
  });

  it('runToolOutput tags context and events with direction "tool_output"', async () => {
    const seen: GuardrailContext[] = [];
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      output: [{ name: 'capture', guard: captureGuard(seen) }],
      onEvent: (e) => events.push(e),
    });

    const result = await pipeline.runToolOutput('tool says hi', 'web_search');

    expect(result.passed).toBe(true);
    expect(seen[0].direction).toBe('tool_output');
    expect(events[0].direction).toBe('tool_output');
    expect(result.results[0].direction).toBe('tool_output');
  });

  it('runToolOutput exposes the tool name as context source and meta', async () => {
    const seen: GuardrailContext[] = [];
    const pipeline = createPipeline({
      output: [{ name: 'capture', guard: captureGuard(seen) }],
    });

    await pipeline.runToolOutput('payload', 'web_search');

    expect(seen[0].source).toBe('web_search');
    expect(seen[0].meta?.['toolName']).toBe('web_search');
  });

  it('runRagContext tags context and events with direction "rag"', async () => {
    const seen: GuardrailContext[] = [];
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      input: [{ name: 'capture', guard: captureGuard(seen) }],
      onEvent: (e) => events.push(e),
    });

    const result = await pipeline.runRagContext(['chunk-a', 'chunk-b']);

    expect(result.passed).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.every((c) => c.direction === 'rag')).toBe(true);
    expect(events.every((e) => e.direction === 'rag')).toBe(true);
  });

  it('guards can branch on tool_output without meta digging', async () => {
    const pipeline = createPipeline({
      output: [
        {
          name: 'tool-output-only-block',
          guard: (ctx: GuardrailContext) =>
            ctx.direction === 'tool_output'
              ? { action: 'block' as const, reason: 'tool output rejected' }
              : { action: 'allow' as const },
        },
      ],
    });

    const finalAnswer = await pipeline.runOutput({ content: 'final answer' });
    const toolOutput = await pipeline.runToolOutput('tool payload', 't1');

    expect(finalAnswer.passed).toBe(true);
    expect(toolOutput.passed).toBe(false);
  });

  it('caller-supplied direction still wins over the phase default', async () => {
    const seen: GuardrailContext[] = [];
    const pipeline = createPipeline({
      input: [{ name: 'capture', guard: captureGuard(seen) }],
    });

    const forced: GuardrailDirection = 'rag';
    await pipeline.runInput({ content: 'x', direction: forced });

    expect(seen[0].direction).toBe('rag');
  });

  it('fail-closed error events carry the true phase direction', async () => {
    const events: GuardrailEvent[] = [];
    const pipeline = createPipeline({
      output: [
        {
          name: 'thrower',
          guard: () => {
            throw new Error('guard exploded');
          },
        },
      ],
      failClosed: true,
      onEvent: (e) => events.push(e),
    });

    const result = await pipeline.runToolOutput('payload', 't1');

    expect(result.passed).toBe(false);
    expect(events[0].direction).toBe('tool_output');
  });
});
