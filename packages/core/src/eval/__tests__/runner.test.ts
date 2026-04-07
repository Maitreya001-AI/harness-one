import { describe, it, expect } from 'vitest';
import { createEvalRunner } from '../runner.js';
import { createRelevanceScorer } from '../scorers.js';
import { HarnessError } from '../../core/errors.js';
import type { Scorer } from '../types.js';

const alwaysPassScorer: Scorer = {
  name: 'always-pass',
  description: 'Always returns score 1.0',
  async score() {
    return { score: 1.0, explanation: 'Always passes' };
  },
};

const alwaysFailScorer: Scorer = {
  name: 'always-fail',
  description: 'Always returns score 0.0',
  async score() {
    return { score: 0.0, explanation: 'Always fails' };
  },
};

describe('createEvalRunner', () => {
  it('throws if no scorers provided', () => {
    expect(() => createEvalRunner({ scorers: [] })).toThrow(HarnessError);
  });

  describe('run', () => {
    it('runs all cases through generate and scorers', async () => {
      const runner = createEvalRunner({ scorers: [alwaysPassScorer] });
      const cases = [
        { id: 'c1', input: 'hello' },
        { id: 'c2', input: 'world' },
      ];
      const report = await runner.run(cases, async (input) => `echo: ${input}`);

      expect(report.totalCases).toBe(2);
      expect(report.passedCases).toBe(2);
      expect(report.failedCases).toBe(0);
      expect(report.passRate).toBe(1.0);
      expect(report.results).toHaveLength(2);
      expect(report.averageScores['always-pass']).toBe(1.0);
    });

    it('marks cases as failed when below threshold', async () => {
      const runner = createEvalRunner({
        scorers: [alwaysFailScorer],
        passThreshold: 0.7,
      });
      const report = await runner.run(
        [{ id: 'c1', input: 'hello' }],
        async (input) => input,
      );

      expect(report.passedCases).toBe(0);
      expect(report.failedCases).toBe(1);
      expect(report.passRate).toBe(0);
    });

    it('throws on empty cases', async () => {
      const runner = createEvalRunner({ scorers: [alwaysPassScorer] });
      await expect(runner.run([], async (i) => i)).rejects.toThrow(HarnessError);
    });

    it('uses multiple scorers', async () => {
      const runner = createEvalRunner({
        scorers: [alwaysPassScorer, alwaysFailScorer],
        passThreshold: 0.5,
      });
      const report = await runner.run(
        [{ id: 'c1', input: 'test' }],
        async (i) => i,
      );
      // Fails because alwaysFailScorer returns 0 < 0.5
      expect(report.passedCases).toBe(0);
      expect(report.results[0].scores['always-pass']).toBe(1.0);
      expect(report.results[0].scores['always-fail']).toBe(0.0);
    });
  });

  describe('runSingle', () => {
    it('scores a single case', async () => {
      const runner = createEvalRunner({ scorers: [alwaysPassScorer] });
      const result = await runner.runSingle({ id: 'c1', input: 'hi' }, 'hello');
      expect(result.caseId).toBe('c1');
      expect(result.passed).toBe(true);
      expect(result.scores['always-pass']).toBe(1.0);
    });
  });

  describe('checkGate', () => {
    it('passes when pass rate meets threshold', () => {
      const runner = createEvalRunner({
        scorers: [alwaysPassScorer],
        overallPassRate: 0.8,
      });
      const gate = runner.checkGate({
        totalCases: 10,
        passedCases: 9,
        failedCases: 1,
        passRate: 0.9,
        averageScores: {},
        results: [],
        duration: 100,
        timestamp: Date.now(),
      });
      expect(gate.passed).toBe(true);
    });

    it('fails when pass rate below threshold', () => {
      const runner = createEvalRunner({
        scorers: [alwaysPassScorer],
        overallPassRate: 0.8,
      });
      const gate = runner.checkGate({
        totalCases: 10,
        passedCases: 5,
        failedCases: 5,
        passRate: 0.5,
        averageScores: {},
        results: [],
        duration: 100,
        timestamp: Date.now(),
      });
      expect(gate.passed).toBe(false);
    });
  });
});
