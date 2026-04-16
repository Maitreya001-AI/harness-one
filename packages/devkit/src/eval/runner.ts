/**
 * Eval runner — runs evaluation cases through scorers and produces reports.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from 'harness-one';
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

  // Fix 2: Extract per-scorer thresholds from gate config
  const scorerThresholds = config.scorerThresholds;

  if (scorers.length === 0) {
    throw new HarnessError(
      'At least one scorer is required',
      HarnessErrorCode.EVAL_CONFIG,
      'Add at least one scorer to the eval config',
    );
  }

  async function runSingle(evalCase: EvalCase, output: string): Promise<EvalResult> {
    const start = Date.now();
    const scores: Record<string, number> = {};
    const details: Record<string, string> = {};

    // Fix 1: Wrap each scorer in try-catch
    for (const scorer of scorers) {
      try {
        const result = await scorer.score(evalCase.input, output, evalCase.context);
        scores[scorer.name] = result.score;
        details[scorer.name] = result.explanation;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        scores[scorer.name] = 0;
        details[scorer.name] = `Scorer error: ${message}`;
      }
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
          HarnessErrorCode.EVAL_EMPTY,
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
      // Fix 1: Track scorer errors across the batch
      const scorerErrors: Array<{ scorer: string; error: string }> = [];
      const results: EvalResult[] = [];
      const casesWithOutputs = cases.map((c, i) => ({ evalCase: c, output: outputs[i] }));

      // Fix 7: Process scorers in registration order
      // Instead of splitting batch/individual, process all in registration order
      // Pre-compute batch results for scorers that support it
      const batchResults = new Map<string, Array<{ score: number; explanation: string }>>();

      // CQ-021: Removed the single-item probe that doubled the cost of the
      // first case. The post-batch length check below is sufficient to catch
      // scorers that return the wrong number of results.
      const batchScorers = scorers.filter(s => s.scoreBatch);
      for (const scorer of batchScorers) {
        try {
          const batchInput = casesWithOutputs.map(({ evalCase, output }) => ({
            input: evalCase.input,
            output,
            ...(evalCase.context !== undefined && { context: evalCase.context }),
          }));
          const batchScoreResults = await (scorer.scoreBatch as NonNullable<typeof scorer.scoreBatch>)(batchInput);

          // Validate batch results (single post-batch check; trusted from CQ-021)
          if (batchScoreResults.length !== cases.length) {
            throw new HarnessError(
              `Scorer "${scorer.name}" scoreBatch() returned ${batchScoreResults.length} results but expected ${cases.length}`,
              HarnessErrorCode.EVAL_SCORER_MISMATCH,
              'Ensure scoreBatch() returns exactly one result per case',
            );
          }
          batchResults.set(scorer.name, batchScoreResults);
        } catch (err: unknown) {
          // Fix 1: Catch batch scorer errors
          if (err instanceof HarnessError && err.code === HarnessErrorCode.EVAL_SCORER_MISMATCH) {
            throw err; // Re-throw mismatch errors
          }
          const message = err instanceof Error ? err.message : String(err);
          scorerErrors.push({ scorer: scorer.name, error: message });
          // Fill with NaN scores so callers can distinguish scorer failure from
          // a genuine zero score. `explanation` carries the error context.
          batchResults.set(scorer.name, cases.map(() => ({
            score: NaN,
            explanation: `Scorer error: ${message}`,
          })));
        }
      }

      // Build results per case — Fix 7: process in registration order
      for (let i = 0; i < cases.length; i++) {
        const caseStart = Date.now();
        const scores: Record<string, number> = {};
        const details: Record<string, string> = {};

        // Process all scorers in registration order
        for (const scorer of scorers) {
          if (scorer.scoreBatch && batchResults.has(scorer.name)) {
            // Use pre-computed batch results
            const batchResult = batchResults.get(scorer.name) as Array<{ score: number; explanation: string }>;
            scores[scorer.name] = batchResult[i].score;
            details[scorer.name] = batchResult[i].explanation;
          } else {
            // Individual scorer — Fix 1: wrap in try-catch
            try {
              const result = await scorer.score(cases[i].input, outputs[i], cases[i].context);
              scores[scorer.name] = result.score;
              details[scorer.name] = result.explanation;
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              scores[scorer.name] = 0;
              details[scorer.name] = `Scorer error: ${message}`;
              scorerErrors.push({ scorer: scorer.name, error: message });
            }
          }
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
        // Fix 1: Include errors field summarizing scorer failures
        ...(scorerErrors.length > 0 && { errors: scorerErrors }),
      };
    },

    runSingle,

    // Fix 2: Enhanced checkGate with per-scorer thresholds
    checkGate(report) {
      // Check overall pass rate
      if (report.passRate < overallPassRate) {
        return {
          passed: false,
          reason: `Pass rate ${(report.passRate * 100).toFixed(1)}% below threshold ${(overallPassRate * 100).toFixed(1)}%`,
        };
      }

      // Fix 2: Check per-scorer thresholds
      if (scorerThresholds) {
        for (const [scorerName, threshold] of Object.entries(scorerThresholds)) {
          const avgScore = report.averageScores[scorerName];
          if (avgScore !== undefined && avgScore < threshold) {
            return {
              passed: false,
              reason: `Scorer "${scorerName}" average ${avgScore.toFixed(3)} below threshold ${threshold}`,
            };
          }
        }
      }

      return { passed: true, reason: `Pass rate ${(report.passRate * 100).toFixed(1)}% meets threshold ${(overallPassRate * 100).toFixed(1)}%` };
    },
  };
}
