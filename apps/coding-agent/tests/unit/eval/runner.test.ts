import { describe, expect, it } from 'vitest';

import { runEval } from '../../../src/eval/runner.js';
import type { EvalFixture } from '../../../src/eval/types.js';
import { createMockAdapter } from '../../integration/mock-adapter.js';

const noopFixture: EvalFixture = {
  id: 'noop-1',
  name: 'plan-only smoke',
  workspace: { 'a.txt': 'hi' },
  prompt: 'do nothing',
  budget: { tokens: 1000, iterations: 1, durationMs: 5000 },
  verify: async ({ result }) => ({ pass: result.taskId.length > 0 }),
};

const writeFixture: EvalFixture = {
  id: 'write-1',
  name: 'write expected file',
  workspace: { 'a.txt': 'old' },
  prompt: 'rewrite a.txt to "new"',
  budget: { tokens: 2000, iterations: 4, durationMs: 10000 },
  verify: async ({ result }) => {
    if (result.changedFiles.includes('a.txt')) return { pass: true };
    return { pass: false, reason: 'a.txt not in changedFiles' };
  },
};

const failFixture: EvalFixture = {
  id: 'fail-1',
  name: 'always fails',
  workspace: { 'a.txt': 'x' },
  prompt: 'noop',
  budget: { tokens: 500, iterations: 1, durationMs: 5000 },
  verify: async () => ({ pass: false, reason: 'test wants this to fail' }),
};

describe('runEval', () => {
  it('runs each fixture and aggregates pass/fail', async () => {
    const report = await runEval({
      fixtures: [noopFixture, failFixture],
      adapterFor: () => createMockAdapter([{ text: 'noop' }]),
    });
    expect(report.cases).toHaveLength(2);
    expect(report.passCount).toBe(1);
    expect(report.failCount).toBe(1);
    expect(report.passRate).toBe(0.5);
  });

  it('honours tagFilter', async () => {
    const tagged: EvalFixture = { ...noopFixture, id: 'tagged-1', tags: ['smoke'] };
    const untagged: EvalFixture = { ...noopFixture, id: 'untagged-1' };
    const report = await runEval({
      fixtures: [tagged, untagged],
      tagFilter: ['smoke'],
      adapterFor: () => createMockAdapter([{ text: 'noop' }]),
    });
    expect(report.cases.map((c) => c.fixtureId)).toEqual(['tagged-1']);
  });

  it('writes the workspace before invoking the adapter', async () => {
    const seenAdapter = createMockAdapter([
      {
        toolCalls: [
          { id: 'tc1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        ],
      },
      { text: 'done' },
    ]);
    const report = await runEval({
      fixtures: [
        {
          ...writeFixture,
          verify: async ({ result }) => ({ pass: result.iterations > 0 }),
        },
      ],
      adapterFor: () => seenAdapter,
    });
    expect(report.cases[0].pass).toBe(true);
  });

  it('catches verifier exceptions and reports as failure', async () => {
    const fixture: EvalFixture = {
      ...noopFixture,
      id: 'throwy',
      verify: async () => {
        throw new Error('verifier blew up');
      },
    };
    const report = await runEval({
      fixtures: [fixture],
      adapterFor: () => createMockAdapter([{ text: 'noop' }]),
    });
    expect(report.cases[0].pass).toBe(false);
    expect(report.cases[0].reason).toContain('verifier blew up');
  });

  it('rejects fixtures with `..` in workspace paths', async () => {
    const evil: EvalFixture = {
      ...noopFixture,
      id: 'evil',
      workspace: { '../escape': 'x' },
    };
    await expect(
      runEval({
        fixtures: [evil],
        adapterFor: () => createMockAdapter([{ text: 'noop' }]),
      }),
    ).rejects.toThrow();
  });

  it('reports zero pass-rate when no fixtures match tagFilter', async () => {
    const report = await runEval({
      fixtures: [{ ...noopFixture, tags: ['only-this-tag'] }],
      tagFilter: ['unmatched'],
      adapterFor: () => createMockAdapter([{ text: 'noop' }]),
    });
    expect(report.passRate).toBe(0);
  });
});
