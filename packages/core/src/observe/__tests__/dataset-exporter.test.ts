import { describe, it, expect } from 'vitest';
import { createDatasetExporter } from '../dataset-exporter.js';
import type { Trace, Span } from '../types.js';
import type { DatasetEntry } from '../dataset-exporter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    id: 's1',
    traceId: 't1',
    name: 'llm-call',
    startTime: 1000,
    endTime: 1200,
    attributes: {},
    events: [],
    status: 'completed',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: 't1',
    name: 'test-trace',
    startTime: 0,
    endTime: 2000,
    metadata: {},
    spans: [],
    status: 'completed',
    ...overrides,
  };
}

/**
 * Build a span that looks like an LLM call with input messages and output.
 */
function makeLlmSpan(overrides: Partial<Span> = {}): Span {
  return makeSpan({
    name: 'llm-call',
    attributes: {
      'llm.model': 'gpt-4',
      'llm.input_messages': [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      'llm.output_message': { role: 'assistant', content: 'Hi there!' },
      'llm.token_usage': { inputTokens: 10, outputTokens: 5 },
      'llm.cost': 0.001,
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDatasetExporter', () => {
  // -------------------------------------------------------------------------
  // exportToEntries
  // -------------------------------------------------------------------------
  describe('exportToEntries', () => {
    it('returns an empty array when given no traces', () => {
      const exporter = createDatasetExporter();
      const entries = exporter.exportToEntries([]);
      expect(entries).toEqual([]);
    });

    it('returns an empty array when trace has no spans', () => {
      const exporter = createDatasetExporter();
      const entries = exporter.exportToEntries([makeTrace()]);
      expect(entries).toEqual([]);
    });

    it('skips spans that are not LLM calls (no llm.input_messages)', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({ name: 'internal-processing', attributes: {} });
      const trace = makeTrace({ spans: [span] });
      const entries = exporter.exportToEntries([trace]);
      expect(entries).toEqual([]);
    });

    it('converts an LLM span into a DatasetEntry', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({ id: 's1', traceId: 't1', startTime: 1000, endTime: 1200 });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.messages).toEqual([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ]);
      expect(entry.output).toEqual({ role: 'assistant', content: 'Hi there!' });
      expect(entry.metadata.traceId).toBe('t1');
      expect(entry.metadata.spanId).toBe('s1');
      expect(entry.metadata.model).toBe('gpt-4');
      expect(entry.metadata.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(entry.metadata.cost).toBe(0.001);
      expect(entry.metadata.latencyMs).toBe(200);
    });

    it('handles multiple LLM spans across multiple traces', () => {
      const exporter = createDatasetExporter();
      const span1 = makeLlmSpan({ id: 's1', traceId: 't1' });
      const span2 = makeLlmSpan({ id: 's2', traceId: 't2' });
      const trace1 = makeTrace({ id: 't1', spans: [span1] });
      const trace2 = makeTrace({ id: 't2', spans: [span2] });
      const entries = exporter.exportToEntries([trace1, trace2]);
      expect(entries).toHaveLength(2);
      expect(entries[0].metadata.traceId).toBe('t1');
      expect(entries[1].metadata.traceId).toBe('t2');
    });

    it('mixes LLM and non-LLM spans, only exporting LLM spans', () => {
      const exporter = createDatasetExporter();
      const llmSpan = makeLlmSpan({ id: 's1', traceId: 't1' });
      const nonLlmSpan = makeSpan({ id: 's2', traceId: 't1', name: 'tool-execution', attributes: { foo: 'bar' } });
      const trace = makeTrace({ id: 't1', spans: [llmSpan, nonLlmSpan] });
      const entries = exporter.exportToEntries([trace]);
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata.spanId).toBe('s1');
    });

    it('includes tool calls when includeToolCalls is true', () => {
      const exporter = createDatasetExporter({ includeToolCalls: true });
      const span = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          'llm.model': 'gpt-4',
          'llm.input_messages': [{ role: 'user', content: 'What is the weather?' }],
          'llm.output_message': {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'getWeather', arguments: '{"city":"NYC"}' }],
          },
          'llm.token_usage': { inputTokens: 15, outputTokens: 10 },
        },
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].output.toolCalls).toEqual([
        { name: 'getWeather', arguments: '{"city":"NYC"}' },
      ]);
    });

    it('excludes tool calls when includeToolCalls is false', () => {
      const exporter = createDatasetExporter({ includeToolCalls: false });
      const span = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          'llm.model': 'gpt-4',
          'llm.input_messages': [{ role: 'user', content: 'What is the weather?' }],
          'llm.output_message': {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'getWeather', arguments: '{"city":"NYC"}' }],
          },
          'llm.token_usage': { inputTokens: 15, outputTokens: 10 },
        },
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].output.toolCalls).toBeUndefined();
    });

    it('excludes tool calls by default (includeToolCalls not set)', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          'llm.model': 'gpt-4',
          'llm.input_messages': [{ role: 'user', content: 'What is the weather?' }],
          'llm.output_message': {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'getWeather', arguments: '{"city":"NYC"}' }],
          },
          'llm.token_usage': { inputTokens: 15, outputTokens: 10 },
        },
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].output.toolCalls).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------
  describe('filtering', () => {
    it('filters by model name', () => {
      const exporter = createDatasetExporter({ model: 'claude-3' });
      const gpt4Span = makeLlmSpan({ id: 's1', traceId: 't1' }); // model = gpt-4
      const claudeSpan = makeLlmSpan({
        id: 's2',
        traceId: 't1',
        attributes: {
          'llm.model': 'claude-3',
          'llm.input_messages': [{ role: 'user', content: 'Hi' }],
          'llm.output_message': { role: 'assistant', content: 'Hello' },
        },
      });
      const trace = makeTrace({ id: 't1', spans: [gpt4Span, claudeSpan] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].metadata.model).toBe('claude-3');
    });

    it('filters by minimum quality score', () => {
      const exporter = createDatasetExporter({ minQuality: 0.8 });
      const highQualitySpan = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          ...makeLlmSpan().attributes,
          'llm.quality_score': 0.9,
        },
      });
      const lowQualitySpan = makeLlmSpan({
        id: 's2',
        traceId: 't1',
        attributes: {
          ...makeLlmSpan().attributes,
          'llm.quality_score': 0.5,
        },
      });
      const trace = makeTrace({ id: 't1', spans: [highQualitySpan, lowQualitySpan] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].metadata.spanId).toBe('s1');
    });

    it('includes spans without quality score when minQuality is set', () => {
      const exporter = createDatasetExporter({ minQuality: 0.8 });
      const spanWithoutScore = makeLlmSpan({ id: 's1', traceId: 't1' }); // no quality_score attribute
      const trace = makeTrace({ id: 't1', spans: [spanWithoutScore] });
      const entries = exporter.exportToEntries([trace]);

      // Spans without a quality score should be included (we can't judge them)
      expect(entries).toHaveLength(1);
    });

    it('skips error spans', () => {
      const exporter = createDatasetExporter();
      const errorSpan = makeLlmSpan({ id: 's1', traceId: 't1', status: 'error' });
      const okSpan = makeLlmSpan({ id: 's2', traceId: 't1' });
      const trace = makeTrace({ id: 't1', spans: [errorSpan, okSpan] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].metadata.spanId).toBe('s2');
    });

    it('skips running (incomplete) spans', () => {
      const exporter = createDatasetExporter();
      const runningSpan = makeLlmSpan({ id: 's1', traceId: 't1', status: 'running', endTime: undefined });
      const trace = makeTrace({ id: 't1', spans: [runningSpan] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // exportToJsonl
  // -------------------------------------------------------------------------
  describe('exportToJsonl', () => {
    it('returns an empty string for no traces', () => {
      const exporter = createDatasetExporter();
      const jsonl = exporter.exportToJsonl([]);
      expect(jsonl).toBe('');
    });

    it('produces valid JSONL (one JSON object per line)', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({ id: 's1', traceId: 't1' });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const jsonl = exporter.exportToJsonl([trace]);

      const lines = jsonl.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);

      // Each line should be valid JSON
      const parsed = JSON.parse(lines[0]) as DatasetEntry;
      expect(parsed.messages).toBeDefined();
      expect(parsed.output).toBeDefined();
      expect(parsed.metadata).toBeDefined();
    });

    it('produces multiple lines for multiple LLM spans', () => {
      const exporter = createDatasetExporter();
      const span1 = makeLlmSpan({ id: 's1', traceId: 't1' });
      const span2 = makeLlmSpan({ id: 's2', traceId: 't1' });
      const trace = makeTrace({ id: 't1', spans: [span1, span2] });
      const jsonl = exporter.exportToJsonl([trace]);

      const lines = jsonl.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);

      // Verify each line is individually parseable
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('JSONL output matches exportToEntries output', () => {
      const exporter = createDatasetExporter({ includeToolCalls: true });
      const span = makeLlmSpan({ id: 's1', traceId: 't1' });
      const trace = makeTrace({ id: 't1', spans: [span] });

      const entries = exporter.exportToEntries([trace]);
      const jsonl = exporter.exportToJsonl([trace]);
      const lines = jsonl.split('\n').filter((l) => l.length > 0);
      const parsedEntries = lines.map((l) => JSON.parse(l) as DatasetEntry);

      expect(parsedEntries).toEqual(entries);
    });

    it('does not contain newlines within a single JSON line', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          'llm.model': 'gpt-4',
          'llm.input_messages': [{ role: 'user', content: 'Hello\nWorld\nMultiline' }],
          'llm.output_message': { role: 'assistant', content: 'Response\nwith\nnewlines' },
        },
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const jsonl = exporter.exportToJsonl([trace]);

      const lines = jsonl.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      // The JSON.stringify should escape newlines within strings
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Metadata extraction
  // -------------------------------------------------------------------------
  describe('metadata extraction', () => {
    it('computes latencyMs from startTime and endTime', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        startTime: 5000,
        endTime: 5350,
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries[0].metadata.latencyMs).toBe(350);
    });

    it('sets latencyMs to undefined when endTime is missing', () => {
      // Edge case: this shouldn't normally happen for completed spans,
      // but we handle it gracefully
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        endTime: undefined,
        status: 'completed', // completed but missing endTime (abnormal)
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries[0].metadata.latencyMs).toBeUndefined();
    });

    it('extracts model from llm.model attribute', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan({ id: 's1', traceId: 't1' });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries[0].metadata.model).toBe('gpt-4');
    });

    it('handles missing optional metadata gracefully', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          'llm.input_messages': [{ role: 'user', content: 'Hi' }],
          'llm.output_message': { role: 'assistant', content: 'Hey' },
          // No model, no token usage, no cost
        },
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].metadata.model).toBeUndefined();
      expect(entries[0].metadata.tokenUsage).toBeUndefined();
      expect(entries[0].metadata.cost).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty input_messages array', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          'llm.input_messages': [],
          'llm.output_message': { role: 'assistant', content: 'Hello' },
        },
      });
      const trace = makeTrace({ id: 't1', spans: [span] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].messages).toEqual([]);
    });

    it('handles combined filters (model + minQuality)', () => {
      const exporter = createDatasetExporter({ model: 'gpt-4', minQuality: 0.7 });

      const matchSpan = makeLlmSpan({
        id: 's1',
        traceId: 't1',
        attributes: {
          ...makeLlmSpan().attributes,
          'llm.quality_score': 0.9,
        },
      });
      const wrongModel = makeLlmSpan({
        id: 's2',
        traceId: 't1',
        attributes: {
          'llm.model': 'claude-3',
          'llm.input_messages': [{ role: 'user', content: 'Hi' }],
          'llm.output_message': { role: 'assistant', content: 'Hello' },
          'llm.quality_score': 0.9,
        },
      });
      const lowQuality = makeLlmSpan({
        id: 's3',
        traceId: 't1',
        attributes: {
          ...makeLlmSpan().attributes,
          'llm.quality_score': 0.3,
        },
      });

      const trace = makeTrace({ id: 't1', spans: [matchSpan, wrongModel, lowQuality] });
      const entries = exporter.exportToEntries([trace]);

      expect(entries).toHaveLength(1);
      expect(entries[0].metadata.spanId).toBe('s1');
    });
  });

  // FIX 3: Runtime validation of span attributes before unsafe type casts
  describe('safe attribute validation', () => {
    it('skips span when llm.input_messages is not an array', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({
        status: 'completed',
        attributes: {
          'llm.input_messages': 'not-an-array',
          'llm.output_message': { role: 'assistant', content: 'response' },
        },
      });
      const trace = makeTrace({ spans: [span] });
      const entries = exporter.exportToEntries([trace]);
      // isLlmSpan checks Array.isArray, so this span is filtered out before spanToEntry
      expect(entries).toHaveLength(0);
    });

    it('skips span when llm.output_message is null', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({
        status: 'completed',
        attributes: {
          'llm.input_messages': [{ role: 'user', content: 'hi' }],
          'llm.output_message': null,
        },
      });
      const trace = makeTrace({ spans: [span] });
      const entries = exporter.exportToEntries([trace]);
      expect(entries).toHaveLength(0);
    });

    it('skips span when llm.output_message is a string instead of object', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({
        status: 'completed',
        attributes: {
          'llm.input_messages': [{ role: 'user', content: 'hi' }],
          'llm.output_message': 'just a string',
        },
      });
      const trace = makeTrace({ spans: [span] });
      const entries = exporter.exportToEntries([trace]);
      expect(entries).toHaveLength(0);
    });

    it('skips span when llm.output_message is undefined', () => {
      const exporter = createDatasetExporter();
      const span = makeSpan({
        status: 'completed',
        attributes: {
          'llm.input_messages': [{ role: 'user', content: 'hi' }],
          // llm.output_message intentionally missing
        },
      });
      const trace = makeTrace({ spans: [span] });
      const entries = exporter.exportToEntries([trace]);
      expect(entries).toHaveLength(0);
    });

    it('processes span correctly when attributes are valid', () => {
      const exporter = createDatasetExporter();
      const span = makeLlmSpan();
      const trace = makeTrace({ spans: [span] });
      const entries = exporter.exportToEntries([trace]);
      expect(entries).toHaveLength(1);
      expect(entries[0].output.role).toBe('assistant');
    });
  });
});
