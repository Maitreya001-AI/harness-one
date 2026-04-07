import { describe, it, expect } from 'vitest';
import { extractNewCases } from '../flywheel.js';
import type { EvalReport } from '../types.js';

function makeReport(results: Array<{ caseId: string; scores: Record<string, number> }>): EvalReport {
  return {
    totalCases: results.length,
    passedCases: 0,
    failedCases: results.length,
    passRate: 0,
    averageScores: {},
    results: results.map((r) => ({
      caseId: r.caseId,
      scores: r.scores,
      passed: false,
      details: {},
      duration: 10,
    })),
    duration: 100,
    timestamp: Date.now(),
  };
}

describe('extractNewCases', () => {
  it('extracts cases below score threshold', () => {
    const report = makeReport([
      { caseId: 'c1', scores: { relevance: 0.9 } },
      { caseId: 'c2', scores: { relevance: 0.3 } },
      { caseId: 'c3', scores: { relevance: 0.2 } },
    ]);

    const cases = extractNewCases(report, { scoreThreshold: 0.5 });
    expect(cases).toHaveLength(2);
    expect(cases[0].metadata!.sourceCase).toBe('c3');
    expect(cases[1].metadata!.sourceCase).toBe('c2');
  });

  it('respects maxNewCases', () => {
    const report = makeReport([
      { caseId: 'c1', scores: { r: 0.1 } },
      { caseId: 'c2', scores: { r: 0.2 } },
      { caseId: 'c3', scores: { r: 0.3 } },
    ]);

    const cases = extractNewCases(report, { scoreThreshold: 0.5, maxNewCases: 1 });
    expect(cases).toHaveLength(1);
  });

  it('returns empty array when all scores above threshold', () => {
    const report = makeReport([
      { caseId: 'c1', scores: { r: 0.9 } },
      { caseId: 'c2', scores: { r: 0.8 } },
    ]);

    const cases = extractNewCases(report, { scoreThreshold: 0.5 });
    expect(cases).toHaveLength(0);
  });

  it('adds flywheel tags to new cases', () => {
    const report = makeReport([{ caseId: 'c1', scores: { r: 0.1 } }]);
    const cases = extractNewCases(report, { scoreThreshold: 0.5 });
    expect(cases[0].tags).toContain('flywheel');
    expect(cases[0].tags).toContain('auto-generated');
  });

  it('uses average score when multiple scorers', () => {
    const report = makeReport([
      { caseId: 'c1', scores: { a: 0.8, b: 0.2 } }, // avg 0.5
      { caseId: 'c2', scores: { a: 0.3, b: 0.1 } }, // avg 0.2
    ]);

    const cases = extractNewCases(report, { scoreThreshold: 0.4 });
    expect(cases).toHaveLength(1);
    expect(cases[0].metadata!.sourceCase).toBe('c2');
  });
});
