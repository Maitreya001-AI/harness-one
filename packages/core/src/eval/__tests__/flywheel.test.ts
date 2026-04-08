import { describe, it, expect } from 'vitest';
import { extractNewCases } from '../flywheel.js';
import type { EvalReport, EvalCase } from '../types.js';

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

  // C7: Data flywheel uses caseId as input instead of actual content
  it('uses original case input, not caseId, as the new case input', () => {
    const originalCases: EvalCase[] = [
      { id: 'case-abc', input: 'What is machine learning?' },
      { id: 'case-def', input: 'Explain quantum computing' },
    ];
    const report = makeReport([
      { caseId: 'case-abc', scores: { relevance: 0.1 } },
      { caseId: 'case-def', scores: { relevance: 0.9 } },
    ]);

    const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);

    // The new case input should be the original input text, NOT the caseId string
    expect(newCases).toHaveLength(1);
    expect(newCases[0].input).toBe('What is machine learning?');
    expect(newCases[0].input).not.toBe('case-abc');
  });

  describe('edge cases', () => {
    it('returns empty array when all cases pass (no new cases generated)', () => {
      const report = makeReport([
        { caseId: 'c1', scores: { relevance: 0.9, quality: 0.95 } },
        { caseId: 'c2', scores: { relevance: 0.85, quality: 0.9 } },
      ]);
      const cases = extractNewCases(report, { scoreThreshold: 0.5 });
      expect(cases).toHaveLength(0);
    });

    it('maxNewCases limits output to specified count', () => {
      const report = makeReport([
        { caseId: 'c1', scores: { r: 0.1 } },
        { caseId: 'c2', scores: { r: 0.15 } },
        { caseId: 'c3', scores: { r: 0.2 } },
        { caseId: 'c4', scores: { r: 0.25 } },
        { caseId: 'c5', scores: { r: 0.3 } },
      ]);
      const cases = extractNewCases(report, { scoreThreshold: 0.5, maxNewCases: 2 });
      expect(cases).toHaveLength(2);
      // Should get the worst two
      expect(cases[0].metadata!.sourceCase).toBe('c1');
      expect(cases[1].metadata!.sourceCase).toBe('c2');
    });

    it('cases are sorted by score ascending (worst first)', () => {
      const report = makeReport([
        { caseId: 'c1', scores: { r: 0.3 } },
        { caseId: 'c2', scores: { r: 0.1 } },
        { caseId: 'c3', scores: { r: 0.2 } },
      ]);
      const cases = extractNewCases(report, { scoreThreshold: 0.5 });
      expect(cases).toHaveLength(3);
      // Sorted: c2 (0.1), c3 (0.2), c1 (0.3)
      expect(cases[0].metadata!.sourceCase).toBe('c2');
      expect(cases[1].metadata!.sourceCase).toBe('c3');
      expect(cases[2].metadata!.sourceCase).toBe('c1');
    });

    it('maxNewCases=0 returns empty array', () => {
      const report = makeReport([
        { caseId: 'c1', scores: { r: 0.1 } },
      ]);
      const cases = extractNewCases(report, { scoreThreshold: 0.5, maxNewCases: 0 });
      expect(cases).toHaveLength(0);
    });

    it('report with empty results returns empty array', () => {
      const report = makeReport([]);
      const cases = extractNewCases(report, { scoreThreshold: 0.5 });
      expect(cases).toHaveLength(0);
    });
  });

  it('falls back gracefully when original cases not provided', () => {
    const report = makeReport([
      { caseId: 'case-abc', scores: { relevance: 0.1 } },
    ]);

    // When no original cases provided, input should still be caseId as fallback
    const newCases = extractNewCases(report, { scoreThreshold: 0.5 });
    expect(newCases).toHaveLength(1);
    expect(newCases[0].input).toBe('case-abc');
  });
});
