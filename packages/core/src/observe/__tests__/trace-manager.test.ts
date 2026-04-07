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
