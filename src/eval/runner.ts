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
  const { scorers, passThreshold = 0.7, overallPassRate = 0.8 } = config;

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
      const results: EvalResult[] = [];

      // Run sequentially to respect rate limits
      for (const evalCase of cases) {
        const output = await generate(evalCase.input);
        const result = await runSingle(evalCase, output);
        results.push(result);
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
