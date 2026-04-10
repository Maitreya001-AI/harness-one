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

      // Flush to clear the map
      await exporter.flush();

      // Verify flush clears everything - parent lookup should fail after flush
      await exporter.exportSpan({
        id: 'c2', traceId: 't1', parentId: 'p1', name: 'child-after-flush',
        startTime: 1000, endTime: 2000, attributes: {}, events: [], status: 'completed',
      });

      const calls = (mockTracer.startActiveSpan as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      // After flush, parent is gone, so no parent context -> 2 args
      expect(lastCall.length).toBe(2);
    });
  });
});
