import { describe, expect, it } from 'vitest';

import type { AgentEvent, TokenUsage } from 'harness-one/core';

import { runTriage, VerdictParseError } from '../../src/triage/run-triage.js';
import type { TriageHarness } from '../../src/triage/run-triage.js';

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 20 };

function createStubHarness(events: readonly AgentEvent[]): TriageHarness {
  return {
    costs: { getTotalCost: () => 0.0042 },
    async *run() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

const VALID_JSON = JSON.stringify({
  suggestedLabels: ['bug'],
  duplicates: [],
  reproSteps: ['Run the failing command.'],
  rationale: 'Looks like a plain bug.',
});

describe('runTriage', () => {
  it('accumulates text_delta events into the final message', async () => {
    const chars = VALID_JSON.split('');
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      ...chars.map<AgentEvent>((c) => ({ type: 'text_delta', text: c })),
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = createStubHarness(events);
    const result = await runTriage(harness, {
      number: 1,
      title: 'boom',
      body: 'broken',
    });
    expect(result.verdict.suggestedLabels).toEqual(['bug']);
    expect(result.costUsd).toBeCloseTo(0.0042);
    expect(result.iterations).toBe(1);
  });

  it('prefers message event content when provided', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'noise' },
      {
        type: 'message',
        message: { role: 'assistant', content: VALID_JSON },
        usage: USAGE,
      },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = createStubHarness(events);
    const result = await runTriage(harness, { number: 1, title: '', body: '' });
    expect(result.verdict.suggestedLabels).toEqual(['bug']);
  });

  it('throws VerdictParseError when stream cannot be parsed', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'not json' },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = createStubHarness(events);
    await expect(runTriage(harness, { number: 1, title: '', body: '' })).rejects.toBeInstanceOf(
      VerdictParseError,
    );
  });

  it('propagates harness error events as thrown errors', async () => {
    const events: AgentEvent[] = [{ type: 'error', error: new Error('boom') }];
    const harness = createStubHarness(events);
    await expect(runTriage(harness, { number: 1, title: '', body: '' })).rejects.toThrow(/boom/);
  });

  it('throws when stream ends before done', async () => {
    const events: AgentEvent[] = [{ type: 'text_delta', text: VALID_JSON }];
    const harness = createStubHarness(events);
    await expect(runTriage(harness, { number: 1, title: '', body: '' })).rejects.toThrow(/done/);
  });
});
