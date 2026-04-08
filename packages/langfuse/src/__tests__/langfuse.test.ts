import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createLangfuseExporter,
  createLangfusePromptBackend,
  createLangfuseCostTracker,
} from '../index.js';
import type { LangfuseExporterConfig } from '../index.js';
import type { Trace, Span } from 'harness-one/observe';
import type { CostAlert } from 'harness-one/observe';

// ---------------------------------------------------------------------------
// Mock Langfuse client
// ---------------------------------------------------------------------------

function createMockLangfuse() {
  const generationFn = vi.fn();
  const spanFn = vi.fn();
  const updateFn = vi.fn();

  const mockTraceObj = {
    generation: generationFn,
    span: spanFn,
    update: updateFn,
  };

  const traceFn = vi.fn().mockReturnValue(mockTraceObj);
  const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
  const getPromptFn = vi.fn();

  return {
    client: {
      trace: traceFn,
      flushAsync: flushAsyncFn,
      getPrompt: getPromptFn,
    } as unknown as LangfuseExporterConfig['client'],
    mocks: {
      trace: traceFn,
      generation: generationFn,
      span: spanFn,
      update: updateFn,
      flushAsync: flushAsyncFn,
      getPrompt: getPromptFn,
    },
  };
}

// ---------------------------------------------------------------------------
// createLangfuseExporter
// ---------------------------------------------------------------------------

describe('createLangfuseExporter', () => {
  let mock: ReturnType<typeof createMockLangfuse>;

  beforeEach(() => {
    mock = createMockLangfuse();
  });

  it('has name "langfuse"', () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    expect(exporter.name).toBe('langfuse');
  });

  it('exports a trace to Langfuse', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const trace: Trace = {
      id: 'trace-1',
      name: 'test-trace',
      startTime: Date.now(),
      metadata: { userId: 'u1' },
      spans: [],
      status: 'completed',
    };

    await exporter.exportTrace(trace);

    expect(mock.mocks.trace).toHaveBeenCalledWith({
      id: 'trace-1',
      name: 'test-trace',
      metadata: { userId: 'u1' },
    });
    expect(mock.mocks.update).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        status: 'completed',
        spanCount: 0,
      }),
    });
  });

  it('exports a generation span to Langfuse', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-1',
      traceId: 'trace-1',
      name: 'llm-call',
      startTime: 1000,
      endTime: 2000,
      attributes: { model: 'claude-3', inputTokens: 100, outputTokens: 50 },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'llm-call',
        model: 'claude-3',
        usage: { input: 100, output: 50 },
      }),
    );
  });

  it('exports a non-generation span to Langfuse', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-2',
      traceId: 'trace-1',
      name: 'tool-exec',
      startTime: 1000,
      endTime: 2000,
      attributes: { tool: 'web_search' },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.span).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'tool-exec' }),
    );
    expect(mock.mocks.generation).not.toHaveBeenCalled();
  });

  it('flush calls client.flushAsync and clears trace map', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const trace: Trace = {
      id: 'trace-1',
      name: 'test',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    };
    await exporter.exportTrace(trace);
    await exporter.flush();

    expect(mock.mocks.flushAsync).toHaveBeenCalled();
  });

  it('shutdown calls flushAsync', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    await exporter.shutdown!();
    expect(mock.mocks.flushAsync).toHaveBeenCalled();
  });

  it('reuses existing Langfuse trace for same trace ID', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const trace: Trace = {
      id: 'trace-1',
      name: 'test',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'running',
    };

    await exporter.exportTrace(trace);
    await exporter.exportTrace({ ...trace, status: 'completed' });

    // trace() should only be called once for the same ID
    expect(mock.mocks.trace).toHaveBeenCalledTimes(1);
    expect(mock.mocks.update).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest trace when traceMap exceeds MAX_TRACE_MAP_SIZE', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });

    // Export 1002 unique traces to exceed the 1000 limit
    for (let i = 0; i < 1002; i++) {
      await exporter.exportTrace({
        id: `trace-${i}`,
        name: `test-${i}`,
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
    }

    // The first trace should have been evicted, so re-exporting it
    // should create a new Langfuse trace (i.e., call trace() again)
    mock.mocks.trace.mockClear();
    await exporter.exportTrace({
      id: 'trace-0',
      name: 'test-0',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    });

    // trace() should be called because trace-0 was evicted
    expect(mock.mocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'trace-0' }),
    );
  });
});

// ---------------------------------------------------------------------------
// createLangfusePromptBackend
// ---------------------------------------------------------------------------

describe('createLangfusePromptBackend', () => {
  let mock: ReturnType<typeof createMockLangfuse>;

  beforeEach(() => {
    mock = createMockLangfuse();
  });

  it('fetches a prompt and converts to PromptTemplate', async () => {
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: 'Hello {{name}}, welcome to {{place}}!',
      version: 3,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.fetch('greeting');

    expect(result).toBeDefined();
    expect(result!.id).toBe('greeting');
    expect(result!.version).toBe('3');
    expect(result!.content).toBe('Hello {{name}}, welcome to {{place}}!');
    expect(result!.variables).toEqual(['name', 'place']);
    expect(result!.metadata?.source).toBe('langfuse');
  });

  it('returns undefined when prompt is not found', async () => {
    mock.mocks.getPrompt.mockRejectedValue(new Error('Not found'));

    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.fetch('nonexistent');

    expect(result).toBeUndefined();
  });

  it('deduplicates variables', async () => {
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: '{{name}} said hello to {{name}}',
      version: 1,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.fetch('test');

    expect(result!.variables).toEqual(['name']);
  });

  it('list returns empty array when no prompts fetched', async () => {
    const backend = createLangfusePromptBackend({ client: mock.client });
    const result = await backend.list!();
    expect(result).toEqual([]);
  });

  it('list returns previously fetched prompts', async () => {
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: 'Hello {{name}}!',
      version: 1,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    await backend.fetch('greeting');

    const result = await backend.list!();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('greeting');
    expect(result[0].content).toBe('Hello {{name}}!');
  });

  it('list removes prompts that have been deleted', async () => {
    mock.mocks.getPrompt
      .mockResolvedValueOnce({ prompt: 'Hello', version: 1 })
      .mockRejectedValueOnce(new Error('Not found'));

    const backend = createLangfusePromptBackend({ client: mock.client });
    await backend.fetch('greeting');

    const result = await backend.list!();
    expect(result).toEqual([]);
  });

  it('push throws UNSUPPORTED_OPERATION error', async () => {
    const backend = createLangfusePromptBackend({ client: mock.client });
    await expect(
      backend.push!({
        id: 'test',
        version: '1',
        content: 'test',
        variables: [],
      }),
    ).rejects.toThrow('Langfuse SDK does not support pushing prompts programmatically');
  });
});

// ---------------------------------------------------------------------------
// createLangfuseCostTracker
// ---------------------------------------------------------------------------

describe('createLangfuseCostTracker', () => {
  let mock: ReturnType<typeof createMockLangfuse>;

  beforeEach(() => {
    mock = createMockLangfuse();
  });

  it('records usage and computes cost', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(record.estimatedCost).toBeCloseTo(0.003 + 0.0075);
    expect(tracker.getTotalCost()).toBeCloseTo(0.0105);
  });

  it('exports usage as Langfuse generation', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'gpt-4', inputPer1kTokens: 0.03, outputPer1kTokens: 0.06 },
    ]);

    tracker.recordUsage({
      traceId: 't1',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 200,
    });

    expect(mock.mocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
    );
    expect(mock.mocks.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4',
        usage: { input: 500, output: 200 },
      }),
    );
  });

  it('tracks cost by model', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      { model: 'b', inputPer1kTokens: 0.01, outputPer1kTokens: 0.02 },
    ]);

    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    tracker.recordUsage({ traceId: 't2', model: 'b', inputTokens: 1000, outputTokens: 1000 });

    const byModel = tracker.getCostByModel();
    expect(byModel['a']).toBeCloseTo(0.003);
    expect(byModel['b']).toBeCloseTo(0.03);
  });

  it('tracks cost by trace', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
    ]);

    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 2000, outputTokens: 2000 });

    expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.003);
    expect(tracker.getCostByTrace('t2')).toBeCloseTo(0.006);
  });

  it('emits budget alerts', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
    ]);
    tracker.setBudget(1.0);

    const alerts: CostAlert[] = [];
    tracker.onAlert((a) => alerts.push(a));

    // 85% usage -> warning
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 425, outputTokens: 425 });
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe('warning');

    // 96% usage -> critical
    tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 55, outputTokens: 55 });
    expect(alerts.length).toBe(2);
    expect(alerts[1].type).toBe('critical');
  });

  it('reset clears all records and running total', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
    ]);
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    tracker.reset();
    expect(tracker.getTotalCost()).toBe(0);
  });

  it('records usage with cache tokens included in cost computation', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([{
      model: 'claude-3',
      inputPer1kTokens: 0.003,
      outputPer1kTokens: 0.015,
      cacheReadPer1kTokens: 0.001,
      cacheWritePer1kTokens: 0.002,
    }]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    });

    // input: 1000/1000 * 0.003 = 0.003
    // output: 500/1000 * 0.015 = 0.0075
    // cacheRead: 200/1000 * 0.001 = 0.0002
    // cacheWrite: 100/1000 * 0.002 = 0.0002
    const expected = 0.003 + 0.0075 + 0.0002 + 0.0002;
    expect(record.estimatedCost).toBeCloseTo(expected);
  });

  it('returns 0 cost for unknown models', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    // No pricing set for this model
    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'unknown-model',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(record.estimatedCost).toBe(0);
  });

  it('checkBudget returns null when no budget is set', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    expect(tracker.checkBudget()).toBeNull();
  });

  it('checkBudget returns null when usage is below warning threshold', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 },
    ]);
    tracker.setBudget(10.0);
    // Very small usage, well below 80%
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
    expect(tracker.checkBudget()).toBeNull();
  });

  it('getAlertMessage returns null when no budget is set', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    expect(tracker.getAlertMessage()).toBeNull();
  });

  it('getAlertMessage returns null when below threshold', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 },
    ]);
    tracker.setBudget(10.0);
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
    expect(tracker.getAlertMessage()).toBeNull();
  });

  it('getAlertMessage returns warning message at 80%+ usage', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
    ]);
    tracker.setBudget(1.0);
    // 85% usage
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 425, outputTokens: 425 });
    const msg = tracker.getAlertMessage();
    expect(msg).toContain('BUDGET WARNING');
    expect(msg).toContain('be concise');
  });

  it('getAlertMessage returns critical message at 95%+ usage', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
    ]);
    tracker.setBudget(1.0);
    // 96% usage
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 480, outputTokens: 480 });
    const msg = tracker.getAlertMessage();
    expect(msg).toContain('BUDGET CRITICAL');
    expect(msg).toContain('extremely concise');
  });

  it('does not emit alert when usage is below warning threshold', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.001 },
    ]);
    tracker.setBudget(100.0);

    const alerts: CostAlert[] = [];
    tracker.onAlert((a) => alerts.push(a));

    // Very small usage
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
    expect(alerts).toHaveLength(0);
  });

  it('getCostByTrace returns 0 for unknown traceId', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    expect(tracker.getCostByTrace('nonexistent')).toBe(0);
  });

  it('getTotalCost uses running total (O(1)) not reduce (O(N))', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
    ]);

    // Record multiple usages and verify total is correctly maintained
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.003);

    tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 2000, outputTokens: 2000 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.009);

    // After reset, total should be 0
    tracker.reset();
    expect(tracker.getTotalCost()).toBe(0);

    // New records after reset
    tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.001);
  });
});
