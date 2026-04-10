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
  /**
   * Maximum depth of flywheel-generated case lineage.
   * Prevents runaway feedback loops by refusing to generate cases
   * from cases that are already at maxGenerationDepth.
   * Defaults to 3.
   */
  readonly maxGenerationDepth?: number;
}

/**
 * Extract low-scoring results from an eval report as new test cases.
 *
 * Circuit breaker mechanisms:
 * - **Lineage tracking**: Each flywheel-generated case carries a `sourceId`
 *   and `generationDepth` in its metadata. Cases at maxGenerationDepth are
 *   not used to generate further cases.
 * - **Content deduplication**: Cases are deduplicated by content hash
 *   (input + expected output). Duplicate content is silently skipped.
 * - **Depth limiting**: Defaults to maxGenerationDepth=3 to prevent
 *   unbounded recursive case generation.
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
  const { scoreThreshold, maxNewCases, maxGenerationDepth = 3 } = config;

  // Build a lookup map from caseId to original case
  const caseMap = new Map<string, EvalCase>();
  if (originalCases) {
    for (const c of originalCases) {
      caseMap.set(c.id, c);
    }
  }

  const lowScoring = report.results.filter((result) => {
    const scores = Object.values(result.scores);
    if (scores.length === 0) return false;
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    if (avgScore >= scoreThreshold) return false;

    // Fix 5: Circuit breaker - check lineage depth
    const originalCase = caseMap.get(result.caseId);
    if (originalCase?.metadata) {
      const depth = typeof originalCase.metadata.generationDepth === 'number'
        ? originalCase.metadata.generationDepth
        : 0;
      if (depth >= maxGenerationDepth) return false;
    }

    return true;
  });

  // Sort by average score ascending (worst first)
  lowScoring.sort((a, b) => {
    const avgA = average(Object.values(a.scores));
    const avgB = average(Object.values(b.scores));
    return avgA - avgB;
  });

  const limited = maxNewCases !== undefined ? lowScoring.slice(0, maxNewCases) : lowScoring;

  // Fix 5: Content deduplication by hash (input+expected)
  const seenContentHashes = new Set<string>();

  const newCases: EvalCase[] = [];
  for (let i = 0; i < limited.length; i++) {
    const result = limited[i];
    const originalCase = caseMap.get(result.caseId);
    const inputText = originalCase?.input ?? result.caseId;

    // Fix 5: Deduplicate by content hash
    const contentHash = hashContent(inputText, originalCase?.expectedOutput);
    if (seenContentHashes.has(contentHash)) continue;
    seenContentHashes.add(contentHash);

    // Fix 5: Track lineage
    const parentDepth = originalCase?.metadata && typeof originalCase.metadata.generationDepth === 'number'
      ? originalCase.metadata.generationDepth
      : 0;
    const sourceId = originalCase?.metadata?.sourceId ?? result.caseId;

    newCases.push({
      id: `flywheel_${result.caseId}_${i}`,
      input: inputText,
      tags: ['flywheel', 'auto-generated'],
      metadata: {
        sourceCase: result.caseId,
        sourceId: sourceId as string,
        generationDepth: parentDepth + 1,
        scores: result.scores,
        details: result.details,
      },
    });
  }

  return newCases;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Simple content hash for deduplication. */
function hashContent(input: string, expected?: string): string {
  return `${input}::${expected ?? ''}`;
}
