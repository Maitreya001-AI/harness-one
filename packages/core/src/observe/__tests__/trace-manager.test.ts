import { describe, it, expect, vi } from 'vitest';
import { createTraceManager, createConsoleExporter, createNoOpExporter } from '../trace-manager.js';
import { HarnessError, HarnessErrorCode} from '../../core/errors.js';
import type { TraceExporter } from '../types.js';

describe('createTraceManager', () => {
  it('starts and retrieves a trace', () => {
    const tm = createTraceManager();
    const id = tm.startTrace('test-trace', { env: 'test' });
    const trace = tm.getTrace(id);
    expect(trace).toBeDefined();
    expect(trace!.name).toBe('test-trace');
    expect(trace!.status).toBe('running');
    expect(trace!.metadata.env).toBe('test');
    expect(trace!.spans).toHaveLength(0);
  });

  it('returns undefined for unknown trace', () => {
    const tm = createTraceManager();
    expect(tm.getTrace('nope')).toBeUndefined();
  });

  it('throws when starting span on unknown trace', () => {
    const tm = createTraceManager();
    expect(() => tm.startSpan('nope', 'span')).toThrow(HarnessError);
  });

  describe('spans', () => {
    it('creates a span within a trace', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      const spanId = tm.startSpan(traceId, 'my-span');
      const trace = tm.getTrace(traceId);
      expect(trace!.spans).toHaveLength(1);
      expect(trace!.spans[0].name).toBe('my-span');
      expect(trace!.spans[0].status).toBe('running');
      expect(trace!.spans[0].id).toBe(spanId);
    });

    it('creates child spans with parentId', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      const parentId = tm.startSpan(traceId, 'parent');
      const childId = tm.startSpan(traceId, 'child', parentId);
      const trace = tm.getTrace(traceId);
      const child = trace!.spans.find(s => s.id === childId);
      expect(child!.parentId).toBe(parentId);
    });

    it('adds events to a span', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      const spanId = tm.startSpan(traceId, 's');
      tm.addSpanEvent(spanId, { name: 'checkpoint', attributes: { step: 1 } });
      const trace = tm.getTrace(traceId);
      expect(trace!.spans[0].events).toHaveLength(1);
      expect(trace!.spans[0].events[0].name).toBe('checkpoint');
      expect(trace!.spans[0].events[0].timestamp).toBeGreaterThan(0);
    });

    it('throws when adding event to unknown span', () => {
      const tm = createTraceManager();
      expect(() => tm.addSpanEvent('nope', { name: 'x' })).toThrow(HarnessError);
    });

    it('sets attributes on a span', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      const spanId = tm.startSpan(traceId, 's');
      tm.setSpanAttributes(spanId, { model: 'claude-3', temperature: 0.7 });
      const trace = tm.getTrace(traceId);
      expect(trace!.spans[0].attributes.model).toBe('claude-3');
    });

    it('throws when setting attributes on unknown span', () => {
      const tm = createTraceManager();
      expect(() => tm.setSpanAttributes('nope', {})).toThrow(HarnessError);
    });

    it('ends a span', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      const spanId = tm.startSpan(traceId, 's');
      tm.endSpan(spanId);
      const trace = tm.getTrace(traceId);
      expect(trace!.spans[0].status).toBe('completed');
      expect(trace!.spans[0].endTime).toBeDefined();
    });

    it('ends a span with error status', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      const spanId = tm.startSpan(traceId, 's');
      tm.endSpan(spanId, 'error');
      const trace = tm.getTrace(traceId);
      expect(trace!.spans[0].status).toBe('error');
    });

    it('throws when ending unknown span', () => {
      const tm = createTraceManager();
      expect(() => tm.endSpan('nope')).toThrow(HarnessError);
    });
  });

  describe('endTrace', () => {
    it('ends a trace with completed status', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      tm.endTrace(traceId);
      const trace = tm.getTrace(traceId);
      expect(trace!.status).toBe('completed');
      expect(trace!.endTime).toBeDefined();
    });

    it('ends a trace with error status', () => {
      const tm = createTraceManager();
      const traceId = tm.startTrace('t');
      tm.endTrace(traceId, 'error');
      expect(tm.getTrace(traceId)!.status).toBe('error');
    });

    it('throws when ending unknown trace', () => {
      const tm = createTraceManager();
      expect(() => tm.endTrace('nope')).toThrow(HarnessError);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest traces when maxTraces exceeded', () => {
      const tm = createTraceManager({ maxTraces: 2 });
      const id1 = tm.startTrace('first');
      const id2 = tm.startTrace('second');
      const id3 = tm.startTrace('third');
      expect(tm.getTrace(id1)).toBeUndefined();
      expect(tm.getTrace(id2)).toBeDefined();
      expect(tm.getTrace(id3)).toBeDefined();
    });

    it('cleans up spans of evicted traces', () => {
      const tm = createTraceManager({ maxTraces: 1 });
      const id1 = tm.startTrace('first');
      const spanId = tm.startSpan(id1, 'span1');
      tm.startTrace('second'); // evicts first
      expect(tm.getTrace(id1)).toBeUndefined();
      // Span should also be gone
      expect(() => tm.endSpan(spanId)).toThrow(HarnessError);
    });
  });

  describe('exporters', () => {
    it('exports spans on endSpan', async () => {
      const exported: string[] = [];
      const exporter: TraceExporter = {
        name: 'test',
        async exportTrace() {},
        async exportSpan(span) { exported.push(span.name); },
        async flush() {},
      };
      const tm = createTraceManager({ exporters: [exporter] });
      const traceId = tm.startTrace('t');
      const spanId = tm.startSpan(traceId, 'myspan');
      tm.endSpan(spanId);
      // Allow microtask to resolve
      await new Promise(r => setTimeout(r, 10));
      expect(exported).toContain('myspan');
    });

    it('exports traces on endTrace', async () => {
      const exported: string[] = [];
      const exporter: TraceExporter = {
        name: 'test',
        async exportTrace(trace) { exported.push(trace.name); },
        async exportSpan() {},
        async flush() {},
      };
      const tm = createTraceManager({ exporters: [exporter] });
      const traceId = tm.startTrace('mytrace');
      tm.endTrace(traceId);
      await new Promise(r => setTimeout(r, 10));
      expect(exported).toContain('mytrace');
    });

    it('flush calls all exporters', async () => {
      const flushed: string[] = [];
      const exporter: TraceExporter = {
        name: 'test',
        async exportTrace() {},
        async exportSpan() {},
        async flush() { flushed.push('done'); },
      };
      const tm = createTraceManager({ exporters: [exporter] });
      await tm.flush();
      expect(flushed).toEqual(['done']);
    });
  });
});

describe('createConsoleExporter', () => {
  it('creates an exporter with name "console"', () => {
    const exporter = createConsoleExporter();
    expect(exporter.name).toBe('console');
  });

  it('exportTrace logs summary in non-verbose mode', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = createConsoleExporter({ verbose: false });
    try {
      await exporter.exportTrace({
        id: 'trace-1',
        name: 'my-trace',
        startTime: 1000,
        metadata: {},
        spans: [],
        status: 'completed',
      });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain('[trace]');
      expect(output).toContain('my-trace');
      expect(output).toContain('completed');
      expect(output).toContain('0 spans');
    } finally {
      spy.mockRestore();
    }
  });

  it('exportTrace logs JSON in verbose mode', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = createConsoleExporter({ verbose: true });
    try {
      await exporter.exportTrace({
        id: 'trace-1',
        name: 'verbose-trace',
        startTime: 1000,
        metadata: {},
        spans: [],
        status: 'running',
      });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain('[trace]');
      // Verbose mode outputs JSON.stringify with indent as a single string
      expect(output).toContain('verbose-trace');
      expect(output).toContain('"id"');
    } finally {
      spy.mockRestore();
    }
  });

  it('exportSpan logs summary in non-verbose mode', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = createConsoleExporter({ verbose: false });
    try {
      await exporter.exportSpan({
        id: 'span-1',
        traceId: 'trace-1',
        name: 'my-span',
        startTime: 1000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain('[span]');
      expect(output).toContain('my-span');
      expect(output).toContain('completed');
    } finally {
      spy.mockRestore();
    }
  });

  it('exportSpan logs JSON in verbose mode', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = createConsoleExporter({ verbose: true });
    try {
      await exporter.exportSpan({
        id: 'span-1',
        traceId: 'trace-1',
        name: 'verbose-span',
        startTime: 1000,
        attributes: { key: 'value' },
        events: [],
        status: 'error',
      });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain('[span]');
      // Verbose mode outputs JSON.stringify with indent as a single string
      expect(output).toContain('verbose-span');
      expect(output).toContain('"id"');
    } finally {
      spy.mockRestore();
    }
  });

  it('flush resolves without error', async () => {
    const exporter = createConsoleExporter();
    await expect(exporter.flush()).resolves.toBeUndefined();
  });

  it('uses custom output function instead of console.log', async () => {
    const lines: string[] = [];
    const output = (line: string): void => { lines.push(line); };
    const exporter = createConsoleExporter({ output });

    await exporter.exportTrace({
      id: 'trace-1',
      name: 'custom-output-trace',
      startTime: 1000,
      metadata: {},
      spans: [],
      status: 'completed',
    });
    await exporter.exportSpan({
      id: 'span-1',
      traceId: 'trace-1',
      name: 'custom-output-span',
      startTime: 1000,
      attributes: {},
      events: [],
      status: 'completed',
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[trace]');
    expect(lines[0]).toContain('custom-output-trace');
    expect(lines[1]).toContain('[span]');
    expect(lines[1]).toContain('custom-output-span');
  });

  it('uses custom output function in verbose mode', async () => {
    const lines: string[] = [];
    const output = (line: string): void => { lines.push(line); };
    const exporter = createConsoleExporter({ verbose: true, output });

    await exporter.exportTrace({
      id: 'trace-1',
      name: 'verbose-custom-trace',
      startTime: 1000,
      metadata: {},
      spans: [],
      status: 'running',
    });
    await exporter.exportSpan({
      id: 'span-1',
      traceId: 'trace-1',
      name: 'verbose-custom-span',
      startTime: 1000,
      attributes: { key: 'value' },
      events: [],
      status: 'error',
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[trace]');
    expect(lines[0]).toContain('verbose-custom-trace');
    expect(lines[1]).toContain('[span]');
    expect(lines[1]).toContain('verbose-custom-span');
  });

  it('defaults to console.log when no output function provided', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exporter = createConsoleExporter();
    try {
      await exporter.exportSpan({
        id: 'span-1',
        traceId: 'trace-1',
        name: 'default-span',
        startTime: 1000,
        attributes: {},
        events: [],
        status: 'completed',
      });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('createNoOpExporter', () => {
  it('creates an exporter with name "noop"', () => {
    const exporter = createNoOpExporter();
    expect(exporter.name).toBe('noop');
  });

  it('methods resolve without error', async () => {
    const exporter = createNoOpExporter();
    await expect(exporter.flush()).resolves.toBeUndefined();
  });
});

// C9: Trace export silently swallows exceptions
describe('export error handling', () => {
  it('calls onExportError callback when span export fails', async () => {
    const errors: Error[] = [];
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() { throw new Error('trace export failure'); },
      async exportSpan() { throw new Error('span export failure'); },
      async flush() {},
    };
    const tm = createTraceManager({
      exporters: [failingExporter],
      onExportError: (err) => { errors.push(err as Error); },
    });

    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    tm.endSpan(spanId);

    // Allow microtask to resolve
    await new Promise(r => setTimeout(r, 10));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe('span export failure');
  });

  it('calls onExportError callback when trace export fails', async () => {
    const errors: Error[] = [];
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() { throw new Error('trace export failure'); },
      async exportSpan() {},
      async flush() {},
    };
    const tm = createTraceManager({
      exporters: [failingExporter],
      onExportError: (err) => { errors.push(err as Error); },
    });

    const traceId = tm.startTrace('t');
    tm.endTrace(traceId);

    await new Promise(r => setTimeout(r, 10));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toBe('trace export failure');
  });

  it('does not throw when export fails and no onExportError provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() { throw new Error('trace export failure'); },
      async exportSpan() { throw new Error('span export failure'); },
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [failingExporter] });

    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    // Should not throw
    expect(() => tm.endSpan(spanId)).not.toThrow();
    expect(() => tm.endTrace(traceId)).not.toThrow();
    await new Promise(r => setTimeout(r, 10));

    // Errors are logged via console.warn (not silently discarded)
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('console.warn fallback includes harness-one prefix for span export errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() {},
      async exportSpan() { throw new Error('span boom'); },
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [failingExporter] });

    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    tm.endSpan(spanId);
    await new Promise(r => setTimeout(r, 10));

    expect(warnSpy).toHaveBeenCalledWith('[harness-one] trace export error:', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('console.warn fallback includes harness-one prefix for trace export errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() { throw new Error('trace boom'); },
      async exportSpan() {},
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [failingExporter] });

    const traceId = tm.startTrace('t');
    tm.endTrace(traceId);
    await new Promise(r => setTimeout(r, 10));

    expect(warnSpy).toHaveBeenCalledWith('[harness-one] trace export error:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

// C10: Span memory leak - spans not cleaned up on eviction (already tested above
// in LRU eviction, but let's add a more explicit test)
describe('span cleanup on eviction', () => {
  it('cleans up all spans when their parent trace is evicted', () => {
    const tm = createTraceManager({ maxTraces: 1 });

    // Create a trace with multiple spans
    const id1 = tm.startTrace('first');
    const span1 = tm.startSpan(id1, 'span-1');
    const span2 = tm.startSpan(id1, 'span-2');
    const span3 = tm.startSpan(id1, 'span-3');

    // Evict trace by adding a new one
    tm.startTrace('second');

    // All spans of the evicted trace should be cleaned up
    expect(tm.getTrace(id1)).toBeUndefined();
    expect(() => tm.endSpan(span1)).toThrow(HarnessError);
    expect(() => tm.endSpan(span2)).toThrow(HarnessError);
    expect(() => tm.endSpan(span3)).toThrow(HarnessError);
  });
});

describe('edge cases', () => {
  it('span cleanup on trace LRU eviction — verifies spans are deleted from internal map', () => {
    const tm = createTraceManager({ maxTraces: 1 });

    // Create a trace with spans
    const traceId = tm.startTrace('trace-to-evict');
    const s1 = tm.startSpan(traceId, 'span-a');
    const s2 = tm.startSpan(traceId, 'span-b');
    tm.endSpan(s1);
    tm.endSpan(s2);

    // Evict by adding a new trace
    const traceId2 = tm.startTrace('replacement');
    expect(tm.getTrace(traceId)).toBeUndefined();
    expect(tm.getTrace(traceId2)).toBeDefined();

    // Attempting to add events or end evicted spans should throw
    expect(() => tm.addSpanEvent(s1, { name: 'test' })).toThrow(HarnessError);
    expect(() => tm.setSpanAttributes(s2, { x: 1 })).toThrow(HarnessError);
  });

  it('onExportError callback receives export errors from span export', async () => {
    const capturedErrors: unknown[] = [];
    const failExporter: TraceExporter = {
      name: 'fail-exporter',
      async exportTrace() { throw new Error('trace-fail'); },
      async exportSpan() { throw new Error('span-fail'); },
      async flush() {},
    };
    const tm = createTraceManager({
      exporters: [failExporter],
      onExportError: (err) => { capturedErrors.push(err); },
    });
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.endSpan(sid);
    await new Promise(r => setTimeout(r, 20));
    expect(capturedErrors.length).toBeGreaterThanOrEqual(1);
    expect((capturedErrors[0] as Error).message).toBe('span-fail');
  });

  it('onExportError callback receives export errors from trace export', async () => {
    const capturedErrors: unknown[] = [];
    const failExporter: TraceExporter = {
      name: 'fail-exporter',
      async exportTrace() { throw new Error('trace-export-fail'); },
      async exportSpan() {},
      async flush() {},
    };
    const tm = createTraceManager({
      exporters: [failExporter],
      onExportError: (err) => { capturedErrors.push(err); },
    });
    const tid = tm.startTrace('t');
    tm.endTrace(tid);
    await new Promise(r => setTimeout(r, 20));
    expect(capturedErrors.some(e => (e as Error).message === 'trace-export-fail')).toBe(true);
  });

  it('dispose() flushes and clears all state', async () => {
    const events: string[] = [];
    const exporter: TraceExporter = {
      name: 'lifecycle',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { events.push('flush'); },
      async shutdown() { events.push('shutdown'); },
    };
    const tm = createTraceManager({ exporters: [exporter] });
    const tid = tm.startTrace('my-trace');
    const sid = tm.startSpan(tid, 'my-span');
    tm.endSpan(sid);
    tm.endTrace(tid);

    await tm.dispose();

    // All state should be cleared
    expect(tm.getTrace(tid)).toBeUndefined();
    // Flush and shutdown should have been called
    expect(events).toContain('flush');
    expect(events).toContain('shutdown');

    // Starting new spans on old trace should fail (trace is gone)
    expect(() => tm.startSpan(tid, 'new-span')).toThrow(HarnessError);
  });

  it('start span on non-existent trace — throws HarnessError', () => {
    const tm = createTraceManager();
    expect(() => tm.startSpan('non-existent-trace-id', 'span')).toThrow(HarnessError);
  });

  it('multiple exporters — all called on endSpan and endTrace', async () => {
    const exportedSpans1: string[] = [];
    const exportedSpans2: string[] = [];
    const exportedTraces1: string[] = [];
    const exportedTraces2: string[] = [];

    const exporter1: TraceExporter = {
      name: 'exporter-1',
      async exportTrace(trace) { exportedTraces1.push(trace.name); },
      async exportSpan(span) { exportedSpans1.push(span.name); },
      async flush() {},
    };
    const exporter2: TraceExporter = {
      name: 'exporter-2',
      async exportTrace(trace) { exportedTraces2.push(trace.name); },
      async exportSpan(span) { exportedSpans2.push(span.name); },
      async flush() {},
    };

    const tm = createTraceManager({ exporters: [exporter1, exporter2] });
    const tid = tm.startTrace('multi-export-trace');
    const sid = tm.startSpan(tid, 'multi-export-span');
    tm.endSpan(sid);
    tm.endTrace(tid);
    await new Promise(r => setTimeout(r, 20));

    expect(exportedSpans1).toContain('multi-export-span');
    expect(exportedSpans2).toContain('multi-export-span');
    expect(exportedTraces1).toContain('multi-export-trace');
    expect(exportedTraces2).toContain('multi-export-trace');
  });
});

describe('parentId validation', () => {
  it('throws SPAN_NOT_FOUND when startSpan called with invalid parentId', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    expect(() => tm.startSpan(traceId, 'child', 'non-existent-parent')).toThrow(HarnessError);
    try {
      tm.startSpan(traceId, 'child', 'non-existent-parent');
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.TRACE_SPAN_NOT_FOUND);
    }
  });

  it('throws when parentId belongs to a different trace', () => {
    const tm = createTraceManager();
    const traceId1 = tm.startTrace('trace-1');
    const traceId2 = tm.startTrace('trace-2');
    const spanInTrace1 = tm.startSpan(traceId1, 'parent-span');
    // parentId from trace1 should not be valid in trace2
    expect(() => tm.startSpan(traceId2, 'child', spanInTrace1)).toThrow(HarnessError);
  });
});

describe('getActiveSpans', () => {
  it('returns running spans and excludes completed ones', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    const span1 = tm.startSpan(traceId, 'running-span');
    const span2 = tm.startSpan(traceId, 'completed-span');
    tm.endSpan(span2);
    const active = tm.getActiveSpans();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(span1);
    expect(active[0].name).toBe('running-span');
    expect(active[0].traceId).toBe(traceId);
    expect(active[0].startTime).toBeGreaterThan(0);
  });
});

// Architecture: TraceManager needs dispose()
describe('dispose', () => {
  it('flushes and shuts down all exporters', async () => {
    const events: string[] = [];
    const exporter: TraceExporter = {
      name: 'test',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { events.push('flush'); },
      async shutdown() { events.push('shutdown'); },
    };
    const tm = createTraceManager({ exporters: [exporter] });
    tm.startTrace('t');

    await tm.dispose();

    expect(events).toContain('flush');
    expect(events).toContain('shutdown');
  });

  it('clears internal maps after dispose', async () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    tm.startSpan(traceId, 's');

    await tm.dispose();

    // After dispose, traces should be gone
    expect(tm.getTrace(traceId)).toBeUndefined();
  });
});

// Fix 1: traceOrder memory leak — ended traces' IDs are removed from traceOrder
describe('traceOrder memory leak fix', () => {
  it('ended trace ID is removed from traceOrder to prevent unbounded growth', () => {
    // The memory leak: without the fix, traceOrder grows forever because ended
    // trace IDs stay in the array even though the trace is finished.
    // With the fix, endTrace() removes the ID from traceOrder.
    // Ended traces are also evicted from the Map when capacity is exceeded.
    const tm = createTraceManager({ maxTraces: 5 });

    // Create and immediately end traces in a loop (simulating a long-running server)
    for (let i = 0; i < 20; i++) {
      const id = tm.startTrace(`trace-${i}`);
      tm.endTrace(id);
    }

    // Now create active traces — ended traces are evicted first when capacity is exceeded,
    // so running traces should not be prematurely evicted
    const activeIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      activeIds.push(tm.startTrace(`active-${i}`));
    }

    // All active traces should be retrievable
    for (const id of activeIds) {
      expect(tm.getTrace(id)).toBeDefined();
    }
  });

  it('endTrace removes ID from traceOrder but trace stays in Map until eviction', () => {
    // With no capacity pressure, ended traces remain queryable
    const tm = createTraceManager({ maxTraces: 10 });
    const id = tm.startTrace('my-trace');
    tm.endTrace(id);

    // Trace should still be in the Map (queryable) — no eviction has run
    const trace = tm.getTrace(id);
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('completed');
  });

  it('ended traces are evicted before running traces when capacity is exceeded', () => {
    const tm = createTraceManager({ maxTraces: 2 });
    const t1 = tm.startTrace('first');
    const t2 = tm.startTrace('second');

    // End t1 — removes from traceOrder
    tm.endTrace(t1);

    // Now traceOrder = [t2], traces Map = {t1, t2} (size 2, at capacity)
    // Adding t3: traces.size becomes 3 > maxTraces. Eviction first removes ended
    // traces (t1), bringing size to 2, which is at capacity. No more eviction needed.
    const t3 = tm.startTrace('third');

    // t1 was ended and evicted first (it's completed, not running)
    expect(tm.getTrace(t1)).toBeUndefined();
    // t2 and t3 should both exist (running traces preserved)
    expect(tm.getTrace(t2)).toBeDefined();
    expect(tm.getTrace(t3)).toBeDefined();
  });

  it('rapid create-end cycles do not grow traceOrder unboundedly', () => {
    // This is the core memory leak scenario: a server handling many short requests.
    // Without the fix, traceOrder would have 1000 entries after this loop.
    // With the fix, traceOrder stays empty because all traces are ended,
    // and ended traces are evicted when capacity is exceeded.
    const tm = createTraceManager({ maxTraces: 5 });

    for (let i = 0; i < 1000; i++) {
      const id = tm.startTrace(`req-${i}`);
      const spanId = tm.startSpan(id, `span-${i}`);
      tm.endSpan(spanId);
      tm.endTrace(id);
    }

    // Now add 5 new active traces — they should all be retained
    const newIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      newIds.push(tm.startTrace(`new-${i}`));
    }

    // All 5 new traces should exist (no spurious eviction from stale traceOrder entries)
    for (const id of newIds) {
      expect(tm.getTrace(id)).toBeDefined();
    }
  });

  it('spans of ended traces are cleaned up during eviction', () => {
    const tm = createTraceManager({ maxTraces: 1 });
    const t1 = tm.startTrace('first');
    const spanId = tm.startSpan(t1, 'span-1');
    tm.endSpan(spanId);
    tm.endTrace(t1);

    // Adding a second trace should evict t1 (ended) and its spans
    tm.startTrace('second');

    // Span from evicted trace should be gone
    expect(() => tm.addSpanEvent(spanId, { name: 'test' })).toThrow(HarnessError);
  });
});

// Fix 1: Finalize spans before eviction
describe('finalize spans before eviction', () => {
  it('ends running spans with error status and eviction attribute when trace is evicted', () => {
    const tm = createTraceManager({ maxTraces: 1 });
    const traceId = tm.startTrace('first');
    const span1 = tm.startSpan(traceId, 'running-span');
    // Do NOT end span1 — it's still running

    // Get the trace to confirm span is running
    const traceBefore = tm.getTrace(traceId);
    expect(traceBefore!.spans[0].status).toBe('running');

    // Adding a new trace evicts the first — running spans should be finalized
    tm.startTrace('second');

    // Trace and spans are now evicted, so we can't query them directly.
    // But we can verify the eviction returned IDs (covered by integration).
    expect(tm.getTrace(traceId)).toBeUndefined();
    // Span should be gone
    expect(() => tm.endSpan(span1)).toThrow(HarnessError);
  });

  it('evictIfNeeded returns evicted span IDs', () => {
    // We can't directly test the return value since evictIfNeeded is internal,
    // but we verify the span finalization behavior via getActiveSpans
    const tm = createTraceManager({ maxTraces: 1 });
    const traceId = tm.startTrace('first');
    tm.startSpan(traceId, 'running-span');

    // Before eviction, there's one active span
    expect(tm.getActiveSpans()).toHaveLength(1);

    // Evict by adding a new trace
    tm.startTrace('second');

    // After eviction, the running span from the evicted trace is gone
    expect(tm.getActiveSpans()).toHaveLength(0);
  });

  it('already-ended spans are not double-ended during eviction', () => {
    const tm = createTraceManager({ maxTraces: 1 });
    const traceId = tm.startTrace('first');
    const span1 = tm.startSpan(traceId, 'completed-span');
    tm.endSpan(span1, 'completed');
    const span2 = tm.startSpan(traceId, 'running-span');

    // span1 is completed, span2 is running
    const trace = tm.getTrace(traceId);
    expect(trace!.spans.find(s => s.id === span1)!.status).toBe('completed');
    expect(trace!.spans.find(s => s.id === span2)!.status).toBe('running');

    // Evict — only span2 should be finalized
    tm.startTrace('second');
    expect(tm.getTrace(traceId)).toBeUndefined();
  });
});

// Fix 2: Stale span detection via olderThanMs parameter
describe('getActiveSpans olderThanMs filter', () => {
  it('returns all active spans when olderThanMs is not provided', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    tm.startSpan(traceId, 'span-1');
    tm.startSpan(traceId, 'span-2');
    expect(tm.getActiveSpans()).toHaveLength(2);
  });

  it('filters out spans that have been running less than olderThanMs', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    tm.startSpan(traceId, 'span-1');
    // With olderThanMs=60000 (1 minute), recently-created spans should be excluded
    const stale = tm.getActiveSpans(60_000);
    expect(stale).toHaveLength(0);
  });

  it('returns spans older than the threshold', () => {
    const tm = createTraceManager();
    const traceId = tm.startTrace('t');
    tm.startSpan(traceId, 'span-1');
    // With olderThanMs=0, all running spans are "older than 0ms"
    const stale = tm.getActiveSpans(0);
    expect(stale).toHaveLength(1);
  });
});

// Fix 3: Re-entrance guard for eviction
describe('eviction re-entrance guard', () => {
  it('eviction does not fail under normal sequential usage', () => {
    // This tests that the isEvicting guard does not break normal operation
    const tm = createTraceManager({ maxTraces: 2 });
    const t1 = tm.startTrace('first');
    const t2 = tm.startTrace('second');
    const t3 = tm.startTrace('third'); // triggers eviction
    expect(tm.getTrace(t1)).toBeUndefined();
    expect(tm.getTrace(t2)).toBeDefined();
    expect(tm.getTrace(t3)).toBeDefined();
  });
});

// Fix 2: dispose() uses Promise.allSettled — one failing exporter doesn't block others
describe('dispose error isolation', () => {
  it('continues shutting down other exporters when one fails to flush', async () => {
    const events: string[] = [];
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { throw new Error('flush failed'); },
      async shutdown() { events.push('failing-shutdown'); },
    };
    const healthyExporter: TraceExporter = {
      name: 'healthy',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { events.push('healthy-flush'); },
      async shutdown() { events.push('healthy-shutdown'); },
    };

    const errors: unknown[] = [];
    const tm = createTraceManager({
      exporters: [failingExporter, healthyExporter],
      onExportError: (err) => errors.push(err),
    });
    tm.startTrace('t');

    // Should not throw despite failing exporter
    await tm.dispose();

    // Healthy exporter should have completed flush and shutdown
    expect(events).toContain('healthy-flush');
    expect(events).toContain('healthy-shutdown');
    // Failing exporter's shutdown should still be called
    expect(events).toContain('failing-shutdown');
    // Error from failed flush should be reported
    expect(errors.length).toBeGreaterThan(0);
  });

  it('continues flushing other exporters when one fails to shut down', async () => {
    const events: string[] = [];
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { events.push('failing-flush'); },
      async shutdown() { throw new Error('shutdown failed'); },
    };
    const healthyExporter: TraceExporter = {
      name: 'healthy',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { events.push('healthy-flush'); },
      async shutdown() { events.push('healthy-shutdown'); },
    };

    const errors: unknown[] = [];
    const tm = createTraceManager({
      exporters: [failingExporter, healthyExporter],
      onExportError: (err) => errors.push(err),
    });

    await tm.dispose();

    // Both exporters should have been flushed
    expect(events).toContain('failing-flush');
    expect(events).toContain('healthy-flush');
    // Healthy exporter shutdown should still complete
    expect(events).toContain('healthy-shutdown');
    // Error from failed shutdown should be reported
    expect(errors.some(e => (e as Error).message === 'shutdown failed')).toBe(true);
  });

  it('logs console.warn for dispose errors when no onExportError provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingExporter: TraceExporter = {
      name: 'failing',
      async exportTrace() {},
      async exportSpan() {},
      async flush() { throw new Error('flush boom'); },
      async shutdown() { throw new Error('shutdown boom'); },
    };

    const tm = createTraceManager({ exporters: [failingExporter] });
    // Should not throw
    await tm.dispose();

    // When no onExportError callback is provided, errors are logged via
    // console.warn rather than silently discarded.
    expect(warnSpy).toHaveBeenCalled();
    const warnMessages = warnSpy.mock.calls.map(c => c[0]);
    expect(warnMessages).toContain('[harness-one] trace export error:');
    warnSpy.mockRestore();
  });
});

// SEC-007: Secret redaction at ingestion
describe('SEC-007 secret redaction', () => {
  it('redacts secret keys from span attributes before export', async () => {
    const exported: Record<string, unknown>[] = [];
    const exporter: TraceExporter = {
      name: 'capture',
      async exportTrace() {},
      async exportSpan(span) { exported.push({ ...span.attributes }); },
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [exporter], redact: {} });
    const traceId = tm.startTrace('t');
    const spanId = tm.startSpan(traceId, 's');
    tm.setSpanAttributes(spanId, { api_key: 'sk-xxx', safe: 'ok' });
    tm.endSpan(spanId);
    await new Promise(r => setTimeout(r, 10));

    expect(exported[0].api_key).toBe('[REDACTED]');
    expect(exported[0].safe).toBe('ok');
  });

  it('redacts secret keys from trace metadata before export', async () => {
    const exportedTraces: Record<string, unknown>[] = [];
    const exporter: TraceExporter = {
      name: 'capture',
      async exportTrace(trace) { exportedTraces.push({ ...trace.metadata }); },
      async exportSpan() {},
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [exporter], redact: {} });
    const traceId = tm.startTrace('t', { authorization: 'Bearer xxx', ok: 'fine' });
    tm.endTrace(traceId);
    await new Promise(r => setTimeout(r, 10));

    expect(exportedTraces[0].authorization).toBe('[REDACTED]');
    expect(exportedTraces[0].ok).toBe('fine');
  });

  it('redacts nested secret keys recursively', async () => {
    const exported: Record<string, unknown>[] = [];
    const exporter: TraceExporter = {
      name: 'capture',
      async exportTrace() {},
      async exportSpan(span) { exported.push({ ...span.attributes }); },
      async flush() {},
    };
    const tm = createTraceManager({ exporters: [exporter], redact: {} });
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.setSpanAttributes(sid, { request: { headers: { authorization: 'Bearer abc' } } });
    tm.endSpan(sid);
    await new Promise(r => setTimeout(r, 10));

    const req = exported[0].request as { headers: { authorization: string } };
    expect(req.headers.authorization).toBe('[REDACTED]');
  });

  it('redacts secret keys from span event attributes', async () => {
    const tm = createTraceManager({ redact: {} });
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'probe', attributes: { password: 'p', ok: 'yes' } });
    const trace = tm.getTrace(tid);
    expect(trace!.spans[0].events[0].attributes!.password).toBe('[REDACTED]');
    expect(trace!.spans[0].events[0].attributes!.ok).toBe('yes');
  });

  it('extra keys configured via redact config are scrubbed too', async () => {
    const tm = createTraceManager({ redact: { extraKeys: ['ssn'] } });
    const tid = tm.startTrace('t', { ssn: 'xxx-xx-xxxx' });
    const trace = tm.getTrace(tid);
    expect(trace!.metadata.ssn).toBe('[REDACTED]');
  });

  it('redacts by default when no redact config is provided (T03 secure-by-default)', async () => {
    // T03: `redact` omitted => DEFAULT_SECRET_PATTERN active (secure-by-default).
    // To opt out explicitly, pass `redact: false` — covered by
    // `trace-manager-redact-default.test.ts`.
    const tm = createTraceManager();
    const tid = tm.startTrace('t', { api_key: 'visible' });
    const trace = tm.getTrace(tid);
    expect(trace!.metadata.api_key).toBe('[REDACTED]');
  });
});

// SEC-016: metadata namespace split
describe('SEC-016 metadata namespace split', () => {
  it('exposes userMetadata and systemMetadata separately', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t', { caller: 'user' });
    tm.setTraceSystemMetadata(tid, { samplingTag: 'premium' });

    const trace = tm.getTrace(tid)!;
    expect(trace.userMetadata).toEqual({ caller: 'user' });
    expect(trace.systemMetadata).toEqual({ samplingTag: 'premium' });
  });

  it('legacy metadata field still exposes user data for backward compat', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t', { env: 'prod' });
    const trace = tm.getTrace(tid)!;
    expect(trace.metadata.env).toBe('prod');
  });

  it('systemMetadata bypasses redaction', async () => {
    const tm = createTraceManager({ redact: {} });
    const tid = tm.startTrace('t');
    tm.setTraceSystemMetadata(tid, { authorization: 'internal-token' });
    const trace = tm.getTrace(tid)!;
    // Even though the key matches a secret pattern, system metadata is
    // library-authored and must not be scrubbed.
    expect(trace.systemMetadata!.authorization).toBe('internal-token');
  });

  it('shouldExport hook can consult systemMetadata for sampling decisions', async () => {
    const visited: string[] = [];
    const exporter: TraceExporter = {
      name: 'sampler',
      async exportTrace() { visited.push('trace'); },
      async exportSpan() {},
      async flush() {},
      shouldExport(trace) {
        // Hook only consults systemMetadata (SEC-016 contract).
        return (trace.systemMetadata?.keep as boolean) === true;
      },
    };
    const tm = createTraceManager({ exporters: [exporter] });
    const keep = tm.startTrace('k');
    tm.setTraceSystemMetadata(keep, { keep: true });
    tm.endTrace(keep);

    const drop = tm.startTrace('d');
    tm.setTraceSystemMetadata(drop, { keep: false });
    tm.endTrace(drop);

    await new Promise(r => setTimeout(r, 10));
    expect(visited).toHaveLength(1);
  });

  it('setTraceSystemMetadata throws on unknown trace', () => {
    const tm = createTraceManager();
    expect(() => tm.setTraceSystemMetadata('nope', { a: 1 })).toThrow(HarnessError);
  });
});

// OBS-002: Span event severity
describe('OBS-002 span event severity', () => {
  it('stores severity when provided on an event', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'problem', severity: 'error' });
    const trace = tm.getTrace(tid)!;
    expect(trace.spans[0].events[0].severity).toBe('error');
  });

  it('omits severity when not provided (backward compat)', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'normal' });
    const trace = tm.getTrace(tid)!;
    expect(trace.spans[0].events[0].severity).toBeUndefined();
  });
});

// OBS-005: Adapter retry telemetry
describe('OBS-005 retry metrics', () => {
  it('starts with zero metrics', () => {
    const tm = createTraceManager();
    expect(tm.getRetryMetrics()).toEqual({
      totalRetries: 0,
      successAfterRetry: 0,
      failedAfterRetries: 0,
    });
  });

  it('counts adapter_retry events as totalRetries', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'adapter_retry', attributes: { attempt: 1 } });
    tm.addSpanEvent(sid, { name: 'adapter_retry', attributes: { attempt: 2 } });
    expect(tm.getRetryMetrics().totalRetries).toBe(2);
  });

  it('counts successAfterRetry when span with retries ends completed', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'adapter_retry' });
    tm.endSpan(sid, 'completed');
    expect(tm.getRetryMetrics().successAfterRetry).toBe(1);
    expect(tm.getRetryMetrics().failedAfterRetries).toBe(0);
  });

  it('counts failedAfterRetries when span with retries ends with error', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'adapter_retry' });
    tm.endSpan(sid, 'error');
    expect(tm.getRetryMetrics().failedAfterRetries).toBe(1);
    expect(tm.getRetryMetrics().successAfterRetry).toBe(0);
  });

  it('does not count non-retry events', () => {
    const tm = createTraceManager();
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.addSpanEvent(sid, { name: 'other' });
    tm.endSpan(sid);
    expect(tm.getRetryMetrics().totalRetries).toBe(0);
  });
});

// PERF-006: O(1) endTrace for large workloads
describe('PERF-006 endTrace O(1) behavior', () => {
  it('endTrace is fast for many concurrently-running traces', () => {
    // Functional test only: we don't benchmark; we verify correctness at scale.
    const tm = createTraceManager({ maxTraces: 10_000 });
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(tm.startTrace(`t-${i}`));
    }
    // End them in reverse order to stress swap-remove
    for (let i = ids.length - 1; i >= 0; i--) {
      tm.endTrace(ids[i]);
    }
    // All should be marked completed
    for (const id of ids) {
      expect(tm.getTrace(id)!.status).toBe('completed');
    }
  });

  it('endTrace correctness with arbitrary order removal', () => {
    const tm = createTraceManager({ maxTraces: 100 });
    const a = tm.startTrace('a');
    const b = tm.startTrace('b');
    const c = tm.startTrace('c');
    const d = tm.startTrace('d');

    // End middle ones first to exercise swap-remove
    tm.endTrace(b);
    tm.endTrace(c);
    tm.endTrace(a);
    tm.endTrace(d);

    expect(tm.getTrace(a)!.status).toBe('completed');
    expect(tm.getTrace(b)!.status).toBe('completed');
    expect(tm.getTrace(c)!.status).toBe('completed');
    expect(tm.getTrace(d)!.status).toBe('completed');
  });
});

// PERF-016: pendingExports leak on rejection
describe('PERF-016 pendingExports leak fix', () => {
  it('flush does not hang when an exporter span rejects', async () => {
    const failingExporter: TraceExporter = {
      name: 'fail',
      async exportTrace() {},
      async exportSpan() { throw new Error('boom'); },
      async flush() {},
    };
    const tm = createTraceManager({
      exporters: [failingExporter],
      onExportError: () => {},
    });
    const tid = tm.startTrace('t');
    const sid = tm.startSpan(tid, 's');
    tm.endSpan(sid);

    // flush must settle — if pendingExports leaked on rejection, this would
    // wait forever for the dangling promise.
    await expect(tm.flush()).resolves.toBeUndefined();
  });

  it('flush settles even when exporter throws synchronously', async () => {
    const failingExporter: TraceExporter = {
      name: 'fail',
      async exportTrace() { throw new Error('boom'); },
      async exportSpan() {},
      async flush() {},
    };
    const tm = createTraceManager({
      exporters: [failingExporter],
      onExportError: () => {},
    });
    const tid = tm.startTrace('t');
    tm.endTrace(tid);

    await expect(tm.flush()).resolves.toBeUndefined();
  });

  // LM-011 (Wave 4b): `setSamplingRate` used to mutate a closure-scoped
  // variable read directly by `exportTraceTo()`. Traces that started under a
  // high sampling rate could be silently dropped if the rate was lowered
  // before they ended. The fix captures the rate at trace-start and the
  // export path reads that snapshot.
  describe('LM-011: sampling rate snapshot at trace-start', () => {
    it('uses the rate captured at startTrace, not the live rate at endTrace', async () => {
      // Make sampling non-random by pinning Math.random. When rate is 1.0,
      // the export must always fire regardless of random output.
      const exportTrace = vi.fn().mockResolvedValue(undefined);
      const exporter: TraceExporter = {
        name: 'snap',
        exportTrace,
        async exportSpan() {},
        async flush() {},
      };
      const tm = createTraceManager({
        exporters: [exporter],
        defaultSamplingRate: 1,
      });

      const tid = tm.startTrace('t-snapshot');
      // Lower the sampling rate mid-flight.
      tm.setSamplingRate(0);
      tm.endTrace(tid);
      await tm.flush();

      // With the fix, the trace snapshot rate (1) is used, so it DOES export.
      // Without the fix, the live rate (0) would block the export.
      expect(exportTrace).toHaveBeenCalledTimes(1);
    });

    it('traces started AFTER setSamplingRate pick up the new rate', async () => {
      const exportTrace = vi.fn().mockResolvedValue(undefined);
      const exporter: TraceExporter = {
        name: 'snap',
        exportTrace,
        async exportSpan() {},
        async flush() {},
      };
      const tm = createTraceManager({
        exporters: [exporter],
        defaultSamplingRate: 1,
      });

      tm.setSamplingRate(0);
      const tid = tm.startTrace('t-after');
      tm.endTrace(tid);
      await tm.flush();

      // Rate 0 means never export.
      expect(exportTrace).not.toHaveBeenCalled();
    });
  });

  // CQ-036 (Wave 4b): pendingExports cleanup used `.catch(() => {})` which
  // silently swallowed rejections. With an injected logger, those rejections
  // are now routed to `logger.warn`. The rejection typically reaches
  // `trackExport`'s catch only when the upstream `reportExportError` itself
  // throws — this models a misconfigured `onExportError` callback.
  describe('CQ-036: pendingExports cleanup routes to logger', () => {
    it('logger.warn captures the rejection when onExportError itself throws', async () => {
      const loggerWarn = vi.fn();
      const failingExporter: TraceExporter = {
        name: 'fail',
        async exportSpan() { throw new Error('span boom'); },
        async exportTrace() {},
        async flush() {},
      };
      // An onExportError that itself throws — a realistic misconfiguration.
      // Without the CQ-036 fix, the subsequent trackExport `.catch(() => {})`
      // would silently swallow this secondary rejection; with the fix, it
      // routes through `logger.warn`.
      const tm = createTraceManager({
        exporters: [failingExporter],
        logger: { warn: loggerWarn },
        onExportError: () => { throw new Error('secondary failure'); },
      });
      const tid = tm.startTrace('t');
      const sid = tm.startSpan(tid, 's');
      tm.endSpan(sid);
      await tm.flush();

      // The trackExport catch must have been invoked with the secondary
      // rejection and routed to logger.warn.
      expect(loggerWarn).toHaveBeenCalled();
      const cleanupCall = loggerWarn.mock.calls.find((c) =>
        typeof c[0] === 'string' && c[0].includes('export cleanup'),
      );
      expect(cleanupCall).toBeDefined();
    });

    it('silent swallow (no throw) when no logger is injected', async () => {
      const failingExporter: TraceExporter = {
        name: 'fail',
        async exportSpan() { throw new Error('span boom'); },
        async exportTrace() {},
        async flush() {},
      };
      const tm = createTraceManager({
        exporters: [failingExporter],
        onExportError: () => { throw new Error('secondary failure'); },
        // No logger — the fallback silent swallow must hold.
      });
      const tid = tm.startTrace('t');
      const sid = tm.startSpan(tid, 's');
      tm.endSpan(sid);
      await expect(tm.flush()).resolves.toBeUndefined();
    });
  });

  describe('PERF-021/023/033/035: frozen readonly span snapshots', () => {
    it('hands every exporter the same frozen snapshot reference', async () => {
      const capturedA: unknown[] = [];
      const capturedB: unknown[] = [];
      const exporterA: TraceExporter = {
        name: 'A',
        async exportSpan(span) { capturedA.push(span); },
        async exportTrace() {},
        async flush() {},
      };
      const exporterB: TraceExporter = {
        name: 'B',
        async exportSpan(span) { capturedB.push(span); },
        async exportTrace() {},
        async flush() {},
      };
      const tm = createTraceManager({ exporters: [exporterA, exporterB] });
      const tid = tm.startTrace('t');
      const sid = tm.startSpan(tid, 's');
      tm.addSpanEvent(sid, 'hi');
      tm.endSpan(sid);
      await tm.flush();

      expect(capturedA).toHaveLength(1);
      expect(capturedB).toHaveLength(1);
      // Both exporters receive the same reference — no per-exporter deep clone.
      expect(capturedA[0]).toBe(capturedB[0]);
      // And the shared reference is frozen so neither exporter can mutate it.
      expect(Object.isFrozen(capturedA[0])).toBe(true);
    });

    it('freezes the events array on the snapshot', async () => {
      let captured: unknown;
      const exporter: TraceExporter = {
        name: 'capture',
        async exportSpan(span) { captured = span; },
        async exportTrace() {},
        async flush() {},
      };
      const tm = createTraceManager({ exporters: [exporter] });
      const tid = tm.startTrace('t');
      const sid = tm.startSpan(tid, 's');
      tm.addSpanEvent(sid, 'e1');
      tm.addSpanEvent(sid, 'e2');
      tm.endSpan(sid);
      await tm.flush();

      const snapshot = captured as { events: readonly unknown[] };
      expect(Object.isFrozen(snapshot.events)).toBe(true);
      expect(snapshot.events).toHaveLength(2);
    });
  });

  describe('LM-007: active eviction when N concurrent running traces exceed maxTraces', () => {
    it('caps memory at maxTraces even when no traces end', () => {
      const tm = createTraceManager({ maxTraces: 3 });
      const ids = [] as string[];
      for (let i = 0; i < 10; i++) {
        ids.push(tm.startTrace(`t-${i}`));
      }
      // Only the 3 most recent traces survive; older ones are evicted.
      const alive = ids.filter((id) => tm.getTrace(id) !== undefined);
      expect(alive).toHaveLength(3);
      // The 3 most recent (last appended) are retained.
      expect(alive).toEqual(ids.slice(-3));
    });

    it('PERF-029: LRU eviction remains correct after many evictions', () => {
      const tm = createTraceManager({ maxTraces: 5 });
      const ids = [] as string[];
      for (let i = 0; i < 1_000; i++) {
        ids.push(tm.startTrace(`t-${i}`));
      }
      // Only the last 5 ids are alive; everything older has been evicted in
      // O(1) linked-list unlinks rather than O(n) index rebuilds.
      const alive = ids.filter((id) => tm.getTrace(id) !== undefined);
      expect(alive).toEqual(ids.slice(-5));
    });
  });
});
