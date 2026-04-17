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
  const eventFn = vi.fn();

  const mockTraceObj = {
    generation: generationFn,
    span: spanFn,
    update: updateFn,
    event: eventFn,
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
      event: eventFn,
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

  it('evicts exactly one oldest entry (single-entry LRU) when cache overflows', async () => {
    // BUG REPRODUCTION: Previously, eviction removed 10% of entries in a batch,
    // causing a 20ms+ event loop pause. True LRU should evict exactly 1 entry.
    vi.useFakeTimers();
    // Use a size of 10 so that batch eviction (10% = 1) and single-entry
    // eviction produce different results when we add 2 entries over the limit.
    // With batch (10% of 10 = 1), the first overflow evicts 1, reducing to 10,
    // then the second overflow evicts 1 more -- same as single-entry.
    // So instead, use size 20 where 10% = 2 entries per batch eviction.
    // With single-entry: overflow by 1 -> evict 1 oldest.
    // With batch (10% of 20 = 2): overflow by 1 -> evict 2 entries at once.
    const maxSize = 20;
    const exporter = createLangfuseExporter({ client: mock.client, maxTraceMapSize: maxSize });

    // Fill the cache to maxSize
    for (let i = 0; i < maxSize; i++) {
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

    // Add exactly one more to trigger eviction (cache goes from 20 -> 21 -> eviction)
    vi.setSystemTime(3000);
    await exporter.exportTrace({
      id: 'trace-new-0',
      name: 'test-new-0',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    });

    // With single-entry LRU: only trace-0 (oldest, timestamp 1000) should be evicted.
    // With batch eviction (10% of 20 = 2): trace-0 AND trace-1 would both be evicted.

    // Check trace-1: should still be in cache (single-entry only evicts 1)
    mock.mocks.trace.mockClear();
    await exporter.exportTrace({
      id: 'trace-1',
      name: 'test-1-check',
      startTime: Date.now(),
      metadata: {},
      spans: [],
      status: 'completed',
    });
    // trace() should NOT be called because trace-1 was NOT evicted (only 1 entry evicted)
    expect(mock.mocks.trace).not.toHaveBeenCalled();

    vi.useRealTimers();
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

  // LM-015: flushAsync must complete (or time out) BEFORE clearing maps
  describe('LM-015: shutdown awaits flush before clearing state', () => {
    it('awaits flushAsync before clearing traceMap', async () => {
      const order: string[] = [];
      const flushAsync = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              order.push('flush-resolved');
              resolve();
            }, 20);
          }),
      );
      const client = {
        trace: vi.fn().mockReturnValue({
          generation: vi.fn(),
          span: vi.fn(),
          update: vi.fn(),
          event: vi.fn(),
        }),
        flushAsync,
        getPrompt: vi.fn(),
      } as unknown as LangfuseExporterConfig['client'];

      const exporter = createLangfuseExporter({ client });
      // Prime the trace map.
      await exporter.exportTrace({
        id: 't1',
        name: 'x',
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
      // Kick shutdown; the flush hasn't resolved yet.
      const shutdownPromise = exporter.shutdown!().then(() => {
        order.push('shutdown-resolved');
      });
      await shutdownPromise;
      // Flush must have settled before shutdown claimed completion.
      expect(order).toEqual(['flush-resolved', 'shutdown-resolved']);
    });

    it('caps flush at 5 seconds and still clears state on timeout', async () => {
      vi.useFakeTimers();
      try {
        // A flushAsync that never resolves.
        const flushAsync = vi.fn(
          () => new Promise<void>(() => {}),
        );
        const client = {
          trace: vi.fn().mockReturnValue({
            generation: vi.fn(),
            span: vi.fn(),
            update: vi.fn(),
            event: vi.fn(),
          }),
          flushAsync,
          getPrompt: vi.fn(),
        } as unknown as LangfuseExporterConfig['client'];

        const exporter = createLangfuseExporter({ client });
        const p = exporter.shutdown!();
        // Advance past the 5s cap.
        await vi.advanceTimersByTimeAsync(5_001);
        await expect(p).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('swallows flushAsync rejection but still clears state', async () => {
      const flushAsync = vi.fn().mockRejectedValue(new Error('network down'));
      const client = {
        trace: vi.fn().mockReturnValue({
          generation: vi.fn(),
          span: vi.fn(),
          update: vi.fn(),
          event: vi.fn(),
        }),
        flushAsync,
        getPrompt: vi.fn(),
      } as unknown as LangfuseExporterConfig['client'];

      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exporter = createLangfuseExporter({ client });
      await exporter.exportTrace({
        id: 't1',
        name: 'x',
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
      await expect(exporter.shutdown!()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Wave-12 P1-23: exportTrace must not leave a poisoned traceMap entry
  // when the underlying client.update() throws.
  // -------------------------------------------------------------------------

  describe('Wave-12 P1-23: exportTrace cleans up on update() throw', () => {
    it('deletes the newly-cached trace entry when update() throws', async () => {
      mock.mocks.update.mockImplementationOnce(() => {
        throw new Error('update failed');
      });
      const exporter = createLangfuseExporter({ client: mock.client });

      // First call throws AND must not leave a poisoned trace handle behind.
      await expect(
        exporter.exportTrace({
          id: 'poisoned',
          name: 'run',
          startTime: Date.now(),
          metadata: {},
          spans: [],
          status: 'running',
        }),
      ).rejects.toThrow('update failed');

      // Subsequent export with the same id must call trace() again (fresh
      // handle), proving the prior entry was purged. update() now succeeds.
      mock.mocks.trace.mockClear();
      await exporter.exportTrace({
        id: 'poisoned',
        name: 'run-retry',
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
      expect(mock.mocks.trace).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'poisoned' }),
      );
    });

    it('preserves an existing traceMap entry when update() throws on a reused handle', async () => {
      // Seed the entry successfully.
      const exporter = createLangfuseExporter({ client: mock.client });
      await exporter.exportTrace({
        id: 'seeded',
        name: 'seed',
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'running',
      });

      // Now make the second update() throw. The entry was NOT created this
      // call, so it should NOT be deleted (LRU-managed handle remains valid).
      mock.mocks.update.mockImplementationOnce(() => {
        throw new Error('transient fail');
      });
      await expect(
        exporter.exportTrace({
          id: 'seeded',
          name: 'seed',
          startTime: Date.now(),
          metadata: {},
          spans: [],
          status: 'completed',
        }),
      ).rejects.toThrow('transient fail');

      // Third call should reuse the cached handle (no new trace()).
      mock.mocks.trace.mockClear();
      mock.mocks.update.mockImplementationOnce(() => undefined);
      await exporter.exportTrace({
        id: 'seeded',
        name: 'seed',
        startTime: Date.now(),
        metadata: {},
        spans: [],
        status: 'completed',
      });
      expect(mock.mocks.trace).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Wave-12 P1-26: events[].attributes are sanitized the same way as the
  // top-level span.attributes bag.
  // -------------------------------------------------------------------------

  describe('Wave-12 P1-26: event-attribute sanitization', () => {
    it('redacts secret keys in events[].attributes via the default sanitizer', async () => {
      const exporter = createLangfuseExporter({ client: mock.client });
      const span: Span = {
        id: 'span-evt-default',
        traceId: 'trace-1',
        name: 'op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [
          {
            name: 'request',
            timestamp: 1500,
            attributes: { api_key: 'sk-secret', region: 'us-east' },
          },
        ],
        status: 'completed',
      };

      await exporter.exportSpan(span);

      const sent = mock.mocks.span.mock.calls[0]?.[0] as
        | { metadata: { events: Array<{ attributes?: Record<string, unknown> }> } }
        | undefined;
      expect(sent).toBeDefined();
      const evtAttrs = sent!.metadata.events[0].attributes!;
      expect(evtAttrs.api_key).toBe('[REDACTED]');
      expect(evtAttrs.region).toBe('us-east');
    });

    it('applies a caller-supplied sanitize function to event attributes too', async () => {
      const sanitize = vi.fn((attrs: Record<string, unknown>) => {
        const out = { ...attrs };
        if ('user_token' in out) out.user_token = '***';
        return out;
      });
      const exporter = createLangfuseExporter({ client: mock.client, sanitize });
      const span: Span = {
        id: 'span-evt-custom',
        traceId: 'trace-1',
        name: 'op',
        startTime: 1000,
        endTime: 2000,
        attributes: { model: 'm' }, // generation path
        events: [
          { name: 'auth', timestamp: 1500, attributes: { user_token: 'abc123' } },
        ],
        status: 'completed',
      };

      await exporter.exportSpan(span);

      // sanitize() called twice: once for top-level attrs, once per event
      expect(sanitize).toHaveBeenCalledTimes(2);
      const sent = mock.mocks.generation.mock.calls[0]?.[0] as
        | { metadata: { events: Array<{ attributes?: Record<string, unknown> }> } }
        | undefined;
      expect(sent).toBeDefined();
      expect(sent!.metadata.events[0].attributes!.user_token).toBe('***');
    });

    it('passes events without attributes through unchanged (no extra sanitize call)', async () => {
      const sanitize = vi.fn((attrs: Record<string, unknown>) => attrs);
      const exporter = createLangfuseExporter({ client: mock.client, sanitize });
      const span: Span = {
        id: 'span-evt-bare',
        traceId: 'trace-1',
        name: 'op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [{ name: 'bare', timestamp: 1500 }],
        status: 'completed',
      };

      await exporter.exportSpan(span);

      // Only top-level attributes triggered sanitize; bare event has no attrs
      expect(sanitize).toHaveBeenCalledTimes(1);
    });
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
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await backend.fetch('chat-prompt');
    expect(result).toBeUndefined();
    // Wave-5F T13: default logger renders a JSON line; assert both phrases
    // appear in the single formatted argument.
    const line = (warnSpy.mock.calls[0]?.[0] ?? '') as string;
    expect(line).toContain('Failed to fetch prompt');
    expect(line).toContain('not a string type');
    warnSpy.mockRestore();
  });

  it('TEST-002: non-string prompt raises HarnessError(PROVIDER_ERROR) before being caught', async () => {
    // This test asserts the internal throw path: toPromptTemplate throws a
    // HarnessError with code PROVIDER_ERROR. The outer try/catch in fetch()
    // swallows it, so we verify the thrown error via a direct rethrow spy
    // on the client.getPrompt call chain.
    mock.mocks.getPrompt.mockResolvedValue({
      // structured chat prompt — not a string
      prompt: [{ role: 'system', content: 'hi' }],
      version: 7,
    });

    // Wave-5F T13: default logger emits a single JSON line via console.log.
    // Assert both the prefix and the propagated error.message appear.
    const warnLines: string[] = [];
    const warnSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      warnLines.push(line);
    });

    const backend = createLangfusePromptBackend({ client: mock.client });
    await backend.fetch('structured-prompt');

    expect(warnLines).toHaveLength(1);
    const line = warnLines[0]!;
    expect(line).toContain('Failed to fetch prompt');
    expect(line).toContain('Langfuse prompt \\"structured-prompt\\" is not a string type');
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

  it('returns 0 cost when inputTokens is NaN (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: NaN,
      outputTokens: 500,
    });

    // H1: NaN token counts must produce cost of 0, not NaN
    expect(record.estimatedCost).toBe(0);
    expect(Number.isNaN(record.estimatedCost)).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);

    // Should have warned about invalid token counts
    const invalidWarns = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('Invalid token counts'),
    );
    expect(invalidWarns.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when outputTokens is NaN (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: NaN,
    });

    expect(record.estimatedCost).toBe(0);
    expect(Number.isNaN(record.estimatedCost)).toBe(false);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when inputTokens is Infinity (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: Infinity,
      outputTokens: 500,
    });

    expect(record.estimatedCost).toBe(0);
    expect(Number.isFinite(record.estimatedCost)).toBe(true);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when outputTokens is -Infinity (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: 1000,
      outputTokens: -Infinity,
    });

    expect(record.estimatedCost).toBe(0);
    expect(Number.isFinite(record.estimatedCost)).toBe(true);
    warnSpy.mockRestore();
  });

  it('returns 0 cost when both tokens are NaN (H1)', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([
      { model: 'claude-3', inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    ]);

    const record = tracker.recordUsage({
      traceId: 't1',
      model: 'claude-3',
      inputTokens: NaN,
      outputTokens: NaN,
    });

    expect(record.estimatedCost).toBe(0);
    // Total cost should not be NaN either
    expect(Number.isNaN(tracker.getTotalCost())).toBe(false);
    expect(tracker.getTotalCost()).toBe(0);
    warnSpy.mockRestore();
  });

  it('computes normal cost when token counts are valid finite numbers (H1 baseline)', () => {
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

    // Normal case: 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
    expect(record.estimatedCost).toBeCloseTo(0.0105);
    expect(Number.isFinite(record.estimatedCost)).toBe(true);
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

  // FIX 5: Empty pricing map warns once per model
  it('warns once per unknown model when no pricing is configured', () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = createLangfuseCostTracker({ client: mock.client });
    // No pricing set -- record multiple usages for the same unknown model
    tracker.recordUsage({ traceId: 't1', model: 'unknown-model', inputTokens: 1000, outputTokens: 0 });
    tracker.recordUsage({ traceId: 't2', model: 'unknown-model', inputTokens: 1000, outputTokens: 0 });
    tracker.recordUsage({ traceId: 't3', model: 'another-unknown', inputTokens: 1000, outputTokens: 0 });

    // Should warn once per model, not per call
    const unknownModelWarns = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('No pricing configured'),
    );
    expect(unknownModelWarns).toHaveLength(2); // one for 'unknown-model', one for 'another-unknown'
    warnSpy.mockRestore();
  });

  // FIX 6: Flush errors are logged, not silently swallowed
  it('logs flush errors via console.warn instead of silently swallowing', () => {
    const flushError = new Error('flush network error');
    mock.mocks.flushAsync.mockRejectedValue(flushError);
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const tracker = createLangfuseCostTracker({ client: mock.client });
    tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
    tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

    // Allow promise rejection to be handled
    return new Promise<void>(resolve => setTimeout(() => {
      const flushWarns = warnSpy.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('flush error'),
      );
      expect(flushWarns.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
      resolve();
    }, 20));
  });

  // FIX 7: maxRecords validation
  it('throws when maxRecords is less than 1', () => {
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: 0 }))
      .toThrow('maxRecords must be >= 1');
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: -5 }))
      .toThrow('maxRecords must be >= 1');
  });

  it('does not throw when maxRecords is 1 or greater', () => {
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: 1 }))
      .not.toThrow();
    expect(() => createLangfuseCostTracker({ client: mock.client, maxRecords: 100 }))
      .not.toThrow();
  });

  it('does not throw when maxRecords is undefined (uses default)', () => {
    expect(() => createLangfuseCostTracker({ client: mock.client }))
      .not.toThrow();
  });

  it('TEST-008: does not throw when maxRecords is explicitly undefined', () => {
    // Explicit-undefined is distinct from key-omitted because some validators
    // treat them differently. Confirm both call-shapes default cleanly.
    expect(() =>
      createLangfuseCostTracker({ client: mock.client, maxRecords: undefined }),
    ).not.toThrow();
    // And the tracker should actually accept records without blowing up,
    // proving the default was substituted.
    const tracker = createLangfuseCostTracker({
      client: mock.client,
      maxRecords: undefined,
    });
    tracker.setPricing([
      { model: 'gpt-x', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
    ]);
    expect(() =>
      tracker.recordUsage({ model: 'gpt-x', inputTokens: 10, outputTokens: 5 }),
    ).not.toThrow();
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

  // -------------------------------------------------------------------------
  // CQ-010: Kahan summation + Map-backed per-key totals + exceeded branch
  // -------------------------------------------------------------------------

  describe('CQ-010: KahanSum running total', () => {
    it('accumulates many tiny costs without drifting from exact sum', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        // 1 token => 0.0000001 dollars (a value not representable exactly in float)
        { model: 'a', inputPer1kTokens: 0.0001, outputPer1kTokens: 0 },
      ]);

      const N = 2500;
      for (let i = 0; i < N; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }

      // Naive summation drifts off by many ULPs after thousands of adds.
      // KahanSum should land within 1e-12 of the mathematical total.
      const expected = N * (0.0001 / 1000);
      const actual = tracker.getTotalCost();
      expect(Math.abs(actual - expected)).toBeLessThan(1e-12);
    });

    it('keeps running total stable past the 1000-record boundary (no recalibration gap)', () => {
      // BUG REPRODUCTION: prior implementation recalibrated every 1000
      // records via O(N) reduce(). Totals just above / below 1000 should
      // both be accurate without requiring a reduction pass.
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 0.0003, outputPer1kTokens: 0 },
      ]);

      for (let i = 0; i < 999; i++) {
        tracker.recordUsage({ traceId: `t${i}`, model: 'a', inputTokens: 1, outputTokens: 0 });
      }
      const at999 = tracker.getTotalCost();

      tracker.recordUsage({ traceId: 't999', model: 'a', inputTokens: 1, outputTokens: 0 });
      const at1000 = tracker.getTotalCost();

      tracker.recordUsage({ traceId: 't1000', model: 'a', inputTokens: 1, outputTokens: 0 });
      const at1001 = tracker.getTotalCost();

      const step = 0.0003 / 1000;
      expect(Math.abs(at1000 - (at999 + step))).toBeLessThan(1e-12);
      expect(Math.abs(at1001 - (at1000 + step))).toBeLessThan(1e-12);
    });
  });

  describe('CQ-010: Map-backed per-key totals', () => {
    it('getCostByModel uses maintained map (not array scan)', () => {
      // After eviction, the map-backed total should still exclude evicted rows.
      const tracker = createLangfuseCostTracker({ client: mock.client, maxRecords: 3 });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 },
        { model: 'b', inputPer1kTokens: 0.002, outputPer1kTokens: 0 },
      ]);

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'b', inputTokens: 1000, outputTokens: 0 });
      // Evict t1 (model 'a')
      tracker.recordUsage({ traceId: 't4', model: 'b', inputTokens: 1000, outputTokens: 0 });

      const byModel = tracker.getCostByModel();
      // model 'a': 1 record remaining (the other was evicted) => 0.001
      expect(byModel['a']).toBeCloseTo(0.001, 8);
      // model 'b': 2 records => 0.004
      expect(byModel['b']).toBeCloseTo(0.004, 8);
    });

    it('getCostByTrace is O(1) via maintained map and excludes evicted traces', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client, maxRecords: 2 });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 },
      ]);

      tracker.recordUsage({ traceId: 'keep-me', model: 'a', inputTokens: 1000, outputTokens: 0 });
      // Evict the above by pushing two more records
      tracker.recordUsage({ traceId: 'x1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 'x2', model: 'a', inputTokens: 1000, outputTokens: 0 });

      // 'keep-me' has been evicted from the retained window
      expect(tracker.getCostByTrace('keep-me')).toBe(0);
      expect(tracker.getCostByTrace('x1')).toBeCloseTo(0.001, 8);
      expect(tracker.getCostByTrace('x2')).toBeCloseTo(0.001, 8);
    });

    it('updateUsage adjusts per-model and per-trace totals incrementally', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
      ]);

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 1000 });
      expect(tracker.getCostByModel()['a']).toBeCloseTo(0.003);
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.003);

      // Double the tokens on the same record — cost doubles
      tracker.updateUsage!('t1', { inputTokens: 2000, outputTokens: 2000 });
      expect(tracker.getCostByModel()['a']).toBeCloseTo(0.006);
      expect(tracker.getCostByTrace('t1')).toBeCloseTo(0.006);
    });
  });

  describe('CQ-010: exceeded branch in checkBudget / isBudgetExceeded', () => {
    it('checkBudget returns an exceeded alert when actual >= hard budget', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      // 100% usage exactly
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 500, outputTokens: 500 });
      const alert = tracker.checkBudget();
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('exceeded');
      expect(alert!.percentUsed).toBeGreaterThanOrEqual(1.0);
      expect(alert!.message).toContain('Exceeded');
    });

    it('checkBudget returns exceeded (not critical) when over budget', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      // 150% usage — must surface as 'exceeded', not 'critical'.
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 750, outputTokens: 750 });
      const alert = tracker.checkBudget();
      expect(alert!.type).toBe('exceeded');
    });

    it('emits an exceeded alert through onAlert when the budget is breached', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      const alerts: CostAlert[] = [];
      tracker.onAlert(a => alerts.push(a));

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      const exceeded = alerts.filter(a => a.type === 'exceeded');
      expect(exceeded.length).toBe(1);
    });

    it('isBudgetExceeded / shouldStop agree with checkBudget=exceeded', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      // Not yet exceeded
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
      expect(tracker.isBudgetExceeded()).toBe(false);
      expect(tracker.shouldStop()).toBe(false);
      expect(tracker.checkBudget()?.type).not.toBe('exceeded');

      // Exceed
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 500, outputTokens: 500 });
      expect(tracker.isBudgetExceeded()).toBe(true);
      expect(tracker.shouldStop()).toBe(true);
      expect(tracker.checkBudget()!.type).toBe('exceeded');
    });

    it('getAlertMessage reports BUDGET EXCEEDED when over budget', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      expect(tracker.getAlertMessage()).toContain('BUDGET EXCEEDED');
    });
  });

  // -------------------------------------------------------------------------
  // F18c: Budget race condition — snapshot-based budget check
  // -------------------------------------------------------------------------

  describe('F18c: budget snapshot prevents mid-check mutation', () => {
    it('uses a consistent budget snapshot throughout recordUsage', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(10.0);

      const alerts: CostAlert[] = [];
      tracker.onAlert((a) => alerts.push(a));

      // Record usage well below the budget — should produce no alert
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
      expect(alerts).toHaveLength(0);

      // If budget were read live (not snapshotted), a concurrent setBudget(0.01)
      // mid-recordUsage could cause the check to fire for a budget that wasn't
      // set when the call began. With the snapshot, this is safe.
      tracker.setBudget(0.01);
      // The previous recordUsage already completed, so the new budget only
      // affects future calls.
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1, outputTokens: 1 });
      // Now the budget is exceeded (cost > 0.01)
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // OBS-003: Budget-exceeded Langfuse event emission (with dedupe)
  // -------------------------------------------------------------------------

  describe('OBS-003: budget_exceeded event emission', () => {
    it('emits a Langfuse event named "budget_exceeded" when shouldStop() flips true', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });

      expect(mock.mocks.event).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'budget_exceeded',
          level: 'ERROR',
          metadata: expect.objectContaining({
            model: 'a',
            budget: 1.0,
          }),
        }),
      );
    });

    it('dedupes budget_exceeded events by (model + budget) across multiple overages', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      // Three separate overages for the same (model, budget) => single event.
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });

      const calls = mock.mocks.event.mock.calls.filter(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'budget_exceeded',
      );
      expect(calls.length).toBe(1);
    });

    it('re-emits budget_exceeded after setBudget() opens a fresh window', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });

      // Flip to a new budget — dedupe window resets.
      tracker.setBudget(0.5);
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 10, outputTokens: 10 });

      const calls = mock.mocks.event.mock.calls.filter(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'budget_exceeded',
      );
      expect(calls.length).toBe(2);
    });

    it('does NOT emit budget_exceeded while still within critical band', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);
      // 98% => critical but not exceeded
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 490, outputTokens: 490 });

      const calls = mock.mocks.event.mock.calls.filter(
        (c: unknown[]) => (c[0] as { name?: string })?.name === 'budget_exceeded',
      );
      expect(calls.length).toBe(0);
    });

    it('increments stats.budgetExceededEvents only for true exceedance', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      expect(tracker.getStats().budgetExceededEvents).toBe(1);
    });

    it('swallows event() failures without breaking recordUsage', () => {
      mock.mocks.event.mockImplementation(() => {
        throw new Error('event send failed');
      });
      const onExportError = vi.fn();
      const tracker = createLangfuseCostTracker({ client: mock.client, onExportError });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      // Should NOT throw despite event() blowing up
      expect(() => {
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      }).not.toThrow();

      // onExportError was notified with op='record'
      expect(onExportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ op: 'record' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // OBS-015: Flush errors route through onExportError / logger / fallback
  // -------------------------------------------------------------------------

  describe('OBS-015: flush error handling', () => {
    it('calls onExportError with op="flush" when provided', async () => {
      const flushError = new Error('boom');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const onExportError = vi.fn();

      const tracker = createLangfuseCostTracker({ client: mock.client, onExportError });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      expect(onExportError).toHaveBeenCalledWith(
        flushError,
        expect.objectContaining({ op: 'flush' }),
      );
    });

    it('falls back to logger.error when no onExportError is provided', async () => {
      const flushError = new Error('network down');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };

      const tracker = createLangfuseCostTracker({ client: mock.client, logger: logger as never });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('export error'),
        expect.objectContaining({ op: 'flush' }),
      );
    });

    it('falls back to console.warn when neither onExportError nor logger is configured', async () => {
      const flushError = new Error('legacy path');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      const flushWarns = warnSpy.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('flush error'),
      );
      expect(flushWarns.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });

    it('does not invoke logger.error when onExportError IS provided', async () => {
      const flushError = new Error('only onExportError');
      mock.mocks.flushAsync.mockRejectedValue(flushError);
      const onExportError = vi.fn();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      };

      const tracker = createLangfuseCostTracker({
        client: mock.client,
        onExportError,
        logger: logger as never,
      });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 20));

      expect(onExportError).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('exposes flushErrors count via getStats()', async () => {
      mock.mocks.flushAsync.mockRejectedValue(new Error('flaky'));
      const onExportError = vi.fn();

      const tracker = createLangfuseCostTracker({ client: mock.client, onExportError });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await new Promise(r => setTimeout(r, 30));

      expect(tracker.getStats().flushErrors).toBe(3);
      expect(tracker.getStats().records).toBe(3);
    });

    it('reset() clears flushErrors and budgetExceededEvents counters', async () => {
      mock.mocks.flushAsync.mockRejectedValue(new Error('flaky'));
      const onExportError = vi.fn();
      const tracker = createLangfuseCostTracker({ client: mock.client, onExportError });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 }]);
      tracker.setBudget(1.0);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 600, outputTokens: 600 });
      await new Promise(r => setTimeout(r, 20));

      expect(tracker.getStats().flushErrors).toBeGreaterThan(0);
      expect(tracker.getStats().budgetExceededEvents).toBe(1);

      tracker.reset();
      expect(tracker.getStats()).toEqual({
        records: 0,
        flushErrors: 0,
        budgetExceededEvents: 0,
      });
    });

    it('onAlert unsubscribe function removes the handler', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);

      const alerts: CostAlert[] = [];
      const unsubscribe = tracker.onAlert(a => alerts.push(a));

      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 425, outputTokens: 425 });
      expect(alerts.length).toBe(1);

      unsubscribe();
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 100, outputTokens: 100 });
      // No further alerts after unsubscribe
      expect(alerts.length).toBe(1);
    });

    it('onAlert unsubscribe is idempotent', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      const unsubscribe = tracker.onAlert(() => {});
      unsubscribe();
      // Second call must not throw (handler already removed)
      expect(() => unsubscribe()).not.toThrow();
    });

    it('updateUsage re-fires budget alerts when the delta crosses the threshold', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(1.0);
      const alerts: CostAlert[] = [];
      tracker.onAlert(a => alerts.push(a));

      // 20% usage — no alert yet
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 100, outputTokens: 100 });
      expect(alerts.length).toBe(0);

      // Bump the same record to 85% — should trigger a warning alert
      tracker.updateUsage!('t1', { inputTokens: 425, outputTokens: 425 });
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[alerts.length - 1].type).toBe('warning');
    });

    it('budgetUtilization returns 0 when budget is 0 or unset', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      // No budget set
      expect(tracker.budgetUtilization()).toBe(0);
      // Budget = 0
      tracker.setBudget(0);
      expect(tracker.budgetUtilization()).toBe(0);
    });

    it('budgetUtilization returns cost/budget ratio when budget is set', () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([
        { model: 'a', inputPer1kTokens: 1.0, outputPer1kTokens: 1.0 },
      ]);
      tracker.setBudget(2.0);
      // Cost = 1.0, budget = 2.0 => 0.5
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 500, outputTokens: 500 });
      expect(tracker.budgetUtilization()).toBeCloseTo(0.5, 6);
    });

    it('swallows exceptions thrown from onExportError itself', async () => {
      mock.mocks.flushAsync.mockRejectedValue(new Error('x'));
      const onExportError = vi.fn().mockImplementation(() => {
        throw new Error('callback misbehaved');
      });

      const tracker = createLangfuseCostTracker({ client: mock.client, onExportError });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);

      // recordUsage must remain exception-safe even if the callback throws.
      expect(() =>
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 }),
      ).not.toThrow();

      await new Promise(r => setTimeout(r, 20));
      expect(onExportError).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Wave-12 P1-8: Track in-flight flushAsync promises so dispose() can drain
  // them before returning. Previously these were fire-and-forget.
  // -------------------------------------------------------------------------

  describe('Wave-12 P1-8: dispose() drains pending flushAsync promises', () => {
    it('resolves immediately when no flushes are in flight', async () => {
      const tracker = createLangfuseCostTracker({ client: mock.client });
      await expect(tracker.dispose()).resolves.toBeUndefined();
    });

    it('awaits a slow flushAsync before resolving dispose()', async () => {
      const order: string[] = [];
      mock.mocks.flushAsync.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              order.push('flush-settled');
              resolve();
            }, 25);
          }),
      );
      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await tracker.dispose();
      order.push('dispose-returned');

      // dispose() must not return before the pending flush settles.
      expect(order).toEqual(['flush-settled', 'dispose-returned']);
    });

    it('caps dispose() at the configured timeout when flush never settles', async () => {
      vi.useFakeTimers();
      try {
        mock.mocks.flushAsync.mockImplementation(() => new Promise<void>(() => {}));
        const tracker = createLangfuseCostTracker({ client: mock.client });
        tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

        const p = tracker.dispose(100);
        await vi.advanceTimersByTimeAsync(101);
        await expect(p).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not propagate flushAsync rejections through dispose()', async () => {
      // handleExportError is invoked on rejection; dispose() must still
      // resolve cleanly rather than rethrowing.
      const onExportError = vi.fn();
      mock.mocks.flushAsync.mockRejectedValue(new Error('network'));
      const tracker = createLangfuseCostTracker({ client: mock.client, onExportError });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await expect(tracker.dispose()).resolves.toBeUndefined();
      expect(onExportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ op: 'flush' }),
      );
    });

    it('does not produce unhandled rejections when the logger throws inside handleExportError', async () => {
      // Defensive try/catch inside the .catch() handler means logger
      // exceptions cannot escape as unhandled promise rejections.
      const unhandledSpy = vi.fn();
      process.on('unhandledRejection', unhandledSpy);
      try {
        const badLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn().mockImplementation(() => {
            throw new Error('logger broken');
          }),
          child: vi.fn(),
        };
        mock.mocks.flushAsync.mockRejectedValue(new Error('network'));
        const tracker = createLangfuseCostTracker({
          client: mock.client,
          logger: badLogger as never,
        });
        tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
        tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });

        await expect(tracker.dispose()).resolves.toBeUndefined();
        // Give any straggling rejection a chance to surface.
        await new Promise((r) => setTimeout(r, 20));
        expect(unhandledSpy).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledSpy);
      }
    });

    it('drains multiple pending flushes concurrently', async () => {
      const settled: number[] = [];
      let seq = 0;
      mock.mocks.flushAsync.mockImplementation(() => {
        const mine = seq++;
        return new Promise<void>((resolve) => {
          // Later calls settle sooner to prove allSettled doesn't serialize.
          setTimeout(() => {
            settled.push(mine);
            resolve();
          }, Math.max(5, 30 - mine * 10));
        });
      });

      const tracker = createLangfuseCostTracker({ client: mock.client });
      tracker.setPricing([{ model: 'a', inputPer1kTokens: 0.001, outputPer1kTokens: 0 }]);
      tracker.recordUsage({ traceId: 't1', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't2', model: 'a', inputTokens: 1000, outputTokens: 0 });
      tracker.recordUsage({ traceId: 't3', model: 'a', inputTokens: 1000, outputTokens: 0 });

      await tracker.dispose();
      // All three must have settled before dispose() returns.
      expect(settled).toHaveLength(3);
      expect(settled.sort()).toEqual([0, 1, 2]);
    });
  });
});

// ---------------------------------------------------------------------------
// Wave-13 — Track I (Langfuse exporter) fixes
// ---------------------------------------------------------------------------

describe('Wave-13 Track I — Langfuse exporter', () => {
  it('Wave-13 I-1: flush() awaits client.flushAsync() (no fire-and-forget)', async () => {
    // Build a client whose flushAsync resolves only when we release a deferred.
    // If `flush()` were still fire-and-forget, it would return before the
    // client actually drained, and our observed ordering would be inverted.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const flushAsyncFn = vi.fn().mockImplementation(() => gate);
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];

    const exporter = createLangfuseExporter({ client });
    let flushResolved = false;
    const flushPromise = exporter.flush().then(() => { flushResolved = true; });

    // Give the microtask queue a tick so any non-awaited promises would settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(flushResolved).toBe(false); // flush() must still be waiting

    release();
    await flushPromise;
    expect(flushResolved).toBe(true);
    expect(flushAsyncFn).toHaveBeenCalledTimes(1);
  });

  it('Wave-13 I-1: flush() surfaces rejection so callers cannot miss failures', async () => {
    const flushAsyncFn = vi.fn().mockRejectedValue(new Error('upstream 500'));
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];
    const exporter = createLangfuseExporter({ client });
    await expect(exporter.flush()).rejects.toThrow('upstream 500');
  });

  it('Wave-13 I-2: tags offending span with exporter_error before re-throwing', async () => {
    // Use a client whose span() throws on invocation.
    const throwingSpan = vi.fn(() => { throw new Error('serialization fail'); });
    const mockTraceObj = {
      generation: vi.fn(),
      span: throwingSpan,
      update: vi.fn(),
      event: vi.fn(),
    };
    const traceFn = vi.fn().mockReturnValue(mockTraceObj);
    const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
    const client = { trace: traceFn, flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];

    const events: Array<{ spanId: string; name: string; attributes?: Record<string, unknown> }> = [];
    const instrumentation = {
      startSpan: vi.fn(() => 's'),
      endSpan: vi.fn(),
      addSpanEvent: (spanId: string, ev: { name: string; attributes?: Record<string, unknown> }) => {
        events.push({ spanId, ...ev });
      },
      setSpanAttributes: vi.fn(),
    };

    const exporter = createLangfuseExporter({ client, instrumentation });
    const span: Span = {
      id: 'span-err',
      traceId: 'trace-err',
      name: 'boom',
      startTime: 1,
      attributes: {},
      events: [],
      status: 'error',
    };

    await expect(exporter.exportSpan(span)).rejects.toThrow('serialization fail');
    // Event must carry exporter='langfuse' and error_code.
    expect(events).toHaveLength(1);
    expect(events[0].spanId).toBe('span-err');
    expect(events[0].name).toBe('exporter_error');
    expect(events[0].attributes).toEqual({ exporter: 'langfuse', error_code: 'unknown' });
  });

  it('Wave-13 I-2: preserves HarnessError.code when available on exporter_error', async () => {
    const { HarnessError, HarnessErrorCode } = await import('harness-one/core');
    const throwingUpdate = vi.fn(() => {
      throw new HarnessError('forced', HarnessErrorCode.ADAPTER_ERROR);
    });
    const mockTraceObj = {
      generation: vi.fn(),
      span: vi.fn(),
      update: throwingUpdate,
      event: vi.fn(),
    };
    const traceFn = vi.fn().mockReturnValue(mockTraceObj);
    const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
    const client = { trace: traceFn, flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];
    const events: Array<Record<string, unknown>> = [];
    const instrumentation = {
      startSpan: vi.fn(() => 's'),
      endSpan: vi.fn(),
      addSpanEvent: (spanId: string, ev: { name: string; attributes?: Record<string, unknown> }) =>
        events.push({ spanId, ...ev }),
      setSpanAttributes: vi.fn(),
    };
    const exporter = createLangfuseExporter({ client, instrumentation });
    const trace: Trace = {
      id: 'trace-forced',
      name: 't',
      startTime: 1,
      metadata: {},
      spans: [],
      status: 'completed',
    };
    await expect(exporter.exportTrace(trace)).rejects.toBeInstanceOf(HarnessError);
    expect(events[0].attributes).toMatchObject({
      exporter: 'langfuse',
      error_code: HarnessErrorCode.ADAPTER_ERROR,
    });
  });

  it('Wave-13 I-2: falls back cleanly when instrumentation.addSpanEvent throws', async () => {
    const throwingSpan = vi.fn(() => { throw new Error('x'); });
    const mockTraceObj = {
      generation: vi.fn(), span: throwingSpan, update: vi.fn(), event: vi.fn(),
    };
    const client = {
      trace: vi.fn().mockReturnValue(mockTraceObj),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    } as unknown as LangfuseExporterConfig['client'];
    const instrumentation = {
      startSpan: vi.fn(() => 's'),
      endSpan: vi.fn(),
      addSpanEvent: vi.fn(() => { throw new Error('span gone'); }),
      setSpanAttributes: vi.fn(),
    };
    const exporter = createLangfuseExporter({ client, instrumentation });
    const span: Span = {
      id: 's', traceId: 't', name: 'n', startTime: 0,
      attributes: {}, events: [], status: 'error',
    };
    // The original export error must still propagate (not the instrumentation one).
    await expect(exporter.exportSpan(span)).rejects.toThrow('x');
  });

  it('Wave-13 I-3: flush() rejection increments metrics counter and logs warn', async () => {
    const flushAsyncFn = vi.fn().mockRejectedValue(new Error('batch down'));
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];

    const counterAdd = vi.fn();
    const metrics = {
      counter: vi.fn().mockReturnValue({ add: counterAdd }),
      gauge: vi.fn().mockReturnValue({ record: vi.fn() }),
      histogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };
    const warn = vi.fn();
    const logger = { warn, error: vi.fn(), debug: vi.fn() };

    const exporter = createLangfuseExporter({ client, metrics, logger });
    await expect(exporter.flush()).rejects.toThrow('batch down');
    expect(metrics.counter).toHaveBeenCalledWith(
      'harness.langfuse.flush_failures',
      expect.any(Object),
    );
    expect(counterAdd).toHaveBeenCalledWith(1, { exporter: 'langfuse' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('flush failed'),
      expect.objectContaining({ error: 'batch down' }),
    );
  });

  it('Wave-13 I-3: does not emit counter on successful flush', async () => {
    const flushAsyncFn = vi.fn().mockResolvedValue(undefined);
    const client = { trace: vi.fn(), flushAsync: flushAsyncFn } as unknown as LangfuseExporterConfig['client'];
    const counterAdd = vi.fn();
    const metrics = {
      counter: vi.fn().mockReturnValue({ add: counterAdd }),
      gauge: vi.fn().mockReturnValue({ record: vi.fn() }),
      histogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    };
    const exporter = createLangfuseExporter({ client, metrics });
    await exporter.flush();
    expect(counterAdd).not.toHaveBeenCalled();
  });
});
