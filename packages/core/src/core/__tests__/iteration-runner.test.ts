/**
 * Iteration-runner behaviour tests — focused on Wave-12 P2-8 (bounded
 * tool-result serialization). The AgentLoop-level `agent-loop.test.ts`
 * also exercises the end-to-end path; these black-box tests observe the
 * serialized tool-message content end-to-end because the helper is
 * module-private.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../agent-loop.js';
import type { AgentAdapter, Message, ToolCallRequest } from '../types.js';
import type { AgentEvent } from '../events.js';

const USAGE = { inputTokens: 1, outputTokens: 1 };

async function runWithResult(toolResult: unknown): Promise<Message> {
  const toolCall: ToolCallRequest = { id: 'call_1', name: 'tool', arguments: '{}' };
  let captured: Message[] = [];
  let callCount = 0;
  const adapter: AgentAdapter = {
    async chat(params) {
      captured = [...params.messages];
      callCount++;
      if (callCount === 1) {
        return { message: { role: 'assistant', content: '', toolCalls: [toolCall] }, usage: USAGE };
      }
      return { message: { role: 'assistant', content: 'ok' }, usage: USAGE };
    },
  };
  const onToolCall = vi.fn().mockResolvedValue(toolResult);
  const loop = new AgentLoop({ adapter, onToolCall });
  const events: AgentEvent[] = [];
  for await (const e of loop.run([{ role: 'user', content: 'go' }])) events.push(e);
  const msg = captured.find((m) => m.role === 'tool');
  if (!msg) throw new Error('no tool message');
  return msg;
}

describe('iteration-runner — Wave-12 P2-8 serializeToolResult', () => {
  it('truncates payloads larger than 1 MiB with a marker preserving the prefix', async () => {
    const huge = 'q'.repeat(1.5 * 1024 * 1024);
    const msg = await runWithResult({ payload: huge });
    expect(msg.content.length).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(msg.content).toMatch(/\[truncated: result exceeded 1MiB\]$/);
    // The prefix preserves visible context — starts with the opening brace
    // and the `payload` key, not a placeholder.
    expect(msg.content.startsWith('{"payload":"qqq')).toBe(true);
  });

  it('drops keys past the depth limit without producing [max depth exceeded] literals', async () => {
    // Build a 15-deep chain; cap is 10.
    type Chain = { next?: Chain; leaf?: string };
    const root: Chain = {};
    let cursor = root;
    for (let i = 0; i < 15; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.leaf = 'bottom';
    const msg = await runWithResult(root);
    // Past-cap values are `undefined`-returned → dropped entirely.
    expect(msg.content).not.toContain('bottom');
    // Result is still valid JSON.
    expect(() => JSON.parse(msg.content)).not.toThrow();
  });

  it('does NOT mis-flag wide sibling trees as deep (true-depth tracking)', async () => {
    // 50 shallow siblings used to over-count depth under the old
    // implementation (which incremented a shared `depth` counter on every
    // key visit). With per-container depth tracking via WeakMap, wide
    // objects serialize fully.
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50; i++) wide[`k${i}`] = i;
    const msg = await runWithResult(wide);
    const parsed = JSON.parse(msg.content);
    expect(Object.keys(parsed)).toHaveLength(50);
    expect(parsed.k49).toBe(49);
  });

  it('replaces circular references with [circular]', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const msg = await runWithResult(cyclic);
    expect(msg.content).toContain('[circular]');
  });
});
