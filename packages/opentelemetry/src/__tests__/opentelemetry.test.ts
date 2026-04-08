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

  it('skips non-primitive attributes', async () => {
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

  it('creates root span when parentId has no matching known span', async () => {
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
  });
});
