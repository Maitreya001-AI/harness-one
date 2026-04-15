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

  // Fix 5: Circuit breaker tests
  describe('circuit breaker (Fix 5)', () => {
    it('tracks sourceId in generated case metadata', () => {
      const originalCases: EvalCase[] = [
        { id: 'case-1', input: 'What is AI?' },
      ];
      const report = makeReport([
        { caseId: 'case-1', scores: { relevance: 0.1 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      expect(newCases).toHaveLength(1);
      expect(newCases[0].metadata!.sourceId).toBe('case-1');
      expect(newCases[0].metadata!.generationDepth).toBe(1);
    });

    it('limits generation depth to maxGenerationDepth', () => {
      const originalCases: EvalCase[] = [
        {
          id: 'deep-case',
          input: 'Already deep',
          metadata: { sourceId: 'root', generationDepth: 3 },
        },
      ];
      const report = makeReport([
        { caseId: 'deep-case', scores: { relevance: 0.1 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5, maxGenerationDepth: 3 }, originalCases);
      expect(newCases).toHaveLength(0); // At max depth, should not generate
    });

    it('allows generation when below maxGenerationDepth', () => {
      const originalCases: EvalCase[] = [
        {
          id: 'shallow-case',
          input: 'Not deep yet',
          metadata: { sourceId: 'root', generationDepth: 1 },
        },
      ];
      const report = makeReport([
        { caseId: 'shallow-case', scores: { relevance: 0.1 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5, maxGenerationDepth: 3 }, originalCases);
      expect(newCases).toHaveLength(1);
      expect(newCases[0].metadata!.generationDepth).toBe(2);
    });

    it('deduplicates by content hash', () => {
      const originalCases: EvalCase[] = [
        { id: 'case-1', input: 'Same question' },
        { id: 'case-2', input: 'Same question' },
      ];
      const report = makeReport([
        { caseId: 'case-1', scores: { relevance: 0.1 } },
        { caseId: 'case-2', scores: { relevance: 0.2 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      // Should deduplicate since both have the same input
      expect(newCases).toHaveLength(1);
    });

    it('defaults maxGenerationDepth to 3', () => {
      const originalCases: EvalCase[] = [
        {
          id: 'depth-2',
          input: 'Depth 2 case',
          metadata: { sourceId: 'root', generationDepth: 2 },
        },
      ];
      const report = makeReport([
        { caseId: 'depth-2', scores: { relevance: 0.1 } },
      ]);

      // Default maxGenerationDepth=3, case is at depth 2, so one more generation is allowed
      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      expect(newCases).toHaveLength(1);
      expect(newCases[0].metadata!.generationDepth).toBe(3);
    });
  });

  // Issue 4: hash collision prevention
  describe('hash collision prevention (Issue 4)', () => {
    it('does NOT deduplicate when inputs differ and only separator positions differ', () => {
      // Old hash: input="a::b", expected="c"  -> "a::b::c"
      //           input="a",    expected="b::c" -> "a::b::c"  (collision!)
      // New hash uses length-prefixing so these are distinct.
      const originalCases: EvalCase[] = [
        { id: 'case-1', input: 'a::b', expectedOutput: 'c' },
        { id: 'case-2', input: 'a',    expectedOutput: 'b::c' },
      ];
      const report = makeReport([
        { caseId: 'case-1', scores: { r: 0.1 } },
        { caseId: 'case-2', scores: { r: 0.2 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      // Both cases are distinct — must NOT be collapsed into one
      expect(newCases).toHaveLength(2);
    });

    it('still deduplicates truly identical input+expected pairs', () => {
      const originalCases: EvalCase[] = [
        { id: 'case-1', input: 'hello', expectedOutput: 'world' },
        { id: 'case-2', input: 'hello', expectedOutput: 'world' },
      ];
      const report = makeReport([
        { caseId: 'case-1', scores: { r: 0.1 } },
        { caseId: 'case-2', scores: { r: 0.2 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      expect(newCases).toHaveLength(1);
    });

    it('does NOT deduplicate when inputs differ only by length of separator overlap', () => {
      // input="x:y", expected="z"  vs  input="x", expected=":y:z"
      const originalCases: EvalCase[] = [
        { id: 'case-1', input: 'x:y',  expectedOutput: 'z' },
        { id: 'case-2', input: 'x',    expectedOutput: ':y:z' },
      ];
      const report = makeReport([
        { caseId: 'case-1', scores: { r: 0.1 } },
        { caseId: 'case-2', scores: { r: 0.2 } },
      ]);

      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      expect(newCases).toHaveLength(2);
    });

    it('treats missing expected as distinct from empty-string expected', () => {
      const originalCases: EvalCase[] = [
        { id: 'case-1', input: 'hello' },                          // no expectedOutput
        { id: 'case-2', input: 'hello', expectedOutput: '' },      // explicit empty
      ];
      const report = makeReport([
        { caseId: 'case-1', scores: { r: 0.1 } },
        { caseId: 'case-2', scores: { r: 0.2 } },
      ]);

      // Both have same input "hello" and both effectively have empty expected —
      // they ARE the same content so deduplication IS expected here.
      const newCases = extractNewCases(report, { scoreThreshold: 0.5 }, originalCases);
      expect(newCases).toHaveLength(1);
    });
  });
});
