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

  const startActiveSpanFn = vi.fn().mockImplementation((_name: string, fn: (span: OTelSpan) => void) => {
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
});
