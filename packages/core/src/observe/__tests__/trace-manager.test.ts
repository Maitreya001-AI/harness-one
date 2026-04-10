import { describe, it, expect, vi } from 'vitest';
import { createTraceManager, createConsoleExporter, createNoOpExporter } from '../trace-manager.js';
import { HarnessError } from '../../core/errors.js';
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
    const exporter = createConsoleExporter({ verbose: false });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    const exporter = createConsoleExporter({ verbose: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      expect(spy.mock.calls[0][0]).toBe('[trace]');
      // Verbose mode outputs JSON.stringify with indent
      const jsonOutput = spy.mock.calls[0][1] as string;
      expect(jsonOutput).toContain('verbose-trace');
      expect(jsonOutput).toContain('"id"');
    } finally {
      spy.mockRestore();
    }
  });

  it('exportSpan logs summary in non-verbose mode', async () => {
    const exporter = createConsoleExporter({ verbose: false });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
    const exporter = createConsoleExporter({ verbose: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      expect(spy.mock.calls[0][0]).toBe('[span]');
      const jsonOutput = spy.mock.calls[0][1] as string;
      expect(jsonOutput).toContain('verbose-span');
      expect(jsonOutput).toContain('"id"');
    } finally {
      spy.mockRestore();
    }
  });

  it('flush resolves without error', async () => {
    const exporter = createConsoleExporter();
    await expect(exporter.flush()).resolves.toBeUndefined();
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
      expect((e as HarnessError).code).toBe('SPAN_NOT_FOUND');
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

  it('silently discards dispose errors when no onExportError provided (no console.warn)', async () => {
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

    // Library modules should not produce console output — errors are silently
    // discarded when no onExportError callback is provided.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
