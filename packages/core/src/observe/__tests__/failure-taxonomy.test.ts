import { describe, it, expect } from 'vitest';
import { createFailureTaxonomy } from '../failure-taxonomy.js';
import type { Trace, Span } from '../types.js';
import { HarnessErrorCode } from '../../core/errors.js';

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
    userMetadata: {},
    systemMetadata: {},
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
    it('prefers harness.error.code over string heuristics', () => {
      const trace = makeTrace({
        status: 'error',
        spans: [
          makeSpan({ id: 's0', name: 'work' }),
          makeSpan({
            id: 's1',
            name: 'finalize',
            status: 'error',
            attributes: {
              'harness.error.code': HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
            },
          }),
        ],
      });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'budget_exceeded');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.95);
      expect(result!.details).toEqual({
        source: 'error_code',
        code: HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
      });
    });

    it('falls back to a low-confidence string heuristic', () => {
      const trace = makeTrace({
        status: 'error',
        spans: [
          makeSpan({
            id: 's1',
            name: 'budget_check_validator',
            status: 'error',
            attributes: { note: 'contains budget text only' },
          }),
        ],
      });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'budget_exceeded');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.5);
      expect(result!.details).toEqual({
        source: 'heuristic_string_match',
        match: 'budget',
      });
    });

    it('returns null when neither the error code nor heuristic matches', () => {
      const trace = makeTrace({
        status: 'error',
        spans: [
          makeSpan({
            id: 's1',
            name: 'finalize',
            status: 'error',
            attributes: { reason: 'generic failure' },
          }),
        ],
      });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      expect(results.find((r) => r.mode === 'budget_exceeded')).toBeUndefined();
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

  describe('repeated_tool_failure detector', () => {
    it('detects >=2 tool-related spans with error status', () => {
      const spans = Array.from({ length: 3 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: `tool_call_${i}`, status: 'error' }),
      );
      const trace = makeTrace({ spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'repeated_tool_failure');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.8); // 0.5 + 3*0.1 = 0.8
    });
  });

  describe('adapter_retry_storm detector', () => {
    it('detects ≥3 error spans carrying retryable harness.error.code', () => {
      const codes = [
        HarnessErrorCode.ADAPTER_RATE_LIMIT,
        HarnessErrorCode.ADAPTER_NETWORK,
        HarnessErrorCode.ADAPTER_RATE_LIMIT,
      ];
      const spans = codes.map((code, i) =>
        makeSpan({
          id: `s${i}`,
          name: 'adapter.embed',
          status: 'error',
          attributes: { 'harness.error.code': code },
        }),
      );
      const trace = makeTrace({ status: 'error', spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'adapter_retry_storm');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.6); // 3 errors = minErrors = base
      expect(result!.details).toMatchObject({
        source: 'error_code',
        retryableErrorCount: 3,
      });
    });

    it('does not trigger when error codes are non-retryable', () => {
      const spans = [
        makeSpan({
          id: 's0',
          name: 'adapter.embed',
          status: 'error',
          attributes: { 'harness.error.code': HarnessErrorCode.ADAPTER_AUTH },
        }),
        makeSpan({
          id: 's1',
          name: 'adapter.embed',
          status: 'error',
          attributes: { 'harness.error.code': HarnessErrorCode.ADAPTER_AUTH },
        }),
        makeSpan({
          id: 's2',
          name: 'adapter.embed',
          status: 'error',
          attributes: { 'harness.error.code': HarnessErrorCode.ADAPTER_AUTH },
        }),
      ];
      const trace = makeTrace({ status: 'error', spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      expect(results.find((r) => r.mode === 'adapter_retry_storm')).toBeUndefined();
    });

    it('respects adapterRetryStormMinErrors threshold override', () => {
      const spans = Array.from({ length: 4 }, (_, i) =>
        makeSpan({
          id: `s${i}`,
          name: 'adapter.call',
          status: 'error',
          attributes: { 'harness.error.code': HarnessErrorCode.ADAPTER_RATE_LIMIT },
        }),
      );
      const trace = makeTrace({ status: 'error', spans });
      // Raise threshold so 4 errors no longer trigger.
      const taxonomy = createFailureTaxonomy({
        thresholds: { adapterRetryStormMinErrors: 5 },
      });
      const results = taxonomy.classify(trace);
      expect(results.find((r) => r.mode === 'adapter_retry_storm')).toBeUndefined();
    });

    it('caps confidence at 0.9 regardless of error count', () => {
      const spans = Array.from({ length: 20 }, (_, i) =>
        makeSpan({
          id: `s${i}`,
          name: 'adapter.call',
          status: 'error',
          attributes: { 'harness.error.code': HarnessErrorCode.ADAPTER_RATE_LIMIT },
        }),
      );
      const trace = makeTrace({ status: 'error', spans });
      const taxonomy = createFailureTaxonomy();
      const results = taxonomy.classify(trace);
      const result = results.find((r) => r.mode === 'adapter_retry_storm');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeLessThanOrEqual(0.9);
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

  // Fix 7: Confidence calibration documentation — verify comments exist
  // (These are JSDoc-level fixes; we verify the confidence values are still the expected heuristic values)
  describe('confidence calibration', () => {
    it('tool_loop confidence follows documented formula: 0.5 + (run-3)*0.1, max 0.95', () => {
      const taxonomy = createFailureTaxonomy();
      // 5 consecutive spans => confidence = 0.5 + (5-3)*0.1 = 0.7
      const spans = Array.from({ length: 5 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: 'callTool' }),
      );
      const trace = makeTrace({ spans });
      const results = taxonomy.classify(trace);
      const loopResult = results.find(r => r.mode === 'tool_loop');
      expect(loopResult!.confidence).toBeCloseTo(0.7);
    });

    it('early_stop confidence is 0.6', () => {
      const taxonomy = createFailureTaxonomy();
      const trace = makeTrace({
        startTime: 0, endTime: 2000, status: 'completed',
        spans: [makeSpan({ id: 's0' })],
      });
      const results = taxonomy.classify(trace);
      expect(results.find(r => r.mode === 'early_stop')!.confidence).toBeCloseTo(0.6);
    });

    it('budget_exceeded structured confidence defaults to 0.95', () => {
      const taxonomy = createFailureTaxonomy();
      const trace = makeTrace({
        status: 'error',
        spans: [
          makeSpan({
            id: 's1',
            name: 'budget_check',
            status: 'error',
            attributes: {
              'harness.error.code': HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
            },
          }),
        ],
      });
      const results = taxonomy.classify(trace);
      expect(results.find(r => r.mode === 'budget_exceeded')!.confidence).toBeCloseTo(0.95);
    });

    it('timeout confidence is 0.8', () => {
      const taxonomy = createFailureTaxonomy();
      const trace = makeTrace({
        startTime: 0, endTime: 130_000,
        spans: [makeSpan({ id: 's1', name: 'long', startTime: 0, endTime: undefined, status: 'running' })],
      });
      const results = taxonomy.classify(trace);
      expect(results.find(r => r.mode === 'timeout')!.confidence).toBeCloseTo(0.8);
    });

    it('repeated_tool_failure confidence follows formula: 0.5 + count*0.1, max 0.8', () => {
      const taxonomy = createFailureTaxonomy();
      const spans = Array.from({ length: 4 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: `tool_call_${i}`, status: 'error' }),
      );
      const trace = makeTrace({ spans });
      const results = taxonomy.classify(trace);
      // 4 errors => 0.5 + 4*0.1 = 0.9, capped at 0.8
      expect(results.find(r => r.mode === 'repeated_tool_failure')!.confidence).toBeCloseTo(0.8);
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

  // FIX 4: Configurable thresholds
  describe('configurable thresholds', () => {
    it('toolLoopMinRun overrides default minimum run length', () => {
      // Default minRun=3, override to 5
      const taxonomy = createFailureTaxonomy({ thresholds: { toolLoopMinRun: 5 } });
      // 4 consecutive spans: should NOT trigger with minRun=5
      const spans4 = Array.from({ length: 4 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: 'callTool' }),
      );
      const trace4 = makeTrace({ spans: spans4 });
      const results4 = taxonomy.classify(trace4);
      expect(results4.find(r => r.mode === 'tool_loop')).toBeUndefined();

      // 5 consecutive spans: should trigger with minRun=5
      const spans5 = Array.from({ length: 5 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: 'callTool' }),
      );
      const trace5 = makeTrace({ spans: spans5 });
      const results5 = taxonomy.classify(trace5);
      const loop = results5.find(r => r.mode === 'tool_loop');
      expect(loop).toBeDefined();
      // confidence: 0.5 + (5-5)*0.1 = 0.5
      expect(loop!.confidence).toBeCloseTo(0.5);
    });

    it('earlyStopMaxSpans overrides default max span count', () => {
      // Default maxSpans=2, override to allow up to 4 spans
      const taxonomy = createFailureTaxonomy({ thresholds: { earlyStopMaxSpans: 4 } });
      // 3 spans with short duration: should now trigger with maxSpans=4
      const trace = makeTrace({
        startTime: 0, endTime: 2000, status: 'completed',
        spans: [
          makeSpan({ id: 's0' }),
          makeSpan({ id: 's1' }),
          makeSpan({ id: 's2' }),
        ],
      });
      const results = taxonomy.classify(trace);
      expect(results.find(r => r.mode === 'early_stop')).toBeDefined();
    });

    it('budgetExceededConfidence overrides default confidence', () => {
      const taxonomy = createFailureTaxonomy({ thresholds: { budgetExceededConfidence: 0.7 } });
      const trace = makeTrace({
        status: 'error',
        spans: [
          makeSpan({
            id: 's1',
            name: 'budget_check',
            status: 'error',
            attributes: {
              'harness.error.code': HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
            },
          }),
        ],
      });
      const results = taxonomy.classify(trace);
      const result = results.find(r => r.mode === 'budget_exceeded');
      expect(result).toBeDefined();
      expect(result!.confidence).toBeCloseTo(0.7);
    });

    it('uses default thresholds when none provided', () => {
      const taxonomy = createFailureTaxonomy();
      // Default behavior: 3 consecutive spans triggers tool_loop
      const spans = Array.from({ length: 3 }, (_, i) =>
        makeSpan({ id: `s${i}`, name: 'callTool' }),
      );
      const trace = makeTrace({ spans });
      const results = taxonomy.classify(trace);
      expect(results.find(r => r.mode === 'tool_loop')).toBeDefined();
    });
  });
});
