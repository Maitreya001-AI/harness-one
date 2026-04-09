/**
 * Eval runner — runs evaluation cases through scorers and produces reports.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
import type { EvalCase, EvalResult, EvalReport, EvalConfig } from './types.js';

/** Interface for running evaluations. */
export interface EvalRunner {
  run(cases: EvalCase[], generate: (input: string) => Promise<string>): Promise<EvalReport>;
  runSingle(evalCase: EvalCase, output: string): Promise<EvalResult>;
  checkGate(report: EvalReport): { passed: boolean; reason: string };
}

/**
 * Create an eval runner with the given scorers and thresholds.
 *
 * @example
 * ```ts
 * const runner = createEvalRunner({ scorers: [createRelevanceScorer()], passThreshold: 0.7 });
 * const report = await runner.run(cases, async (input) => `Answer: ${input}`);
 * ```
 */
export function createEvalRunner(config: EvalConfig): EvalRunner {
  const { scorers, passThreshold = 0.7, overallPassRate = 0.8, concurrency = 1 } = config;

  if (scorers.length === 0) {
    throw new HarnessError(
      'At least one scorer is required',
      'EVAL_CONFIG',
      'Add at least one scorer to the eval config',
    );
  }

  async function runSingle(evalCase: EvalCase, output: string): Promise<EvalResult> {
    const start = Date.now();
    const scores: Record<string, number> = {};
    const details: Record<string, string> = {};

    for (const scorer of scorers) {
      const result = await scorer.score(evalCase.input, output, evalCase.context);
      scores[scorer.name] = result.score;
      details[scorer.name] = result.explanation;
    }

    const passed = Object.values(scores).every((s) => s >= passThreshold);

    return {
      caseId: evalCase.id,
      scores,
      passed,
      details,
      duration: Date.now() - start,
    };
  }

  /** Run items with a concurrency limit using a simple promise pool. */
  async function runWithConcurrency<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    limit: number,
  ): Promise<void> {
    const executing = new Set<Promise<void>>();
    for (const item of items) {
      const p = fn(item).then(() => { executing.delete(p); });
      executing.add(p);
      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  }

  return {
    async run(cases, generate) {
      if (cases.length === 0) {
        throw new HarnessError(
          'No eval cases provided',
          'EVAL_EMPTY',
          'Provide at least one eval case',
        );
      }

      const start = Date.now();

      // Step 1: Generate outputs (with concurrency support)
      const outputs: string[] = new Array(cases.length);

      if (concurrency <= 1) {
        // Sequential execution to respect rate limits
        for (let i = 0; i < cases.length; i++) {
          outputs[i] = await generate(cases[i].input);
        }
      } else {
        // Concurrent execution
        await runWithConcurrency(
          cases.map((c, i) => ({ case: c, index: i })),
          async ({ case: evalCase, index }) => {
            outputs[index] = await generate(evalCase.input);
          },
          concurrency,
        );
      }

      // Step 2: Score results, using scoreBatch when available
      const results: EvalResult[] = [];
      const casesWithOutputs = cases.map((c, i) => ({ evalCase: c, output: outputs[i] }));

      // Check which scorers support batch scoring
      const batchScorers = scorers.filter(s => s.scoreBatch);
      const individualScorers = scorers.filter(s => !s.scoreBatch);

      // Pre-compute batch scores for scorers that support it
      const batchResults = new Map<string, Array<{ score: number; explanation: string }>>();
      for (const scorer of batchScorers) {
        const batchInput = casesWithOutputs.map(({ evalCase, output }) => ({
          input: evalCase.input,
          output,
          ...(evalCase.context !== undefined && { context: evalCase.context }),
        }));
        const batchScoreResults = await scorer.scoreBatch!(batchInput);
        batchResults.set(scorer.name, batchScoreResults);
      }

      // Build results per case
      for (let i = 0; i < cases.length; i++) {
        const caseStart = Date.now();
        const scores: Record<string, number> = {};
        const details: Record<string, string> = {};

        // Individual scorers
        for (const scorer of individualScorers) {
          const result = await scorer.score(cases[i].input, outputs[i], cases[i].context);
          scores[scorer.name] = result.score;
          details[scorer.name] = result.explanation;
        }

        // Batch scorers (use pre-computed results)
        for (const scorer of batchScorers) {
          const batchResult = batchResults.get(scorer.name)!;
          scores[scorer.name] = batchResult[i].score;
          details[scorer.name] = batchResult[i].explanation;
        }

        const passed = Object.values(scores).every((s) => s >= passThreshold);
        results.push({
          caseId: cases[i].id,
          scores,
          passed,
          details,
          duration: Date.now() - caseStart,
        });
      }

      const passedCases = results.filter((r) => r.passed).length;
      const averageScores: Record<string, number> = {};

      for (const scorer of scorers) {
        const total = results.reduce((sum, r) => sum + (r.scores[scorer.name] ?? 0), 0);
        averageScores[scorer.name] = total / results.length;
      }

      return {
        totalCases: cases.length,
        passedCases,
        failedCases: cases.length - passedCases,
        passRate: passedCases / cases.length,
        averageScores,
        results,
        duration: Date.now() - start,
        timestamp: Date.now(),
      };
    },

    runSingle,

    checkGate(report) {
      if (report.passRate >= overallPassRate) {
        return { passed: true, reason: `Pass rate ${(report.passRate * 100).toFixed(1)}% meets threshold ${(overallPassRate * 100).toFixed(1)}%` };
      }
      return {
        passed: false,
        reason: `Pass rate ${(report.passRate * 100).toFixed(1)}% below threshold ${(overallPassRate * 100).toFixed(1)}%`,
      };
    },
  };
}
