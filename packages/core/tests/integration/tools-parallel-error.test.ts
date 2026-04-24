/**
 * D3 — Parallel tool dispatch with one tool throwing.
 *
 * Three tools are fanned out in a single adapter batch. One throws; the other
 * two return normal results. The worker pool must surface the error in the
 * failing tool's `tool_result` payload (not as an uncaught exception), keep
 * the two healthy results in original call order, and let the loop iterate
 * forward to the next adapter call.
 *
 * If the loop instead bails on the first tool error, these invariants break
 * at `adapter.calls.length === 1`.
 */

import { describe, it, expect } from 'vitest';
import { createAgentLoop } from '../../src/core/agent-loop.js';
import { createRegistry } from '../../src/tools/registry.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { toolSuccess, ToolCapability } from '../../src/tools/types.js';
import { createMockAdapter } from '../../src/testing/test-utils.js';
import type { AgentEvent } from '../../src/core/events.js';
import type { ToolCallRequest } from '../../src/core/types.js';

describe('integration/D3 · tools registry + parallel execution + isolated tool failure', () => {
  it('keeps healthy tool results and surfaces the thrown one as an error payload without bailing the loop', async () => {
    const alphaCall: ToolCallRequest = { id: 'a', name: 'alpha', arguments: '{}' };
    const bustedCall: ToolCallRequest = { id: 'b', name: 'busted', arguments: '{}' };
    const gammaCall: ToolCallRequest = { id: 'g', name: 'gamma', arguments: '{}' };

    const adapter = createMockAdapter({
      responses: [
        { content: '', toolCalls: [alphaCall, bustedCall, gammaCall] },
        { content: 'final assembled answer' },
      ],
    });

    const execLog: string[] = [];
    const alphaTool = defineTool<Record<string, never>>({
      name: 'alpha',
      description: 'Returns the string "alpha-ok"',
      parameters: { type: 'object', properties: {}, required: [] },
      capabilities: [ToolCapability.Readonly],
      execute: async () => {
        execLog.push('alpha:start');
        // Deliberate micro-delay so parallel dispatch is observable via the log.
        await new Promise((r) => setTimeout(r, 10));
        execLog.push('alpha:end');
        return toolSuccess('alpha-ok');
      },
    });
    const bustedTool = defineTool<Record<string, never>>({
      name: 'busted',
      description: 'Always throws',
      parameters: { type: 'object', properties: {}, required: [] },
      capabilities: [ToolCapability.Readonly],
      execute: async () => {
        execLog.push('busted:start');
        await new Promise((r) => setTimeout(r, 5));
        execLog.push('busted:throw');
        throw new Error('busted is on fire');
      },
    });
    const gammaTool = defineTool<Record<string, never>>({
      name: 'gamma',
      description: 'Returns the string "gamma-ok"',
      parameters: { type: 'object', properties: {}, required: [] },
      capabilities: [ToolCapability.Readonly],
      execute: async () => {
        execLog.push('gamma:start');
        await new Promise((r) => setTimeout(r, 10));
        execLog.push('gamma:end');
        return toolSuccess('gamma-ok');
      },
    });

    const registry = createRegistry({ allowedCapabilities: [ToolCapability.Readonly] });
    registry.register(alphaTool);
    registry.register(bustedTool);
    registry.register(gammaTool);

    const loop = createAgentLoop({
      adapter,
      onToolCall: registry.handler(),
      parallel: true,
    });

    const events: AgentEvent[] = [];
    for await (const e of loop.run([{ role: 'user', content: 'fan out' }])) {
      events.push(e);
    }

    // --- Invariant 1 · loop ran to a clean end_turn (worker pool didn't hang) ---
    const done = events.find(
      (e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done',
    );
    expect(done?.reason).toBe('end_turn');

    // --- Invariant 2 · both adapter iterations happened ---
    expect(adapter.calls).toHaveLength(2);

    // --- Invariant 3 · all three tools ran (parallel dispatch did not
    // short-circuit on the thrown tool) ---
    expect(execLog.filter((l) => l.endsWith(':start'))).toHaveLength(3);
    expect(execLog).toContain('alpha:end');
    expect(execLog).toContain('gamma:end');
    expect(execLog).toContain('busted:throw');

    // --- Invariant 4 · each tool call has a matching tool_result, in original order ---
    const toolResults = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(toolResults.map((r) => r.toolCallId)).toEqual(['a', 'b', 'g']);

    // --- Invariant 5 · the two healthy results are string payloads ---
    const alphaResult = toolResults.find((r) => r.toolCallId === 'a')!.result;
    const gammaResult = toolResults.find((r) => r.toolCallId === 'g')!.result;
    expect(alphaResult).toBe('alpha-ok');
    expect(gammaResult).toBe('gamma-ok');

    // --- Invariant 6 · the failing tool's result carries the registry's
    // structured error envelope (NOT thrown into the consumer). The registry
    // converts the raw exception into `{ kind: 'error', success: false, error:
    // ToolFeedback }` so the loop sees a uniform shape regardless of whether
    // the tool returned `toolError(...)` or threw. ---
    const bustedResult = toolResults.find((r) => r.toolCallId === 'b')!.result as {
      kind?: string;
      success?: boolean;
      error?: { message: string; category: string };
    };
    expect(typeof bustedResult).toBe('object');
    expect(bustedResult.kind).toBe('error');
    expect(bustedResult.success).toBe(false);
    expect(bustedResult.error?.message).toContain('busted is on fire');
    expect(bustedResult.error?.category).toBe('internal');

    // --- Invariant 7 · no top-level error/done-error event ---
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    // --- Invariant 8 · second adapter call's conversation carries all three
    // tool messages, with the error tool's content stringified alongside ---
    const secondTurnTools = adapter.calls[1].messages.filter((m) => m.role === 'tool');
    expect(secondTurnTools).toHaveLength(3);
    const bustedMsg = secondTurnTools.find((m) => (m as { toolCallId?: string }).toolCallId === 'b');
    expect(bustedMsg?.content).toContain('busted is on fire');
  });
});
