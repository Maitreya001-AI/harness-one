import { describe, it, expect } from 'vitest';
import { createEvalRunner } from '../runner.js';
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

  // H2: EvalRunner only supports sequential execution
  describe('concurrency', () => {
    it('runs cases concurrently when concurrency is set', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const runner = createEvalRunner({
        scorers: [alwaysPassScorer],
        concurrency: 3,
      });

      const cases = Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        input: `input-${i}`,
      }));

      const report = await runner.run(cases, async (input) => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise(r => setTimeout(r, 50));
        currentConcurrent--;
        return `output: ${input}`;
      });

      expect(report.totalCases).toBe(6);
      expect(report.passedCases).toBe(6);
      // With concurrency=3, at least 2 should run concurrently
      expect(maxConcurrent).toBeGreaterThan(1);
    });

    it('defaults to sequential execution when concurrency not set', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const runner = createEvalRunner({
        scorers: [alwaysPassScorer],
      });

      const cases = Array.from({ length: 3 }, (_, i) => ({
        id: `c${i}`,
        input: `input-${i}`,
      }));

      const report = await runner.run(cases, async (input) => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise(r => setTimeout(r, 10));
        currentConcurrent--;
        return `output: ${input}`;
      });

      expect(report.totalCases).toBe(3);
      expect(maxConcurrent).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles scorer that throws an error gracefully', async () => {
      const throwingScorer: Scorer = {
        name: 'throwing',
        description: 'Always throws',
        async score() {
          throw new Error('Scorer exploded');
        },
      };
      const runner = createEvalRunner({ scorers: [throwingScorer] });
      await expect(
        runner.run([{ id: 'c1', input: 'hi' }], async (i) => i),
      ).rejects.toThrow('Scorer exploded');
    });

    it('treats NaN score as 0 for pass/fail determination', async () => {
      const nanScorer: Scorer = {
        name: 'nan-scorer',
        description: 'Returns NaN score',
        async score() {
          return { score: NaN, explanation: 'NaN result' };
        },
      };
      const runner = createEvalRunner({ scorers: [nanScorer], passThreshold: 0.5 });
      const report = await runner.run(
        [{ id: 'c1', input: 'test' }],
        async (i) => i,
      );
      // NaN >= 0.5 is false, so the case should fail
      expect(report.results[0].passed).toBe(false);
      expect(report.results[0].scores['nan-scorer']).toBeNaN();
    });

    it('throws on empty cases array', async () => {
      const runner = createEvalRunner({ scorers: [alwaysPassScorer] });
      await expect(runner.run([], async (i) => i)).rejects.toThrow(HarnessError);
    });

    it('checkGate with 0% pass rate — all cases fail', () => {
      const runner = createEvalRunner({
        scorers: [alwaysPassScorer],
        overallPassRate: 0.5,
      });
      const gate = runner.checkGate({
        totalCases: 10,
        passedCases: 0,
        failedCases: 10,
        passRate: 0.0,
        averageScores: {},
        results: [],
        duration: 100,
        timestamp: Date.now(),
      });
      expect(gate.passed).toBe(false);
      expect(gate.reason).toContain('0.0%');
      expect(gate.reason).toContain('below threshold');
    });
  });

  // H3: Eval scorers don't use scoreBatch
  describe('scoreBatch', () => {
    it('uses scoreBatch when available on a scorer', async () => {
      let batchCalled = false;
      const batchScorer: Scorer = {
        name: 'batch-scorer',
        description: 'Scorer with batch support',
        async score() {
          return { score: 0.5, explanation: 'individual' };
        },
        async scoreBatch(cases) {
          batchCalled = true;
          return cases.map(() => ({ score: 0.9, explanation: 'batched' }));
        },
      };

      const runner = createEvalRunner({ scorers: [batchScorer] });
      const cases = [
        { id: 'c1', input: 'hello' },
        { id: 'c2', input: 'world' },
      ];
      const report = await runner.run(cases, async (input) => `echo: ${input}`);

      expect(batchCalled).toBe(true);
      // Batch scorer returns 0.9, individual returns 0.5
      // If scoreBatch is used, all scores should be 0.9
      expect(report.results[0].scores['batch-scorer']).toBe(0.9);
      expect(report.results[1].scores['batch-scorer']).toBe(0.9);
    });

    it('throws SCORER_MISMATCH when scoreBatch returns wrong number of results', async () => {
      const mismatchBatchScorer: Scorer = {
        name: 'mismatched-batch',
        description: 'Returns wrong count',
        async score() {
          return { score: 0.5, explanation: 'individual' };
        },
        async scoreBatch() {
          // Return 1 result for 3 cases
          return [{ score: 0.9, explanation: 'only one' }];
        },
      };

      const runner = createEvalRunner({ scorers: [mismatchBatchScorer] });
      const cases = [
        { id: 'c1', input: 'a' },
        { id: 'c2', input: 'b' },
        { id: 'c3', input: 'c' },
      ];

      await expect(
        runner.run(cases, async (i) => i),
      ).rejects.toThrow(HarnessError);

      await expect(
        runner.run(cases, async (i) => i),
      ).rejects.toThrow(/scoreBatch\(\) returned 1 results but expected 3/);
    });

    it('throws SCORER_MISMATCH when scoreBatch returns empty array', async () => {
      const emptyBatchScorer: Scorer = {
        name: 'empty-batch',
        description: 'Returns empty array',
        async score() {
          return { score: 0.5, explanation: 'individual' };
        },
        async scoreBatch() {
          return [];
        },
      };

      const runner = createEvalRunner({ scorers: [emptyBatchScorer] });
      const cases = [{ id: 'c1', input: 'a' }];

      await expect(
        runner.run(cases, async (i) => i),
      ).rejects.toThrow(HarnessError);

      await expect(
        runner.run(cases, async (i) => i),
      ).rejects.toThrow(/scoreBatch\(\) returned 0 results but expected 1/);
    });

    it('accepts scoreBatch that returns exactly matching count', async () => {
      const correctBatchScorer: Scorer = {
        name: 'correct-batch',
        description: 'Returns correct count',
        async score() {
          return { score: 0.5, explanation: 'individual' };
        },
        async scoreBatch(cases) {
          return cases.map(() => ({ score: 0.8, explanation: 'batched' }));
        },
      };

      const runner = createEvalRunner({ scorers: [correctBatchScorer] });
      const cases = [
        { id: 'c1', input: 'a' },
        { id: 'c2', input: 'b' },
      ];
      const report = await runner.run(cases, async (i) => i);
      expect(report.results[0].scores['correct-batch']).toBe(0.8);
      expect(report.results[1].scores['correct-batch']).toBe(0.8);
    });

    it('falls back to individual score when scoreBatch not available', async () => {
      const individualScorer: Scorer = {
        name: 'individual-scorer',
        description: 'Scorer without batch',
        async score() {
          return { score: 0.7, explanation: 'individual' };
        },
        // No scoreBatch method
      };

      const runner = createEvalRunner({ scorers: [individualScorer] });
      const cases = [
        { id: 'c1', input: 'hello' },
        { id: 'c2', input: 'world' },
      ];
      const report = await runner.run(cases, async (input) => `echo: ${input}`);

      expect(report.results[0].scores['individual-scorer']).toBe(0.7);
      expect(report.results[1].scores['individual-scorer']).toBe(0.7);
    });
  });
});
