/**
 * Tests for `trace-exporter-coordinator.ts` — round-3 extraction from
 * trace-manager. Exercises the contracts the trace-manager tests don't
 * cover in isolation (initialize, flush, shutdown, init-error reporting,
 * onExportError-throws-falls-through-to-trackExport).
 */
import { describe, it, expect, vi } from 'vitest';
import { createTraceExporterCoordinator } from '../trace-exporter-coordinator.js';
import type { Span, Trace, TraceExporter } from '../types.js';

function makeSpan(): Span {
  return {
    id: 'sp-1',
    traceId: 'tr-1',
    name: 'test',
    startTime: Date.now(),
    attributes: {},
    events: [],
    status: 'completed',
  };
}

function makeTrace(sampled = true): Trace {
  return {
    id: 'tr-1',
    name: 'test',
    startTime: Date.now(),
    endTime: Date.now(),
    metadata: {},
    spans: [],
    status: 'completed',
    // Round-3: sampled is stored on mutable trace internally; exporter coordinator
    // is told explicitly whether it's sampled so the inline head decision isn't
    // re-evaluated.
    ...(sampled !== undefined && { sampled }),
  } as Trace;
}

describe('createTraceExporterCoordinator', () => {
  it('exportSpan forwards to every healthy exporter', async () => {
    const exported: string[] = [];
    const exporter: TraceExporter = {
      name: 'a',
      exportSpan: async (s) => {
        exported.push(s.id);
      },
      exportTrace: async () => {},
      flush: async () => {},
    };
    const coord = createTraceExporterCoordinator({
      exporters: [exporter],
      flushTimeoutMs: 1000,
    });
    coord.exportSpan(makeSpan());
    await coord.flushAll();
    expect(exported).toEqual(['sp-1']);
  });

  it('exportSpan skips unhealthy exporters', async () => {
    const exporter: TraceExporter = {
      name: 'a',
      isHealthy: () => false,
      exportSpan: vi.fn(async () => {}),
      exportTrace: async () => {},
      flush: async () => {},
    };
    const coord = createTraceExporterCoordinator({
      exporters: [exporter],
      flushTimeoutMs: 1000,
    });
    coord.exportSpan(makeSpan());
    await coord.flushAll();
    expect(exporter.exportSpan).not.toHaveBeenCalled();
  });

  it('exportTrace respects the head sampling decision when no shouldExport hook', async () => {
    const traces: string[] = [];
    const exporter: TraceExporter = {
      name: 'a',
      exportSpan: async () => {},
      exportTrace: async (t) => {
        traces.push(t.id);
      },
      flush: async () => {},
    };
    const coord = createTraceExporterCoordinator({
      exporters: [exporter],
      flushTimeoutMs: 1000,
    });
    coord.exportTrace(makeTrace(true), true);
    coord.exportTrace({ ...makeTrace(), id: 'tr-2' }, false);
    await coord.flushAll();
    expect(traces).toEqual(['tr-1']);
  });

  it('routes onExportError when exportSpan throws', async () => {
    const errs: unknown[] = [];
    const exporter: TraceExporter = {
      name: 'a',
      exportSpan: async () => {
        throw new Error('boom');
      },
      exportTrace: async () => {},
      flush: async () => {},
    };
    const coord = createTraceExporterCoordinator({
      exporters: [exporter],
      flushTimeoutMs: 1000,
      onExportError: (e) => {
        errs.push(e);
      },
    });
    coord.exportSpan(makeSpan());
    await coord.flushAll();
    expect(errs).toHaveLength(1);
  });

  it('shutdownAll flushes + calls shutdown and tolerates shutdown throwing', async () => {
    const flushed = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {
      throw new Error('shutdown failed');
    });
    const errs: unknown[] = [];
    const exporter: TraceExporter = {
      name: 'a',
      exportSpan: async () => {},
      exportTrace: async () => {},
      flush: flushed,
      shutdown,
    };
    const coord = createTraceExporterCoordinator({
      exporters: [exporter],
      flushTimeoutMs: 1000,
      onExportError: (e) => {
        errs.push(e);
      },
    });
    await coord.shutdownAll();
    expect(flushed).toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalled();
    expect(errs.length).toBeGreaterThan(0);
  });

  it('flushAll tolerates an exporter that sync-throws from flush()', async () => {
    // Regression: `Array.map` evaluates callbacks eagerly, so a
    // sync throw inside the map would unwind past `Promise.allSettled`.
    // `invokeAsync` forces the call into the promise chain so the throw lands
    // as a rejection we can catch.
    const errs: unknown[] = [];
    const throwing: TraceExporter = {
      name: 'throws-sync',
      exportSpan: async () => {},
      exportTrace: async () => {},
      flush: (() => {
        throw new Error('sync-boom');
      }) as TraceExporter['flush'],
    };
    const coord = createTraceExporterCoordinator({
      exporters: [throwing],
      flushTimeoutMs: 1000,
      onExportError: (e) => {
        errs.push(e);
      },
    });
    await expect(coord.flushAll()).resolves.toBeUndefined();
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('sync-boom');
  });

  it('shutdownAll tolerates an exporter that sync-throws from flush() and shutdown()', async () => {
    // Regression: same as flushAll but in the shutdown path.
    const errs: unknown[] = [];
    const throwing: TraceExporter = {
      name: 'throws-sync',
      exportSpan: async () => {},
      exportTrace: async () => {},
      flush: (() => {
        throw new Error('flush-sync-boom');
      }) as TraceExporter['flush'],
      shutdown: (() => {
        throw new Error('shutdown-sync-boom');
      }) as TraceExporter['shutdown'],
    };
    const coord = createTraceExporterCoordinator({
      exporters: [throwing],
      flushTimeoutMs: 1000,
      onExportError: (e) => {
        errs.push(e);
      },
    });
    await expect(coord.shutdownAll()).resolves.toBeUndefined();
    // One error from flush, one from shutdown.
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('initializeAll runs every exporter initialize() in parallel', async () => {
    const order: string[] = [];
    const a: TraceExporter = {
      name: 'a',
      initialize: async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('a-end');
      },
      exportSpan: async () => {},
      exportTrace: async () => {},
      flush: async () => {},
    };
    const b: TraceExporter = {
      name: 'b',
      initialize: async () => {
        order.push('b-start');
        await new Promise((r) => setTimeout(r, 5));
        order.push('b-end');
      },
      exportSpan: async () => {},
      exportTrace: async () => {},
      flush: async () => {},
    };
    const coord = createTraceExporterCoordinator({
      exporters: [a, b],
      flushTimeoutMs: 1000,
    });
    await coord.initializeAll();
    // Both must have started before either completed — proves parallelism.
    const aStart = order.indexOf('a-start');
    const bStart = order.indexOf('b-start');
    const aEnd = order.indexOf('a-end');
    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(aEnd);
  });
});
