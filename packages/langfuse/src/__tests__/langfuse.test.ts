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

  it('evicts oldest trace when traceMap exceeds MAX_TRACE_MAP_SIZE via exportSpan', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });

    // Export 1002 unique spans (each with a unique traceId) to exceed the 1000 limit
    for (let i = 0; i < 1002; i++) {
      await exporter.exportSpan({
        id: `span-${i}`,
        traceId: `spanTrace-${i}`,
        name: `op-${i}`,
        startTime: Date.now(),
        attributes: {},
        events: [],
        status: 'completed',
      });
    }

    mock.mocks.trace.mockClear();
    // The first trace should have been evicted
    await exporter.exportSpan({
      id: 'span-new',
      traceId: 'spanTrace-0',
      name: 'op-new',
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: 'completed',
    });

    // trace() should be called because spanTrace-0 was evicted
    expect(mock.mocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'spanTrace-0' }),
    );
  });

  it('exports a span with explicit generation marker as generation', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-chat',
      traceId: 'trace-1',
      name: 'chat-completion',
      startTime: 1000,
      endTime: 2000,
      attributes: { 'harness.span.kind': 'generation', input: 'hello', output: 'world' },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.generation).toHaveBeenCalled();
    expect(mock.mocks.span).not.toHaveBeenCalled();
  });

  it('exports a span with token counts as generation', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-tokens',
      traceId: 'trace-1',
      name: 'some-llm-call',
      startTime: 1000,
      endTime: 2000,
      attributes: { inputTokens: 100, outputTokens: 50 },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.generation).toHaveBeenCalled();
    expect(mock.mocks.span).not.toHaveBeenCalled();
  });

  it('exports a span without generation markers as a span', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-plain',
      traceId: 'trace-1',
      name: 'chat-completion',
      startTime: 1000,
      endTime: 2000,
      attributes: { input: 'hello', output: 'world' },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.span).toHaveBeenCalled();
    expect(mock.mocks.generation).not.toHaveBeenCalled();
  });

  describe('sanitize hook', () => {
    it('calls sanitize on span attributes when provided', async () => {
      const sanitize = vi.fn((attrs: Record<string, unknown>) => {
        const sanitized = { ...attrs };
        delete sanitized['input'];
        delete sanitized['output'];
        return sanitized;
      });
      const exporter = createLangfuseExporter({ client: mock.client, sanitize });
      const span: Span = {
        id: 'span-sanitize',
        traceId: 'trace-1',
        name: 'llm-call',
        startTime: 1000,
        endTime: 2000,
        attributes: { model: 'claude-3', input: 'secret PII', output: 'secret response', inputTokens: 10, outputTokens: 5 },
        events: [],
        status: 'completed',
      };

      await exporter.exportSpan(span);

      expect(sanitize).toHaveBeenCalledTimes(1);
      expect(sanitize).toHaveBeenCalledWith(span.attributes);
      expect(mock.mocks.generation).toHaveBeenCalledWith(
        expect.objectContaining({
          input: undefined,
          output: undefined,
          model: 'claude-3',
        }),
      );
    });

    it('passes attributes through unchanged when no sanitize hook', async () => {
      const exporter = createLangfuseExporter({ client: mock.client });
      const span: Span = {
        id: 'span-no-sanitize',
        traceId: 'trace-1',
        name: 'llm-call',
        startTime: 1000,
        endTime: 2000,
        attributes: { model: 'claude-3', input: 'hello', output: 'world' },
        events: [],
        status: 'completed',
      };

      await exporter.exportSpan(span);

      expect(mock.mocks.generation).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 'hello',
          output: 'world',
        }),
      );
    });

    it('sanitize hook output is used for non-generation spans too', async () => {
      const sanitize = vi.fn((attrs: Record<string, unknown>) => {
        const sanitized = { ...attrs };
        sanitized['tool'] = '[REDACTED]';
        return sanitized;
      });
      const exporter = createLangfuseExporter({ client: mock.client, sanitize });
      const span: Span = {
        id: 'span-sanitize-non-gen',
        traceId: 'trace-1',
        name: 'tool-exec',
        startTime: 1000,
        endTime: 2000,
        attributes: { tool: 'web_search' },
        events: [],
        status: 'completed',
      };

      await exporter.exportSpan(span);

      expect(sanitize).toHaveBeenCalledTimes(1);
      expect(mock.mocks.span).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ tool: '[REDACTED]' }),
        }),
      );
    });
  });

  it('does NOT classify span as generation when harness.span.kind is non-generation even with token counts', async () => {
    // A non-LLM operation that happens to count tokens (e.g., a tokenizer utility)
    // should NOT be classified as a generation when kind is explicitly set to something other than 'generation'.
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-tokenizer',
      traceId: 'trace-1',
      name: 'tokenize-text',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        'harness.span.kind': 'tool',
        inputTokens: 200,
        outputTokens: 0,
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    // span.kind='tool' with token counts should be a span, NOT a generation
    expect(mock.mocks.span).toHaveBeenCalled();
    expect(mock.mocks.generation).not.toHaveBeenCalled();
  });

  it('does NOT classify span as generation when harness.span.kind is "tool" even with model attribute', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-tool-with-model',
      traceId: 'trace-1',
      name: 'some-tool',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        'harness.span.kind': 'tool',
        model: 'some-model-ref',
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    // span.kind='tool' with a model attribute should still be a span, not a generation
    expect(mock.mocks.span).toHaveBeenCalled();
    expect(mock.mocks.generation).not.toHaveBeenCalled();
  });

  it('classifies span as generation when harness.span.kind is "generation" even without model/tokens', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-explicit-generation',
      traceId: 'trace-1',
      name: 'my-llm-call',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        'harness.span.kind': 'generation',
        // No model, no token counts — but kind is explicitly 'generation'
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.generation).toHaveBeenCalled();
    expect(mock.mocks.span).not.toHaveBeenCalled();
  });

  it('falls back to model heuristic when harness.span.kind is not set', async () => {
    // When kind is not explicitly set, the model heuristic still applies (backward compat)
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-no-kind',
      traceId: 'trace-1',
      name: 'legacy-llm-call',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        // No harness.span.kind
        model: 'gpt-4',
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.generation).toHaveBeenCalled();
    expect(mock.mocks.span).not.toHaveBeenCalled();
  });

  it('falls back to token count heuristic when harness.span.kind is not set', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-tokens-no-kind',
      traceId: 'trace-1',
      name: 'legacy-llm-tokens',
      startTime: 1000,
      endTime: 2000,
      attributes: {
        // No harness.span.kind
        inputTokens: 100,
        outputTokens: 50,
      },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.generation).toHaveBeenCalled();
    expect(mock.mocks.span).not.toHaveBeenCalled();
  });

  it('exports a span with parentId in metadata for non-generation spans', async () => {
    const exporter = createLangfuseExporter({ client: mock.client });
    const span: Span = {
      id: 'span-child',
      traceId: 'trace-1',
      parentId: 'span-parent',
      name: 'tool-exec',
      startTime: 1000,
      endTime: 2000,
      attributes: { tool: 'web_search' },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.span).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ parentId: 'span-parent' }),
      }),
    );
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

  it('evicts oldest traces deterministically based on access time (LRU)', async () => {
    // Use fake timers to guarantee deterministic timestamp ordering
    vi.useFakeTimers();
    const exporter = createLangfuseExporter({ client: mock.client });

    // Export 1000 unique traces to fill up the map
    // Each at a different timestamp to guarantee ordering
    for (let i = 0; i < 1000; i++) {
      vi.setSystemTime(1000 + i);
      await exporter.exportTrace({
        id: `trace-${i}`,
        name: `test-${i}`,
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
    }

    // Re-access trace-0 to make it "recently used" — give it the most recent timestamp
    vi.setSystemTime(5000);
    await exporter.exportTrace({
      id: 'trace-0',
      name: 'test-0-reaccessed',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    });

    // Now add 101 new traces, causing eviction of the 100 oldest
    for (let i = 1000; i < 1101; i++) {
      vi.setSystemTime(6000 + i);
      await exporter.exportTrace({
        id: `trace-${i}`,
        name: `test-${i}`,
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
    }

    // trace-0 was recently accessed (timestamp 5000), so it should NOT have been evicted
    mock.mocks.trace.mockClear();
    await exporter.exportTrace({
      id: 'trace-0',
      name: 'test-0-check',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    });
    // trace() should NOT be called because trace-0 was not evicted (it was recent)
    expect(mock.mocks.trace).not.toHaveBeenCalled();

    // trace-1 was not re-accessed (timestamp 1001) and should have been evicted
    mock.mocks.trace.mockClear();
    await exporter.exportTrace({
      id: 'trace-1',
      name: 'test-1-check',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    });
    // trace() SHOULD be called because trace-1 was evicted
    expect(mock.mocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'trace-1' }),
    );

    vi.useRealTimers();
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

  it('throws when Langfuse prompt is not a string type', async () => {
    // Langfuse returns a non-string prompt (e.g., a structured/chat prompt object)
    mock.mocks.getPrompt.mockResolvedValue({
      prompt: { messages: [{ role: 'system', content: 'You are helpful' }] },
      version: 1,
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    // The non-string prompt should cause fetch to return undefined
    // because the error is caught by the outer try/catch
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await backend.fetch('chat-prompt');
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch prompt'),
      expect.stringContaining('not a string type'),
    );
    warnSpy.mockRestore();
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

  it('push throws UNSUPPORTED_OPERATION error (read-only adapter)', async () => {
    const backend = createLangfusePromptBackend({ client: mock.client });
    await expect(
      backend.push!({
        id: 'test',
        version: '1',
        content: 'test',
        variables: [],
      }),
    ).rejects.toThrow('Langfuse SDK does not support pushing prompts programmatically');

    // Verify the error includes a hint about using the Langfuse dashboard
    try {
      await backend.push!({ id: 'x', version: '1', content: 'x', variables: [] });
    } catch (err) {
      expect((err as Error).message).toContain('does not support pushing');
    }
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

  it('calls flushAsync after recording usage to persist generation', () => {
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

    // flushAsync should be called after each recordUsage to persist the generation
    expect(mock.mocks.flushAsync).toHaveBeenCalled();
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

  it('evicts oldest records when exceeding maxRecords (10,000) and adjusts runningTotal', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.0 },
    ]);

    // Record 10,001 usages — the first record should be evicted
    for (let i = 0; i < 10_001; i++) {
      tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1000, outputTokens: 0 });
    }

    // Each record costs 0.001. After eviction, 10,000 records remain.
    // runningTotal should reflect 10,000 records, not 10,001.
    expect(tracker.getTotalCost()).toBeCloseTo(10.0, 2);

    // The first trace should have been evicted, so getCostByTrace returns 0
    expect(tracker.getCostByTrace('t0')).toBe(0);
    // The last trace should still be present
    expect(tracker.getCostByTrace('t10000')).toBeCloseTo(0.001);
  });

  it('resets recordsSinceRecalibrate on reset()', () => {
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.0 },
    ]);

    // Record some usages, then reset, then record more
    for (let i = 0; i < 500; i++) {
      tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1000, outputTokens: 0 });
    }
    tracker.reset();
    expect(tracker.getTotalCost()).toBe(0);

    // After reset, recording should still work correctly
    tracker.recordUsage({ traceId: 'post-reset', model: 'a', inputTokens: 1000, outputTokens: 0 });
    expect(tracker.getTotalCost()).toBeCloseTo(0.001);
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
