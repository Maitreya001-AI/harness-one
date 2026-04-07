/**
 * Data flywheel — extract low-scoring eval results as new test cases.
 *
 * Implements the pattern: low-score traces → new test cases → improved eval coverage.
 *
 * @module
 */

import type { EvalCase, EvalReport } from './types.js';

/** Configuration for the data flywheel. */
export interface FlywheelConfig {
  readonly scoreThreshold: number;
  readonly maxNewCases?: number;
}

/**
 * Extract low-scoring results from an eval report as new test cases.
 *
 * @param report - The eval report containing results to analyze.
 * @param config - Flywheel configuration (score threshold, max cases).
 * @param originalCases - Optional original eval cases, used to look up actual input content.
 *   When provided, the new case input will be the original case's input text.
 *   When omitted, falls back to using the caseId as input.
 *
 * @example
 * ```ts
 * const newCases = extractNewCases(report, { scoreThreshold: 0.5, maxNewCases: 10 }, originalCases);
 * ```
 */
export function extractNewCases(report: EvalReport, config: FlywheelConfig, originalCases?: EvalCase[]): EvalCase[] {
  const { scoreThreshold, maxNewCases } = config;

  // Build a lookup map from caseId to original input
  const caseInputMap = new Map<string, string>();
  if (originalCases) {
    for (const c of originalCases) {
      caseInputMap.set(c.id, c.input);
    }
  }

  const lowScoring = report.results.filter((result) => {
    const scores = Object.values(result.scores);
    if (scores.length === 0) return false;
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    return avgScore < scoreThreshold;
  });

  // Sort by average score ascending (worst first)
  lowScoring.sort((a, b) => {
    const avgA = average(Object.values(a.scores));
    const avgB = average(Object.values(b.scores));
    return avgA - avgB;
  });

  const limited = maxNewCases !== undefined ? lowScoring.slice(0, maxNewCases) : lowScoring;

  return limited.map((result, i) => ({
    id: `flywheel_${result.caseId}_${i}`,
    input: caseInputMap.get(result.caseId) ?? result.caseId,
    tags: ['flywheel', 'auto-generated'],
    metadata: {
      sourceCase: result.caseId,
      scores: result.scores,
      details: result.details,
    },
  }));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
