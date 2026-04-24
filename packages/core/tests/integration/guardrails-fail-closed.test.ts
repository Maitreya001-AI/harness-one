/**
 * D2 — Input / tool_output / output guardrails fail closed.
 *
 * Three hook points × one pipeline × one configurable block marker. The same
 * pipeline fires at all three loop phases; we rotate which phase the test
 * content triggers, capture the event sequence, and assert the loop honours
 * the documented semantics:
 *
 *   - input block   → `guardrail_blocked(input)` + `error` + `done(error)`,
 *                     adapter never called
 *   - tool-output   → `guardrail_blocked(tool_output)`, tool-call result
 *                     rewritten to a stub, loop continues to `end_turn`
 *   - output block  → `guardrail_blocked(output)` + `error` + `done(error)`
 *
 * After a blocked run, a fresh AgentLoop sharing the same pipeline returns
 * to steady state — the pipeline is stateless between runs so no previous
 * block can leak into the next run's decision.
 */

import { describe, it, expect } from 'vitest';
import { createAgentLoop } from '../../src/core/agent-loop.js';
import { createPipeline } from '../../src/guardrails/pipeline.js';
import type { Guardrail } from '../../src/core/guardrail-port.js';
import { createMockAdapter } from '../../src/testing/test-utils.js';
import type { AgentEvent } from '../../src/core/events.js';
import { HarnessError, HarnessErrorCode } from '../../src/core/errors.js';

const MARKER = '__BLOCK_ME__';

/** Guard that fires iff content carries the shared marker — stateless. */
const markerBlocker: Guardrail = (ctx) =>
  ctx.content.includes(MARKER)
    ? { action: 'block', reason: `blocked on marker` }
    : { action: 'allow' };

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('integration/D2 · guardrails fail-closed across three hook points', () => {
  it('input-phase block halts the loop with guardrail_blocked → error → done(error) and skips the adapter', async () => {
    const adapter = createMockAdapter({ responses: [{ content: 'never reached' }] });
    const pipeline = createPipeline({
      input: [{ name: 'input-block', guard: markerBlocker }],
    });
    const loop = createAgentLoop({ adapter, inputPipeline: pipeline });

    const events = await drain(
      loop.run([{ role: 'user', content: `please ${MARKER}` }]),
    );

    expect(adapter.calls).toHaveLength(0);

    const types = events.map((e) => e.type);
    const blockedIdx = types.indexOf('guardrail_blocked');
    const errorIdx = types.indexOf('error');
    const doneIdx = types.indexOf('done');
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    // Event order is load-bearing: `guardrail_blocked` must precede the
    // paired `error`, which must precede `done`. A drift here means a
    // consumer branching on `error` before seeing the guardrail context.
    expect(blockedIdx).toBeLessThan(errorIdx);
    expect(errorIdx).toBeLessThan(doneIdx);

    const blocked = events.find(
      (e): e is Extract<AgentEvent, { type: 'guardrail_blocked' }> => e.type === 'guardrail_blocked',
    )!;
    expect(blocked.phase).toBe('input');
    expect(blocked.guardName).toBe('input-block');

    const err = events.find(
      (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
    )!;
    expect((err.error as HarnessError).code).toBe(HarnessErrorCode.GUARD_VIOLATION);

    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done',
    )!;
    expect(done.reason).toBe('error');
  });

  it('tool_output-phase block rewrites the offending tool result to a stub and lets the loop continue', async () => {
    const toolCall = { id: 't1', name: 'fetcher', arguments: '{}' };
    const adapter = createMockAdapter({
      responses: [
        { content: '', toolCalls: [toolCall] },
        { content: 'clean final answer' },
      ],
    });
    const pipeline = createPipeline({
      output: [{ name: 'tool-block', guard: markerBlocker }],
    });

    const loop = createAgentLoop({
      adapter,
      outputPipeline: pipeline,
      onToolCall: async () => `here is ${MARKER} payload`,
    });

    const events = await drain(loop.run([{ role: 'user', content: 'fetch' }]));

    // Adapter is called twice — the loop recovered past the rewritten stub.
    expect(adapter.calls).toHaveLength(2);
    const toolMsg = adapter.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain(HarnessErrorCode.GUARD_VIOLATION);
    expect(toolMsg!.content).toContain('tool-block');
    expect(toolMsg!.content).not.toContain(MARKER);

    const blocked = events.find(
      (e): e is Extract<AgentEvent, { type: 'guardrail_blocked' }> => e.type === 'guardrail_blocked',
    );
    expect(blocked?.phase).toBe('tool_output');
    expect(blocked?.guardName).toBe('tool-block');

    // No error event — tool-output rewrite is a non-terminal signal.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(done?.reason).toBe('end_turn');
  });

  it('output-phase block on the final assistant message halts the loop with guardrail_blocked → error → done(error)', async () => {
    const adapter = createMockAdapter({
      responses: [{ content: `here is the ${MARKER}` }],
    });
    const pipeline = createPipeline({
      output: [{ name: 'output-block', guard: markerBlocker }],
    });
    const loop = createAgentLoop({ adapter, outputPipeline: pipeline });

    const events = await drain(loop.run([{ role: 'user', content: 'gimme' }]));

    const types = events.map((e) => e.type);
    const blockedIdx = types.indexOf('guardrail_blocked');
    const errorIdx = types.indexOf('error');
    const doneIdx = types.indexOf('done');
    expect(blockedIdx).toBeLessThan(errorIdx);
    expect(errorIdx).toBeLessThan(doneIdx);

    const blocked = events.find(
      (e): e is Extract<AgentEvent, { type: 'guardrail_blocked' }> => e.type === 'guardrail_blocked',
    );
    expect(blocked?.phase).toBe('output');
    expect(blocked?.guardName).toBe('output-block');

    const err = events.find(
      (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
    );
    expect((err?.error as HarnessError).code).toBe(HarnessErrorCode.GUARD_VIOLATION);

    expect(
      events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')?.reason,
    ).toBe('error');
  });

  it('the same shared pipeline accepts a clean run immediately after a blocked run (no pollution)', async () => {
    const pipeline = createPipeline({
      input: [{ name: 'shared-input', guard: markerBlocker }],
      output: [{ name: 'shared-output', guard: markerBlocker }],
    });

    // Run #1 — blocked input.
    const blockedAdapter = createMockAdapter({ responses: [{ content: 'unused' }] });
    const blockedLoop = createAgentLoop({
      adapter: blockedAdapter,
      inputPipeline: pipeline,
      outputPipeline: pipeline,
    });
    const blockedEvents = await drain(
      blockedLoop.run([{ role: 'user', content: `bad: ${MARKER}` }]),
    );
    expect(
      blockedEvents.find((e) => e.type === 'guardrail_blocked'),
    ).toBeDefined();

    // Run #2 — clean content on a fresh loop with the SAME pipeline.
    const cleanAdapter = createMockAdapter({ responses: [{ content: 'ok' }] });
    const cleanLoop = createAgentLoop({
      adapter: cleanAdapter,
      inputPipeline: pipeline,
      outputPipeline: pipeline,
    });
    const cleanEvents = await drain(
      cleanLoop.run([{ role: 'user', content: 'hi' }]),
    );

    expect(cleanAdapter.calls).toHaveLength(1);
    expect(cleanEvents.find((e) => e.type === 'guardrail_blocked')).toBeUndefined();
    expect(cleanEvents.find((e) => e.type === 'error')).toBeUndefined();
    expect(
      cleanEvents.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')?.reason,
    ).toBe('end_turn');
  });
});
