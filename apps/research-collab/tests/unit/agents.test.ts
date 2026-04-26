import { describe, expect, it } from 'vitest';

import type { AgentEvent, TokenUsage } from 'harness-one/core';

import {
  runResearcher,
  ResearcherFailure,
} from '../../src/agents/researcher.js';
import { runSpecialist, SpecialistFailure } from '../../src/agents/specialist.js';
import { runCoordinator, CoordinatorFailure } from '../../src/agents/coordinator.js';
import type { SecureHarness } from '@harness-one/preset';

const USAGE: TokenUsage = { inputTokens: 5, outputTokens: 5 };

interface StubHarnessOpts {
  readonly events: readonly AgentEvent[];
  readonly cost?: number;
}

/**
 * Build a minimal stub of SecureHarness — only the surface our agent
 * helpers consume (`run`, `costs.getTotalCost`, `tools.register`).
 */
function stubHarness(opts: StubHarnessOpts): SecureHarness {
  let cost = opts.cost ?? 0.001;
  const handlers: Array<(c: { id: string; name: string; arguments: string }) => Promise<unknown>> = [];
  const harness = {
    async *run() {
      // accrue cost up-front so getTotalCost() observes the change even if
      // the consumer breaks out of the iterator early on `done`.
      cost += 0.001;
      for (const e of opts.events) yield e;
    },
    costs: {
      getTotalCost: () => cost,
    },
    tools: {
      register: (tool: unknown) => {
        handlers.push(() => Promise.resolve({ ok: true, tool }));
      },
    },
  } as unknown as SecureHarness;
  return harness;
}

const VALID_RESEARCHER = JSON.stringify({
  subQuestions: [
    { index: 1, text: 'What is X?', rationale: 'foundation' },
  ],
});

describe('runResearcher', () => {
  it('returns parsed subQuestions and cost slice', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', text: VALID_RESEARCHER },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events, cost: 0.01 });
    const out = await runResearcher(harness, { runId: 'r1', question: 'q' });
    expect(out.subQuestions).toHaveLength(1);
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.iterations).toBe(1);
  });

  it('wraps ParseError into ResearcherFailure', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', text: 'not json' },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    await expect(runResearcher(harness, { runId: 'r1', question: 'q' })).rejects.toBeInstanceOf(
      ResearcherFailure,
    );
  });

  it('rethrows non-parse errors as-is', async () => {
    const events: AgentEvent[] = [{ type: 'error', error: new Error('upstream') }];
    const harness = stubHarness({ events });
    await expect(runResearcher(harness, { runId: 'r1', question: 'q' })).rejects.toThrow(/upstream/);
  });
});

const SPECIALIST_REPLY = JSON.stringify({
  answer: 'X is foundational.',
  confidence: 'high',
  citations: [
    { url: 'https://a.example/x', title: 'A', excerpt: 'X is foundational.' },
  ],
});

describe('runSpecialist', () => {
  it('returns parsed answer and tracks fetched URLs', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't1', name: 'web_fetch', arguments: '{"url":"https://a.example/x"}' }, iteration: 1 },
      { type: 'text_delta', text: SPECIALIST_REPLY },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    const out = await runSpecialist(harness, {
      runId: 'r1',
      originalQuestion: 'orig',
      subQuestion: { index: 1, text: 'What is X?', rationale: 'foundation' },
    });
    expect(out.answer.confidence).toBe('high');
    expect(out.fetchedUrls.has('https://a.example/x')).toBe(true);
  });

  it('wraps citation-fabrication errors into SpecialistFailure', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      // No web_fetch → fetchedUrls stays empty → citation rejection
      { type: 'text_delta', text: SPECIALIST_REPLY },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    await expect(
      runSpecialist(harness, {
        runId: 'r1',
        originalQuestion: 'orig',
        subQuestion: { index: 1, text: 'What is X?', rationale: 'foundation' },
      }),
    ).rejects.toBeInstanceOf(SpecialistFailure);
  });

  it('ignores web_fetch tool calls with malformed args', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't1', name: 'web_fetch', arguments: 'not-json' }, iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't2', name: 'web_fetch', arguments: '"a string"' }, iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't3', name: 'web_fetch', arguments: '{"url":""}' }, iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't4', name: 'web_fetch', arguments: '{"url":"https://a.example/x"}' }, iteration: 1 },
      { type: 'text_delta', text: SPECIALIST_REPLY },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    const out = await runSpecialist(harness, {
      runId: 'r1',
      originalQuestion: 'orig',
      subQuestion: { index: 1, text: 'What is X?', rationale: 'foundation' },
    });
    expect(Array.from(out.fetchedUrls)).toEqual(['https://a.example/x']);
  });

  it('ignores non-web_fetch tool calls when tracking URLs', async () => {
    const events: AgentEvent[] = [
      { type: 'tool_call', toolCall: { id: 't1', name: 'web_search', arguments: '{"query":"x"}' }, iteration: 1 },
      { type: 'tool_call', toolCall: { id: 't2', name: 'web_fetch', arguments: '{"url":"https://a.example/x"}' }, iteration: 1 },
      { type: 'text_delta', text: SPECIALIST_REPLY },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    const out = await runSpecialist(harness, {
      runId: 'r1',
      originalQuestion: 'orig',
      subQuestion: { index: 1, text: 'X', rationale: 'r' },
    });
    expect(Array.from(out.fetchedUrls)).toEqual(['https://a.example/x']);
  });

  it('rethrows non-parse errors', async () => {
    const events: AgentEvent[] = [{ type: 'error', error: new Error('boom') }];
    const harness = stubHarness({ events });
    await expect(
      runSpecialist(harness, {
        runId: 'r1',
        originalQuestion: 'orig',
        subQuestion: { index: 1, text: 'q', rationale: 'r' },
      }),
    ).rejects.toThrow(/boom/);
  });
});

const COORDINATOR_REPLY = JSON.stringify({
  summary: 'sum',
  markdown: '## h\n\nbody\n\n## Sources\n- https://a.example/x',
  citations: [{ url: 'https://a.example/x', title: 'A', excerpt: 'X.' }],
});

describe('runCoordinator', () => {
  it('returns parsed report and cost slice', async () => {
    const events: AgentEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', text: COORDINATOR_REPLY },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    const out = await runCoordinator(harness, {
      runId: 'r1',
      question: 'q',
      subQuestions: [{ index: 1, text: 'X', rationale: 'r' }],
      answers: [
        {
          subQuestionIndex: 1,
          answer: 'X.',
          confidence: 'high',
          citations: [{ url: 'https://a.example/x', title: 'A', excerpt: 'X.' }],
        },
      ],
    });
    expect(out.report.summary).toBe('sum');
    expect(out.report.citations).toHaveLength(1);
  });

  it('wraps fabricated-citation errors into CoordinatorFailure', async () => {
    const badReply = JSON.stringify({
      summary: 's',
      markdown: 'md',
      citations: [{ url: 'https://other.example/x', title: 't', excerpt: 'e' }],
    });
    const events: AgentEvent[] = [
      { type: 'text_delta', text: badReply },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    await expect(
      runCoordinator(harness, {
        runId: 'r1',
        question: 'q',
        subQuestions: [{ index: 1, text: 'X', rationale: 'r' }],
        answers: [
          {
            subQuestionIndex: 1,
            answer: 'X.',
            confidence: 'low',
            citations: [{ url: 'https://a.example/x', title: 'A', excerpt: 'X.' }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(CoordinatorFailure);
  });

  it('handles answers with no citations (empty allowed set)', async () => {
    const reply = JSON.stringify({ summary: 's', markdown: 'md', citations: [] });
    const events: AgentEvent[] = [
      { type: 'text_delta', text: reply },
      { type: 'done', reason: 'end_turn', totalUsage: USAGE },
    ];
    const harness = stubHarness({ events });
    const out = await runCoordinator(harness, {
      runId: 'r1',
      question: 'q',
      subQuestions: [{ index: 1, text: 'q', rationale: 'r' }],
      answers: [],
    });
    expect(out.report.citations).toHaveLength(0);
  });

  it('rethrows non-parse errors', async () => {
    const events: AgentEvent[] = [{ type: 'error', error: new Error('bus error') }];
    const harness = stubHarness({ events });
    await expect(
      runCoordinator(harness, {
        runId: 'r1',
        question: 'q',
        subQuestions: [],
        answers: [],
      }),
    ).rejects.toThrow(/bus error/);
  });
});
