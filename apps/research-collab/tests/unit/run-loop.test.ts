import { describe, expect, it } from 'vitest';

import type { AgentEvent, TokenUsage } from 'harness-one/core';

import { runHarnessLoop, type RunnableHarness } from '../../src/agents/run-loop.js';

const USAGE: TokenUsage = { inputTokens: 3, outputTokens: 4 };

function harnessFromEvents(events: readonly AgentEvent[]): RunnableHarness {
  return {
    async *run() {
      for (const e of events) yield e;
    },
  };
}

describe('runHarnessLoop', () => {
  it('accumulates text deltas and counts iterations', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const out = await runHarnessLoop(harnessFromEvents(events), {
      system: 's',
      user: 'u',
      sessionId: 'x',
    });
    expect(out.assistantMessage).toBe('hello');
    expect(out.iterations).toBe(1);
  });

  it('overrides accumulated text with assistant message event', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'noise' },
      {
        type: 'message',
        message: { role: 'assistant', content: 'final' },
        usage: USAGE,
      },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const out = await runHarnessLoop(harnessFromEvents(events), {
      system: 's',
      user: 'u',
      sessionId: 'x',
    });
    expect(out.assistantMessage).toBe('final');
  });

  it('throws when an error event is emitted', async () => {
    const events: AgentEvent[] = [{ type: 'error', error: new Error('boom') }];
    await expect(
      runHarnessLoop(harnessFromEvents(events), { system: 's', user: 'u', sessionId: 'x' }),
    ).rejects.toThrow(/boom/);
  });

  it('throws when stream ends before a done event', async () => {
    const events: AgentEvent[] = [{ type: 'text_delta', text: 'x' }];
    await expect(
      runHarnessLoop(harnessFromEvents(events), { system: 's', user: 'u', sessionId: 'x' }),
    ).rejects.toThrow(/done event/);
  });

  it('forwards every event to the optional onEvent callback', async () => {
    const seen: AgentEvent['type'][] = [];
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't1', name: 'web_fetch', arguments: '{}' }, iteration: 1 },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    await runHarnessLoop(harnessFromEvents(events), {
      system: 's',
      user: 'u',
      sessionId: 'x',
      onEvent: (event) => {
        seen.push(event.type);
      },
    });
    expect(seen).toContain('tool_call');
  });

  it('treats string error events the same as Error instances', async () => {
    const events: AgentEvent[] = [{ type: 'error', error: 'plain' as unknown as Error }];
    await expect(
      runHarnessLoop(harnessFromEvents(events), { system: 's', user: 'u', sessionId: 'x' }),
    ).rejects.toThrow(/plain/);
  });

  it('ignores assistant message events with empty content', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'kept' },
      { type: 'message', message: { role: 'assistant', content: '' }, usage: USAGE },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const out = await runHarnessLoop(harnessFromEvents(events), {
      system: 's',
      user: 'u',
      sessionId: 'x',
    });
    expect(out.assistantMessage).toBe('kept');
  });

  it('iteration counter ignores non-iteration events', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'iteration_start', iteration: 2 },
      { type: 'text_delta', text: 'x' },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const out = await runHarnessLoop(harnessFromEvents(events), {
      system: 's',
      user: 'u',
      sessionId: 'x',
    });
    expect(out.iterations).toBe(2);
  });
});
