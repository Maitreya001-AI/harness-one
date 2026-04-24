/**
 * D1 — AgentLoop ⟷ TraceManager ⟷ CostTracker口径一致
 *
 * Runs one mock-LLM session that emits two parallel tool calls followed by a
 * final assistant message, then cross-validates four independent views of
 * the same usage:
 *
 *  1. `AgentLoop.usage` (cumulative state on the loop)
 *  2. The `done.totalUsage` field on the final event
 *  3. Sum of per-iteration span attributes on the emitted trace
 *  4. `CostTracker` totals derived from the `onTokenUsage` hook
 *
 * If any of these drift (forgotten accumulator, double-counted retry,
 * mispriced span), the test fails at the specific invariant that broke.
 */

import { describe, it, expect } from 'vitest';
import { createAgentLoop } from '../../src/core/agent-loop.js';
import { createTraceManager } from '../../src/observe/trace-manager.js';
import { createCostTracker } from '../../src/observe/cost-tracker.js';
import { createRegistry } from '../../src/tools/registry.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { toolSuccess, ToolCapability } from '../../src/tools/types.js';
import { createMockAdapter } from '../../src/testing/test-utils.js';
import type { AgentEvent } from '../../src/core/events.js';
import type { Trace, TraceExporter } from '../../src/observe/types.js';

const MODEL = 'mock-llm';

describe('integration/D1 · AgentLoop + TraceManager + CostTracker', () => {
  it('agrees on token totals across loop state, done event, spans, and cost tracker', async () => {
    const captured: Trace[] = [];
    const collector: TraceExporter = {
      name: 'integration-collector',
      async exportTrace(trace) {
        captured.push(trace);
      },
      async exportSpan() {
        /* span-level export not needed — assertions read the trace snapshot */
      },
      async flush() {
        /* no-op */
      },
    };

    const tracer = createTraceManager({ exporters: [collector] });
    const costTracker = createCostTracker({
      pricing: [{ model: MODEL, inputPer1kTokens: 1.0, outputPer1kTokens: 2.0 }],
    });

    const adapter = createMockAdapter({
      responses: [
        {
          content: '',
          toolCalls: [
            { id: 't1', name: 'echo', arguments: '{"text":"a"}' },
            { id: 't2', name: 'echo', arguments: '{"text":"b"}' },
          ],
        },
        { content: 'final answer' },
      ],
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const echoTool = defineTool<{ text: string }>({
      name: 'echo',
      description: 'Echo the input text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      capabilities: [ToolCapability.Readonly],
      execute: async (params) => toolSuccess(params.text),
    });

    const registry = createRegistry({ allowedCapabilities: [ToolCapability.Readonly] });
    registry.register(echoTool);

    const loop = createAgentLoop({
      adapter,
      traceManager: tracer,
      onToolCall: registry.handler(),
      parallel: true,
      hooks: [
        {
          onTokenUsage: ({ usage }) => {
            costTracker.recordUsage({
              traceId: 'loop-run',
              model: MODEL,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          },
        },
      ],
    });

    const events: AgentEvent[] = [];
    for await (const e of loop.run([{ role: 'user', content: 'run' }])) {
      events.push(e);
    }

    await tracer.flush();

    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(done).toBeDefined();
    expect(done!.reason).toBe('end_turn');

    // --- Invariant 1 · loop state matches the final event ---
    expect(loop.usage).toEqual(done!.totalUsage);

    // --- Invariant 2 · both agree with 2 adapter calls × {100 in, 50 out} ---
    expect(loop.usage).toEqual({ inputTokens: 200, outputTokens: 100 });

    // --- Invariant 3 · exactly one trace, and its span inventory matches the
    // loop structure (two iterations, two tool calls on the first iteration). ---
    expect(captured).toHaveLength(1);
    const trace = captured[0];
    expect(trace.status).toBe('completed');

    const iterationSpans = trace.spans.filter((s) => s.name.startsWith('iteration-'));
    const toolSpans = trace.spans.filter((s) => s.name.startsWith('tool:'));
    expect(iterationSpans).toHaveLength(2);
    expect(toolSpans).toHaveLength(2);
    // Every tool span is a child of an iteration span, never of the trace root.
    for (const toolSpan of toolSpans) {
      expect(iterationSpans.some((s) => s.id === toolSpan.parentId)).toBe(true);
    }

    // --- Invariant 4 · span-level token attrs sum to loop.usage ---
    const spanTotals = iterationSpans.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + Number(s.attributes['inputTokens'] ?? 0),
        outputTokens: acc.outputTokens + Number(s.attributes['outputTokens'] ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    expect(spanTotals).toEqual(loop.usage);

    // --- Invariant 5 · CostTracker total matches price(loop.usage) ---
    const expectedCost =
      (loop.usage.inputTokens / 1000) * 1.0 + (loop.usage.outputTokens / 1000) * 2.0;
    expect(costTracker.getTotalCost()).toBeCloseTo(expectedCost, 10);
    expect(costTracker.getCostByTrace('loop-run')).toBeCloseTo(expectedCost, 10);

    // Every model-bucketed total must appear under the one priced model.
    const byModel = costTracker.getCostByModel();
    expect(byModel.get(MODEL)).toBeCloseTo(expectedCost, 10);
  });
});
