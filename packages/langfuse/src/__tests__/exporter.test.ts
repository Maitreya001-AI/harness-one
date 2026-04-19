/**
 * Tests for `createLangfuseExporter`. Covers trace/span creation,
 * sanitize hooks, shutdown ordering, exportTrace error paths, and
 * event-attribute sanitization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createLangfuseExporter,
} from '../index.js';
import type { Trace, Span } from 'harness-one/observe';
import { createMockLangfuse } from './langfuse-test-fixtures.js';

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
      userMetadata: { userId: 'u1' },
      systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
      userMetadata: {},
      systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
        spans: [],
        status: 'completed',
      });
      await expect(exporter.shutdown!()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // exportTrace must not leave a poisoned traceMap entry
  // when the underlying client.update() throws.
  // -------------------------------------------------------------------------

  describe('exportTrace cleans up on update() throw', () => {
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
          userMetadata: {},
          systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
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
          userMetadata: {},
          systemMetadata: {},
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
        userMetadata: {},
        systemMetadata: {},
        spans: [],
        status: 'completed',
      });
      expect(mock.mocks.trace).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // events[].attributes are sanitized the same way as the
  // top-level span.attributes bag.
  // -------------------------------------------------------------------------

  describe('event-attribute sanitization', () => {
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
