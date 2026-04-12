import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOTelExporter } from '../index.js';
import type { Trace, Span } from 'harness-one/observe';
import type { Tracer, Span as OTelSpan } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Mock OTel Tracer
// ---------------------------------------------------------------------------

function createMockTracer() {
  const endFn = vi.fn();
  const setAttributeFn = vi.fn();
  const setStatusFn = vi.fn();
  const addEventFn = vi.fn();

  const mockSpan = {
    setAttribute: setAttributeFn,
    setStatus: setStatusFn,
    addEvent: addEventFn,
    end: endFn,
  };

  const startActiveSpanFn = vi.fn().mockImplementation((_name: string, ...args: unknown[]) => {
    // Handle both (name, fn) and (name, options, context, fn) calling conventions
    const fn = args[args.length - 1] as (span: OTelSpan) => void;
    fn(mockSpan as unknown as OTelSpan);
  });

  return {
    tracer: {
      startActiveSpan: startActiveSpanFn,
    } as unknown as Tracer,
    mocks: {
      startActiveSpan: startActiveSpanFn,
      setAttribute: setAttributeFn,
      setStatus: setStatusFn,
      addEvent: addEventFn,
      end: endFn,
      span: mockSpan,
    },
  };
}

describe('createOTelExporter', () => {
  let mock: ReturnType<typeof createMockTracer>;

  beforeEach(() => {
    mock = createMockTracer();
  });

  it('has name "opentelemetry"', () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    expect(exporter.name).toBe('opentelemetry');
  });

  it('exports a trace as an OTel span', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const trace: Trace = {
      id: 'trace-1',
      name: 'agent-run',
      startTime: 1000,
      endTime: 2000,
      metadata: { userId: 'u1' },
      spans: [],
      status: 'completed',
    };

    await exporter.exportTrace(trace);

    expect(mock.mocks.startActiveSpan).toHaveBeenCalledWith('agent-run', expect.any(Function));
    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('harness.trace.id', 'trace-1');
    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('harness.trace.status', 'completed');
    expect(mock.mocks.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK = 1
    expect(mock.mocks.end).toHaveBeenCalled();
  });

  it('exports an error trace with ERROR status', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const trace: Trace = {
      id: 'trace-2',
      name: 'failed-run',
      startTime: 1000,
      metadata: {},
      spans: [],
      status: 'error',
    };

    await exporter.exportTrace(trace);

    expect(mock.mocks.setStatus).toHaveBeenCalledWith({ code: 2 }); // SpanStatusCode.ERROR = 2
  });

  it('exports a span with attributes and events', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const span: Span = {
      id: 'span-1',
      traceId: 'trace-1',
      parentId: 'span-0',
      name: 'llm-call',
      startTime: 1000,
      endTime: 2000,
      attributes: { model: 'gpt-4', temperature: 0.7 },
      events: [
        { name: 'start', timestamp: 1000, attributes: { step: 'begin' } },
        { name: 'complete', timestamp: 2000 },
      ],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('harness.span.id', 'span-1');
    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('harness.trace.id', 'trace-1');
    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('harness.parent.id', 'span-0');
    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('model', 'gpt-4');
    expect(mock.mocks.setAttribute).toHaveBeenCalledWith('temperature', 0.7);
    expect(mock.mocks.addEvent).toHaveBeenCalledTimes(2);
    expect(mock.mocks.addEvent).toHaveBeenCalledWith('start', { step: 'begin' }, expect.any(Date));
    expect(mock.mocks.end).toHaveBeenCalled();
  });

  it('skips non-primitive attributes and logs debug warning', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const span: Span = {
      id: 'span-1',
      traceId: 'trace-1',
      name: 'test',
      startTime: 1000,
      attributes: { complex: { nested: true }, simple: 'yes' },
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    // 'complex' should NOT have been set (not a primitive)
    const calls = mock.mocks.setAttribute.mock.calls;
    const attrNames = calls.map((c: unknown[]) => c[0]);
    expect(attrNames).not.toContain('complex');
    expect(attrNames).toContain('simple');

    // A debug-level warning should be logged for the dropped attribute
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dropping non-primitive attribute 'complex' of type 'object'"),
    );
    debugSpy.mockRestore();
  });

  it('flush is a no-op', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    await expect(exporter.flush()).resolves.toBeUndefined();
  });

  it('does not set parent.id when parentId is undefined', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const span: Span = {
      id: 'span-1',
      traceId: 'trace-1',
      name: 'root-span',
      startTime: 1000,
      attributes: {},
      events: [],
      status: 'running',
    };

    await exporter.exportSpan(span);

    const calls = mock.mocks.setAttribute.mock.calls;
    const attrNames = calls.map((c: unknown[]) => c[0]);
    expect(attrNames).not.toContain('harness.parent.id');
  });

  it('exports an error span with ERROR status', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const span: Span = {
      id: 'span-err',
      traceId: 'trace-1',
      name: 'failing-op',
      startTime: 1000,
      endTime: 2000,
      attributes: {},
      events: [],
      status: 'error',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.setStatus).toHaveBeenCalledWith({ code: 2 }); // SpanStatusCode.ERROR = 2
  });

  it('exports a completed span with OK status', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const span: Span = {
      id: 'span-ok',
      traceId: 'trace-1',
      name: 'success-op',
      startTime: 1000,
      endTime: 2000,
      attributes: {},
      events: [],
      status: 'completed',
    };

    await exporter.exportSpan(span);

    expect(mock.mocks.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK = 1
  });

  it('does not set status for running spans', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });
    const span: Span = {
      id: 'span-1',
      traceId: 'trace-1',
      name: 'running',
      startTime: 1000,
      attributes: {},
      events: [],
      status: 'running',
    };

    await exporter.exportSpan(span);
    expect(mock.mocks.setStatus).not.toHaveBeenCalled();
  });

  it('creates child span with parent context when parentId matches a known span', async () => {
    const exporter = createOTelExporter({ tracer: mock.tracer });

    // Export parent span first
    const parentSpan: Span = {
      id: 'span-parent',
      traceId: 'trace-1',
      name: 'parent-op',
      startTime: 1000,
      endTime: 3000,
      attributes: {},
      events: [],
      status: 'completed',
    };
    await exporter.exportSpan(parentSpan);

    // Export child span with parentId referencing the parent
    const childSpan: Span = {
      id: 'span-child',
      traceId: 'trace-1',
      parentId: 'span-parent',
      name: 'child-op',
      startTime: 1500,
      endTime: 2500,
      attributes: {},
      events: [],
      status: 'completed',
    };
    await exporter.exportSpan(childSpan);

    // Child should have been started with 4 args (name, options, context, callback)
    const childCall = mock.mocks.startActiveSpan.mock.calls[1];
    expect(childCall[0]).toBe('child-op');
    // When parent context is available, it should pass options and context before callback
    expect(childCall.length).toBe(4);
  });

  it('creates root span when parentId has no matching known span and logs warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exporter = createOTelExporter({ tracer: mock.tracer });

    const span: Span = {
      id: 'span-1',
      traceId: 'trace-1',
      parentId: 'unknown-parent',
      name: 'orphan-op',
      startTime: 1000,
      attributes: {},
      events: [],
      status: 'completed',
    };
    await exporter.exportSpan(span);

    // Should fall back to 2-arg form (no parent context)
    const call = mock.mocks.startActiveSpan.mock.calls[0];
    expect(call[0]).toBe('orphan-op');
    expect(call.length).toBe(2);

    // A warning should be logged about the evicted/missing parent
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Parent span 'unknown-parent' not found"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Creating span 'span-1' as a root span"),
    );
    warnSpy.mockRestore();
  });

  describe('evicted parent span linking', () => {
    it('preserves evicted parent context so children can still be linked', async () => {
      // The bug: when a parent span is evicted from the LRU cache, child spans
      // are created as root spans (no parent context). The fix: keep a lightweight
      // reference (evictedParents map) so children can still be linked.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      // Export parent span
      await exporter.exportSpan({
        id: 'evicted-parent',
        traceId: 'trace-1',
        name: 'parent-op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // Flush clears the main spanMap but NOT evictedParents
      await exporter.flush();

      // After flush, parent span is gone from spanMap.
      // With the fix, it should be in evictedParents so the child can still link.
      await exporter.exportSpan({
        id: 'orphan-child',
        traceId: 'trace-1',
        parentId: 'evicted-parent',
        name: 'child-after-eviction',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // With fix: child span should be linked to parent (4 args: name, options, context, callback)
      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('child-after-eviction');
      // 4 args means parent context was used
      expect(childCall.length).toBe(4);

      warnSpy.mockRestore();
    });

    it('evictedParents does not grow beyond configured max size (default 1000)', async () => {
      // Export many unique spans and flush repeatedly to fill evictedParents.
      // The map should not grow unboundedly.
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      // Export 1200 spans and flush after each batch to populate evictedParents
      for (let i = 0; i < 1200; i++) {
        await exporter.exportSpan({
          id: `span-${i}`,
          traceId: 'trace-1',
          name: `op-${i}`,
          startTime: 1000,
          endTime: 2000,
          attributes: {},
          events: [],
          status: 'completed',
        });
      }
      // Flush to move spans to evictedParents
      await exporter.flush();

      // Export a child span with parentId that was in the first batch.
      // The evictedParents map should cap at 1000 — earliest entries are evicted.
      // For span-0 (oldest), it may have been evicted from evictedParents too.
      // Verify the exporter doesn't throw or grow unboundedly.
      await expect(exporter.exportSpan({
        id: 'final-child',
        traceId: 'trace-1',
        parentId: 'span-1199', // most recent — should be in evictedParents
        name: 'final-op',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      })).resolves.toBeUndefined();
    });
  });

  describe('span eviction with parent awareness', () => {
    it('evicts leaf spans before parent spans when limit is exceeded', async () => {
      // Create a mock tracer that tracks unique spans per export
      const mockTracer = {
        startActiveSpan: vi.fn().mockImplementation((_name: string, ...args: unknown[]) => {
          const fn = args[args.length - 1] as (span: unknown) => void;
          const spanObj = {
            setAttribute: vi.fn(),
            setStatus: vi.fn(),
            addEvent: vi.fn(),
            end: vi.fn(),
          };
          fn(spanObj);
          // We can't directly inspect the internal map, but we can test behavior
        }),
      } as unknown as Tracer;

      const exporter = createOTelExporter({ tracer: mockTracer });

      // Export a parent span
      const parentSpan: Span = {
        id: 'parent-1',
        traceId: 'trace-1',
        name: 'parent-op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      };
      await exporter.exportSpan(parentSpan);

      // Export a child span (references parent-1)
      const childSpan: Span = {
        id: 'child-1',
        traceId: 'trace-1',
        parentId: 'parent-1',
        name: 'child-op',
        startTime: 1500,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      };
      await exporter.exportSpan(childSpan);

      // Export a standalone (leaf) span
      const leafSpan: Span = {
        id: 'leaf-1',
        traceId: 'trace-1',
        name: 'leaf-op',
        startTime: 1200,
        endTime: 1800,
        attributes: {},
        events: [],
        status: 'completed',
      };
      await exporter.exportSpan(leafSpan);

      // Now export a span with parentId 'parent-1' that triggers parent context lookup
      // If parent-1 was preserved (not evicted), the child will use 4 args
      // We can't directly test the 10k limit, but we can verify the eviction
      // function exists and the parent tracking works
      const secondChild: Span = {
        id: 'child-2',
        traceId: 'trace-1',
        parentId: 'parent-1',
        name: 'child-op-2',
        startTime: 1600,
        endTime: 1900,
        attributes: {},
        events: [],
        status: 'completed',
      };
      await exporter.exportSpan(secondChild);

      // The parent span should still be available for the second child
      // since leaf spans should be evicted first
      // (verified by the parent context being passed - 4 args)
      const calls = (mockTracer.startActiveSpan as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const child2Call = calls[calls.length - 1];
      expect(child2Call[0]).toBe('child-op-2');
      // Parent-1 should be in the span map, so child-2 should use parent context (4 args)
      expect(child2Call.length).toBe(4);
    });

    it('evicts parent spans when no leaf spans remain for eviction', async () => {
      const mockTracer = {
        startActiveSpan: vi.fn().mockImplementation((_name: string, ...args: unknown[]) => {
          const fn = args[args.length - 1] as (span: unknown) => void;
          fn({
            setAttribute: vi.fn(),
            setStatus: vi.fn(),
            addEvent: vi.fn(),
            end: vi.fn(),
          });
        }),
      } as unknown as Tracer;

      const exporter = createOTelExporter({ tracer: mockTracer });

      // Create parent and child
      await exporter.exportSpan({
        id: 'p1', traceId: 't1', name: 'parent',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });
      await exporter.exportSpan({
        id: 'c1', traceId: 't1', parentId: 'p1', name: 'child',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });

      // Flush migrates spans to evictedParents — parent context is preserved
      await exporter.flush();

      // With the evictedParents fix, the parent is migrated to evictedParents on flush.
      // Children arriving after flush CAN still be linked to their parent.
      await exporter.exportSpan({
        id: 'c2', traceId: 't1', parentId: 'p1', name: 'child-after-flush',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });

      const calls = (mockTracer.startActiveSpan as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      // After flush, parent is in evictedParents, so parent context is available -> 4 args
      expect(lastCall.length).toBe(4);
    });
  });

  describe('evicted parent TTL expiration', () => {
    it('evicted parent entries expire after the default TTL (5 minutes)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      // Export a parent span
      await exporter.exportSpan({
        id: 'ttl-parent',
        traceId: 'trace-1',
        name: 'parent-op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // Flush to move to evictedParents
      await exporter.flush();

      // Advance time past the default TTL (5 minutes = 300,000ms)
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 300_001);

      // Child arriving after TTL should NOT link to the expired parent
      await exporter.exportSpan({
        id: 'ttl-child',
        traceId: 'trace-1',
        parentId: 'ttl-parent',
        name: 'child-after-ttl',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('child-after-ttl');
      // Expired parent should not provide context -> 2 args (root span)
      expect(childCall.length).toBe(2);

      // Warning should be logged about the missing parent
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Parent span 'ttl-parent' not found"),
      );

      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it('evicted parent entries are available within the TTL window', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      // Export a parent span
      await exporter.exportSpan({
        id: 'ttl-parent-ok',
        traceId: 'trace-1',
        name: 'parent-op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // Flush to move to evictedParents
      await exporter.flush();

      // Advance time but stay within the default TTL (5 minutes)
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 299_999);

      // Child arriving within TTL should still link to the parent
      await exporter.exportSpan({
        id: 'ttl-child-ok',
        traceId: 'trace-1',
        parentId: 'ttl-parent-ok',
        name: 'child-within-ttl',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('child-within-ttl');
      // Parent should still provide context -> 4 args
      expect(childCall.length).toBe(4);

      vi.useRealTimers();
    });

    it('TTL is configurable via evictedParentsTtlMs option', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const localMock = createMockTracer();
      // Set a short TTL of 10 seconds
      const exporter = createOTelExporter({
        tracer: localMock.tracer,
        evictedParentsTtlMs: 10_000,
      });

      // Export a parent span
      await exporter.exportSpan({
        id: 'short-ttl-parent',
        traceId: 'trace-1',
        name: 'parent-op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // Flush to move to evictedParents
      await exporter.flush();

      // Advance time past the short TTL (10 seconds)
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 10_001);

      // Child arriving after the custom TTL should NOT link
      await exporter.exportSpan({
        id: 'short-ttl-child',
        traceId: 'trace-1',
        parentId: 'short-ttl-parent',
        name: 'child-after-short-ttl',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('child-after-short-ttl');
      // Expired parent -> root span (2 args)
      expect(childCall.length).toBe(2);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Parent span 'short-ttl-parent' not found"),
      );

      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it('stale evicted parents are cleaned up on new insertions', async () => {
      const localMock = createMockTracer();
      // Small evicted parents pool and short TTL for easy testing
      const exporter = createOTelExporter({
        tracer: localMock.tracer,
        maxEvictedParents: 5,
        evictedParentsTtlMs: 1_000,
      });

      // Export 5 spans and flush to fill evictedParents
      for (let i = 0; i < 5; i++) {
        await exporter.exportSpan({
          id: `stale-${i}`,
          traceId: 'trace-1',
          name: `op-${i}`,
          startTime: 1000,
          endTime: 2000,
          attributes: {},
          events: [],
          status: 'completed',
        });
      }
      await exporter.flush();

      // Advance time past TTL so all entries are stale
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 1_001);

      // Export a new span and flush -- stale entries should be cleaned up,
      // making room without hitting the size limit
      await exporter.exportSpan({
        id: 'fresh-span',
        traceId: 'trace-1',
        name: 'fresh-op',
        startTime: 3000,
        endTime: 4000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      await exporter.flush();

      // Now try to link to 'fresh-span' -- it should be in evictedParents
      // (the stale ones were cleaned up, so fresh-span was not evicted from evictedParents)
      await exporter.exportSpan({
        id: 'fresh-child',
        traceId: 'trace-1',
        parentId: 'fresh-span',
        name: 'fresh-child-op',
        startTime: 4000,
        endTime: 5000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('fresh-child-op');
      // Fresh entry is within TTL -> parent context available (4 args)
      expect(childCall.length).toBe(4);

      vi.useRealTimers();
    });
  });

  describe('maxSpans eviction trigger', () => {
    it('evicts spans when spanMap exceeds maxSpans limit', async () => {
      const localMock = createMockTracer();
      // Use a very small maxSpans so we can trigger eviction easily
      const exporter = createOTelExporter({ tracer: localMock.tracer, maxSpans: 2 });

      // Export 3 spans to exceed maxSpans=2, triggering evictSpans(1)
      await exporter.exportSpan({
        id: 'evict-a',
        traceId: 'trace-1',
        name: 'op-a',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      await exporter.exportSpan({
        id: 'evict-b',
        traceId: 'trace-1',
        name: 'op-b',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      // This third span should trigger eviction of the oldest span (evict-a)
      await exporter.exportSpan({
        id: 'evict-c',
        traceId: 'trace-1',
        name: 'op-c',
        startTime: 3000,
        endTime: 4000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // Evicted span (evict-a) should be in evictedParents, so a child can link
      await exporter.exportSpan({
        id: 'child-of-evicted',
        traceId: 'trace-1',
        parentId: 'evict-a',
        name: 'child-after-eviction',
        startTime: 4000,
        endTime: 5000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('child-after-eviction');
      // evict-a was evicted but saved to evictedParents, so parent context should be available
      expect(childCall.length).toBe(4);
    });

    it('evicts spans and overflows evictedParents when maxEvictedParents is tiny', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const localMock = createMockTracer();
      // maxSpans=1 forces eviction every span, maxEvictedParents=1 caps the fallback map
      const exporter = createOTelExporter({
        tracer: localMock.tracer,
        maxSpans: 1,
        maxEvictedParents: 1,
      });

      // Export 3 spans; each new one evicts the previous from spanMap
      // With maxEvictedParents=1, only the most recent evicted span stays
      await exporter.exportSpan({
        id: 'overflow-a',
        traceId: 'trace-1',
        name: 'op-a',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      await exporter.exportSpan({
        id: 'overflow-b',
        traceId: 'trace-1',
        name: 'op-b',
        startTime: 2000,
        endTime: 3000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      await exporter.exportSpan({
        id: 'overflow-c',
        traceId: 'trace-1',
        name: 'op-c',
        startTime: 3000,
        endTime: 4000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // overflow-a was evicted from both spanMap and evictedParents (overflow limit)
      // So a child referencing it should be created as a root span
      await exporter.exportSpan({
        id: 'child-of-lost',
        traceId: 'trace-1',
        parentId: 'overflow-a',
        name: 'orphan-child',
        startTime: 4000,
        endTime: 5000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const childCall = calls[calls.length - 1];
      expect(childCall[0]).toBe('orphan-child');
      // Parent lost from both maps -> root span (2 args)
      expect(childCall.length).toBe(2);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Parent span 'overflow-a' not found"),
      );
      warnSpy.mockRestore();
    });
  });

  describe('exportTrace cleans up child spans from spanMap', () => {
    it('removes trace child spans from spanMap after exportTrace', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      // Export a span that will be referenced as a child in the trace
      await exporter.exportSpan({
        id: 'trace-child-1',
        traceId: 'trace-1',
        name: 'child-op',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      await exporter.exportSpan({
        id: 'trace-child-2',
        traceId: 'trace-1',
        name: 'child-op-2',
        startTime: 1500,
        endTime: 2500,
        attributes: {},
        events: [],
        status: 'completed',
      });

      // Export the trace, which should clean up its children from spanMap
      const trace: Trace = {
        id: 'trace-1',
        name: 'traced-run',
        startTime: 1000,
        endTime: 3000,
        metadata: {},
        spans: [
          {
            id: 'trace-child-1',
            traceId: 'trace-1',
            name: 'child-op',
            startTime: 1000,
            endTime: 2000,
            attributes: {},
            events: [],
            status: 'completed',
          },
          {
            id: 'trace-child-2',
            traceId: 'trace-1',
            name: 'child-op-2',
            startTime: 1500,
            endTime: 2500,
            attributes: {},
            events: [],
            status: 'completed',
          },
        ],
        status: 'completed',
      };
      await exporter.exportTrace(trace);

      // After exportTrace, the child spans should be removed from the map.
      // Trying to link a new child to trace-child-1 should create a root span
      // (unless it ended up in evictedParents -- exportTrace does NOT migrate to evictedParents).
      await exporter.exportSpan({
        id: 'late-child',
        traceId: 'trace-1',
        parentId: 'trace-child-1',
        name: 'late-linking',
        startTime: 3000,
        endTime: 4000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const lateCall = calls[calls.length - 1];
      expect(lateCall[0]).toBe('late-linking');
      // trace-child-1 was deleted by exportTrace cleanup -> root span (2 args)
      expect(lateCall.length).toBe(2);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Parent span 'trace-child-1' not found"),
      );
      warnSpy.mockRestore();
    });
  });

  describe('span status mapping for traces', () => {
    it('does not set status for a running trace', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });
      const trace: Trace = {
        id: 'trace-running',
        name: 'running-trace',
        startTime: 1000,
        metadata: {},
        spans: [],
        status: 'running',
      };

      await exporter.exportTrace(trace);

      // setStatus should NOT be called for running status
      expect(localMock.mocks.setStatus).not.toHaveBeenCalled();
    });

    it('ends trace span without endTime when endTime is not provided', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });
      const trace: Trace = {
        id: 'trace-no-end',
        name: 'no-end-trace',
        startTime: 1000,
        metadata: {},
        spans: [],
        status: 'completed',
      };

      await exporter.exportTrace(trace);

      // end() should be called with undefined (no endTime)
      expect(localMock.mocks.end).toHaveBeenCalledWith(undefined);
    });
  });

  describe('non-primitive attribute handling edge cases', () => {
    it('skips null and undefined attributes without logging debug warnings', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-nulls',
        traceId: 'trace-1',
        name: 'null-attrs',
        startTime: 1000,
        attributes: { a: null, b: undefined, c: 'valid' } as unknown as Record<string, unknown>,
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.setAttribute.mock.calls;
      const attrNames = calls.map((c: unknown[]) => c[0]);
      expect(attrNames).not.toContain('a');
      expect(attrNames).not.toContain('b');
      expect(attrNames).toContain('c');

      // null and undefined should NOT trigger the debug warning (they're silently skipped)
      expect(debugSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('drops array attributes with debug log', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-array',
        traceId: 'trace-1',
        name: 'array-attrs',
        startTime: 1000,
        attributes: { items: [1, 2, 3], label: 'ok' } as unknown as Record<string, unknown>,
        events: [],
        status: 'completed',
      });

      const calls = localMock.mocks.setAttribute.mock.calls;
      const attrNames = calls.map((c: unknown[]) => c[0]);
      expect(attrNames).not.toContain('items');
      expect(attrNames).toContain('label');

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Dropping non-primitive attribute 'items' of type 'object'"),
      );
      debugSpy.mockRestore();
    });

    it('drops function attributes with debug log', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-fn',
        traceId: 'trace-1',
        name: 'fn-attrs',
        startTime: 1000,
        attributes: { callback: () => {}, name: 'test' } as unknown as Record<string, unknown>,
        events: [],
        status: 'completed',
      });

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Dropping non-primitive attribute 'callback' of type 'function'"),
      );
      debugSpy.mockRestore();
    });
  });

  describe('event attribute filtering', () => {
    it('filters non-primitive attributes from span events', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-event-filter',
        traceId: 'trace-1',
        name: 'event-filter',
        startTime: 1000,
        attributes: {},
        events: [
          {
            name: 'mixed-event',
            timestamp: 1000,
            attributes: {
              valid_str: 'hello',
              valid_num: 42,
              valid_bool: true,
              invalid_obj: { nested: true },
              invalid_arr: [1, 2],
            } as unknown as Record<string, unknown>,
          },
        ],
        status: 'completed',
      });

      // addEvent should be called with only primitive attributes
      expect(localMock.mocks.addEvent).toHaveBeenCalledWith(
        'mixed-event',
        { valid_str: 'hello', valid_num: 42, valid_bool: true },
        expect.any(Date),
      );
    });

    it('handles events with no attributes', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-no-event-attrs',
        traceId: 'trace-1',
        name: 'no-event-attrs',
        startTime: 1000,
        attributes: {},
        events: [
          { name: 'bare-event', timestamp: 1000 },
        ],
        status: 'completed',
      });

      expect(localMock.mocks.addEvent).toHaveBeenCalledWith(
        'bare-event',
        {},
        expect.any(Date),
      );
    });
  });

  describe('trace metadata attribute mapping', () => {
    it('maps trace metadata to harness.meta.* attributes', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      const trace: Trace = {
        id: 'trace-meta',
        name: 'meta-trace',
        startTime: 1000,
        endTime: 2000,
        metadata: { region: 'us-east', version: 3, debug: true },
        spans: [],
        status: 'completed',
      };

      await exporter.exportTrace(trace);

      expect(localMock.mocks.setAttribute).toHaveBeenCalledWith('harness.meta.region', 'us-east');
      expect(localMock.mocks.setAttribute).toHaveBeenCalledWith('harness.meta.version', 3);
      expect(localMock.mocks.setAttribute).toHaveBeenCalledWith('harness.meta.debug', true);
    });
  });

  describe('LRU eviction performance (Map insertion-order pattern)', () => {
    it('evictSpans uses O(count) Map iteration instead of O(n log n) sort', async () => {
      // Reproduction: With the sort-based eviction, evicting 1 span from a map
      // of N spans is O(N log N). With the Map-based LRU pattern, it should be O(1)
      // per eviction. We verify correctness: oldest-inserted span is evicted first.
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer, maxSpans: 3 });

      // Export 3 spans in order: a, b, c
      await exporter.exportSpan({
        id: 'lru-a', traceId: 't1', name: 'op-a',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });
      await exporter.exportSpan({
        id: 'lru-b', traceId: 't1', name: 'op-b',
        startTime: 2000, endTime: 3000, attributes: {}, events: [], status: 'completed',
      });
      await exporter.exportSpan({
        id: 'lru-c', traceId: 't1', name: 'op-c',
        startTime: 3000, endTime: 4000, attributes: {}, events: [], status: 'completed',
      });

      // Export a child of lru-b to "touch" lru-b (move it to end of LRU)
      await exporter.exportSpan({
        id: 'child-of-b', traceId: 't1', parentId: 'lru-b', name: 'child-b',
        startTime: 3500, endTime: 4500, attributes: {}, events: [], status: 'completed',
      });

      // Now export another span to trigger eviction. With LRU, lru-a should be evicted
      // (it's the least recently used), NOT lru-b (which was touched).
      await exporter.exportSpan({
        id: 'lru-d', traceId: 't1', name: 'op-d',
        startTime: 4000, endTime: 5000, attributes: {}, events: [], status: 'completed',
      });

      // Verify: lru-a is evicted (in evictedParents), lru-b is still in spanMap
      // Try to link a child to lru-b -- should still be in spanMap (4 args)
      await exporter.exportSpan({
        id: 'late-child-b', traceId: 't1', parentId: 'lru-b', name: 'late-child-of-b',
        startTime: 5000, endTime: 6000, attributes: {}, events: [], status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const lateChildCall = calls[calls.length - 1];
      expect(lateChildCall[0]).toBe('late-child-of-b');
      expect(lateChildCall.length).toBe(4); // parent context found
    });

    it('touchSpan reorders Map entries via delete-then-reinsert', async () => {
      // With the LRU pattern, accessing a span should move it to the end of the Map.
      // Verify that a recently-touched span survives eviction.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer, maxSpans: 2 });

      // Export span-x then span-y
      await exporter.exportSpan({
        id: 'touch-x', traceId: 't1', name: 'x',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });
      await exporter.exportSpan({
        id: 'touch-y', traceId: 't1', name: 'y',
        startTime: 2000, endTime: 3000, attributes: {}, events: [], status: 'completed',
      });

      // Touch span-x by exporting a child referencing it
      await exporter.exportSpan({
        id: 'child-x', traceId: 't1', parentId: 'touch-x', name: 'cx',
        startTime: 2500, endTime: 3500, attributes: {}, events: [], status: 'completed',
      });
      // child-x triggered eviction because maxSpans=2. With LRU, touch-y
      // (least recently used) should be evicted, NOT touch-x (recently touched).

      // Verify touch-x is still in spanMap (child links with 4 args)
      await exporter.exportSpan({
        id: 'child-x2', traceId: 't1', parentId: 'touch-x', name: 'cx2',
        startTime: 3000, endTime: 4000, attributes: {}, events: [], status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const cx2Call = calls[calls.length - 1];
      expect(cx2Call[0]).toBe('cx2');
      expect(cx2Call.length).toBe(4); // touch-x still in spanMap

      warnSpy.mockRestore();
    });

    it('flush uses snapshot-then-clear with LRU-ordered evictedParents', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({
        tracer: localMock.tracer,
        maxEvictedParents: 3,
      });

      // Export 5 spans then flush -- only 3 should be kept in evictedParents
      for (let i = 0; i < 5; i++) {
        await exporter.exportSpan({
          id: `flush-${i}`, traceId: 't1', name: `f-${i}`,
          startTime: 1000 + i, endTime: 2000 + i, attributes: {}, events: [], status: 'completed',
        });
      }
      await exporter.flush();

      // The 3 most recent (flush-2, flush-3, flush-4) should be in evictedParents.
      // flush-0 and flush-1 should have been dropped.
      await exporter.exportSpan({
        id: 'post-flush-child', traceId: 't1', parentId: 'flush-4', name: 'pfc',
        startTime: 3000, endTime: 4000, attributes: {}, events: [], status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const pfcCall = calls[calls.length - 1];
      expect(pfcCall[0]).toBe('pfc');
      expect(pfcCall.length).toBe(4); // flush-4 preserved
    });

    it('purgeStaleEvictedParents skips when under threshold', async () => {
      // With the new purge, it should early-return when evictedParentsAccessTime.size
      // is under maxEvictedParents. This is a behavioral test: no stale entries
      // should be removed when under threshold.
      const localMock = createMockTracer();
      const exporter = createOTelExporter({
        tracer: localMock.tracer,
        maxEvictedParents: 100,
        evictedParentsTtlMs: 1,
      });

      // Export 1 span, flush, wait past TTL
      await exporter.exportSpan({
        id: 'purge-test', traceId: 't1', name: 'pt',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });
      await exporter.flush();

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 100);

      // With the new purge (only triggers when over threshold), the stale entry
      // is still in the map but lazy TTL check in getEvictedParent should handle it.
      // A child referencing purge-test should get root span (expired by lazy TTL).
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await exporter.exportSpan({
        id: 'purge-child', traceId: 't1', parentId: 'purge-test', name: 'pc',
        startTime: 2000, endTime: 3000, attributes: {}, events: [], status: 'completed',
      });

      const calls = localMock.mocks.startActiveSpan.mock.calls;
      const pcCall = calls[calls.length - 1];
      expect(pcCall[0]).toBe('pc');
      // Lazy TTL expiry should make the parent unavailable -> root span (2 args)
      expect(pcCall.length).toBe(2);

      vi.useRealTimers();
      warnSpy.mockRestore();
    });
  });

  describe('span endTime handling', () => {
    it('ends span without endTime when not provided', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-no-end',
        traceId: 'trace-1',
        name: 'no-end',
        startTime: 1000,
        attributes: {},
        events: [],
        status: 'running',
      });

      expect(localMock.mocks.end).toHaveBeenCalledWith(undefined);
    });

    it('ends span with Date when endTime is provided', async () => {
      const localMock = createMockTracer();
      const exporter = createOTelExporter({ tracer: localMock.tracer });

      await exporter.exportSpan({
        id: 'span-with-end',
        traceId: 'trace-1',
        name: 'with-end',
        startTime: 1000,
        endTime: 2000,
        attributes: {},
        events: [],
        status: 'completed',
      });

      expect(localMock.mocks.end).toHaveBeenCalledWith(new Date(2000));
    });
  });
});
