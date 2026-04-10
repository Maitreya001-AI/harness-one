import { describe, it, expect } from 'vitest';
import { createFailureTaxonomy } from '../failure-taxonomy.js';
import type { Trace, Span } from '../types.js';

function makeSpan(overrides: Partial<Span>): Span {
  return {
    id: 's1',
    traceId: 't1',
    name: 'span',
    startTime: 0,
    endTime: 100,
    attributes: {},
    events: [],
    status: 'completed',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace>): Trace {
  return {
    id: 't1',
    name: 'test',
    startTime: 0,
    endTime: 1000,
    metadata: {},
    spans: [],
    status: 'completed',
    ...overrides,
  };
}

describe('createFailureTaxonomy', () => {
  describe('tool_loop detector', () => {
    it('detects 4 consecutive spans with same name', () => {
      const spans = Array.from({ length: 4 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: 'callTool', startTime: i * 10, endTime: i * 10 + 5 }),
      );
      const trace = makeTrace({ spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const loopResult = results.find((r) => r.mode === 'tool_loop');
      expect(loopResult).toBeDefined();
      expect(loopResult!.confidence).toBeCloseTo(0.6); // 0.5 + (4-3)*0.1
    });

    it('does not detect with only 2 consecutive spans', () => {
      const spans = [
        makeSpan({ id: 's0', name: 'callTool', startTime: 0 }),
        makeSpan({ id: 's1', name: 'callTool', startTime: 10 }),
      ];
      const trace = makeTrace({ spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      expect(results.find((r) => r.mode === 'tool_loop')).toBeUndefined();
    });
  });

  describe('early_stop detector', () => {
    it('detects completed trace with <=2 spans and <5s duration', () => {
      const trace = makeTrace({
        startTime: 0,
        endTime: 2000,
        status: 'completed',
        spans: [makeSpan({ id: 's0' })],
      });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'early_stop');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.6);
    });
  });

  describe('budget_exceeded detector', () => {
    it('detects error trace with budget-related last span', () => {
      const trace = makeTrace({
        status: 'error',
        spans: [
          makeSpan({ id: 's0', name: 'work' }),
          makeSpan({ id: 's1', name: 'budget_check', status: 'error', attributes: { budget: true } }),
        ],
      });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'budget_exceeded');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.9);
    });
  });

  describe('timeout detector', () => {
    it('detects trace >120s with last span still running', () => {
      const trace = makeTrace({
        startTime: 0,
        endTime: 130_000,
        spans: [
          makeSpan({ id: 's0', name: 'work', startTime: 0, endTime: 1000 }),
          makeSpan({ id: 's1', name: 'long-op', startTime: 1000, endTime: undefined, status: 'running' }),
        ],
      });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'timeout');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.8);
    });
  });

  describe('hallucination detector', () => {
    it('detects >=2 tool-related spans with error status', () => {
      const spans = Array.from({ length: 3 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: `tool_call_${i}`, status: 'error' }),
      );
      const trace = makeTrace({ spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'hallucination');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.8); // 0.5 + 3*0.1 = 0.8
    });
  });

  describe('custom detector', () => {
    it('registers and uses a custom detector', () => {
      const taxonomy = createFailureTaxonomy();
      taxonomy.registerDetector('custom_fail', {
        detect: () => ({ confidence: 0.95, evidence: 'custom evidence' }),
      });
      const trace = makeTrace({});
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'custom_fail');
      expect(result).toBeDefined();
      expect(result!.confidence).toBe(0.95);
      expect(result!.evidence).toBe('custom evidence');
    });
  });

  describe('minConfidence filtering', () => {
    it('filters results below minConfidence', () => {
      const taxonomy = createFailureTaxonomy({ minConfidence: 0.7 });
      // early_stop has confidence 0.6, should be filtered
      const trace = makeTrace({
        startTime: 0,
        endTime: 2000,
        status: 'completed',
        spans: [makeSpan({ id: 's0' })],
      });
      const results = taxonomy.classify(trace);
      expect(results.find((r) => r.mode === 'early_stop')).toBeUndefined();
    });
  });

  describe('getStats and reset', () => {
    it('accumulates stats across classify calls', () => {
      const taxonomy = createFailureTaxonomy();
      const trace = makeTrace({
        startTime: 0,
        endTime: 2000,
        status: 'completed',
        spans: [makeSpan({ id: 's0' })],
      });
      taxonomy.classify(trace);
      taxonomy.classify(trace);
      const stats = taxonomy.getStats();
      expect(stats['early_stop']).toBe(2);
    });

    it('reset clears stats', () => {
      const taxonomy = createFailureTaxonomy();
      const trace = makeTrace({
        startTime: 0,
        endTime: 2000,
        status: 'completed',
        spans: [makeSpan({ id: 's0' })],
      });
      taxonomy.classify(trace);
      taxonomy.reset();
      const stats = taxonomy.getStats();
      expect(stats['early_stop']).toBeUndefined();
    });
  });

  it('returns results sorted by confidence descending', () => {
    const taxonomy = createFailureTaxonomy();
    taxonomy.registerDetector('low', {
      detect: () => ({ confidence: 0.5, evidence: 'low' }),
    });
    taxonomy.registerDetector('high', {
      detect: () => ({ confidence: 0.9, evidence: 'high' }),
    });
    const trace = makeTrace({});
    const results = taxonomy.classify(trace);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });
});
