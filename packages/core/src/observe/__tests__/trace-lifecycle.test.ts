/**
 * Verifies the lifecycle hooks declared on TraceExporter are actually invoked
 * by TraceManager — `initialize`, `isHealthy`, `shouldExport`. These were
 * previously declared in the interface but never called (contract gap).
 */
import { describe, it, expect, vi } from 'vitest';
import { createTraceManager } from '../trace-manager.js';
import type { TraceExporter } from '../types.js';

function makeExporter(overrides?: Partial<TraceExporter>): TraceExporter {
  return {
    name: 'test',
    exportTrace: vi.fn(async () => {}),
    exportSpan: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('TraceExporter lifecycle hooks', () => {
  it('invokes initialize() lazily on first span export', async () => {
    const initialize = vi.fn(async () => {});
    const exporter = makeExporter({ initialize });

    const tm = createTraceManager({ exporters: [exporter] });
    expect(initialize).not.toHaveBeenCalled();

    const traceId = tm.startTrace('t1');
    const spanId = tm.startSpan(traceId, 's1');
    tm.endSpan(spanId);
    // Lazy init — allow microtasks to drain
    await new Promise((r) => setImmediate(r));
    expect(initialize).toHaveBeenCalledTimes(1);

    // Second span on the same trace should not re-initialize
    const spanId2 = tm.startSpan(traceId, 's2');
    tm.endSpan(spanId2);
    await new Promise((r) => setImmediate(r));
    expect(initialize).toHaveBeenCalledTimes(1);

    tm.endTrace(traceId);
    await tm.dispose();
  });

  it('invokes initialize() eagerly when the caller awaits initialize()', async () => {
    const initialize = vi.fn(async () => {});
    const exporter = makeExporter({ initialize });

    const tm = createTraceManager({ exporters: [exporter] });
    await tm.initialize();
    expect(initialize).toHaveBeenCalledTimes(1);
    await tm.dispose();
  });

  it('skips exportSpan when isHealthy() returns false', async () => {
    const exportSpan = vi.fn(async () => {});
    const isHealthy = vi.fn(() => false);
    const exporter = makeExporter({ exportSpan, isHealthy });

    const tm = createTraceManager({ exporters: [exporter] });
    const traceId = tm.startTrace('t1');
    const spanId = tm.startSpan(traceId, 's1');
    tm.endSpan(spanId);
    await new Promise((r) => setImmediate(r));

    expect(isHealthy).toHaveBeenCalled();
    expect(exportSpan).not.toHaveBeenCalled();
    await tm.dispose();
  });

  it('skips exportTrace when shouldExport(trace) returns false (sampling)', async () => {
    const exportTrace = vi.fn(async () => {});
    const shouldExport = vi.fn(() => false);
    const exporter = makeExporter({ exportTrace, shouldExport });

    const tm = createTraceManager({ exporters: [exporter] });
    const traceId = tm.startTrace('t1');
    tm.endTrace(traceId);
    await new Promise((r) => setImmediate(r));

    expect(shouldExport).toHaveBeenCalledTimes(1);
    expect(exportTrace).not.toHaveBeenCalled();
    await tm.dispose();
  });

  it('applies defaultSamplingRate when no per-exporter shouldExport is provided', async () => {
    const exportTrace = vi.fn(async () => {});
    const exporter = makeExporter({ exportTrace });

    // Force deterministic sampling by stubbing Math.random
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9);

    // Rate 0.5 means sample when random < 0.5 — 0.9 will be dropped
    const tm = createTraceManager({ exporters: [exporter], defaultSamplingRate: 0.5 });
    const traceId = tm.startTrace('t1');
    tm.endTrace(traceId);
    await new Promise((r) => setImmediate(r));
    expect(exportTrace).not.toHaveBeenCalled();

    // Now 0.1 < 0.5 — should sample through
    randomSpy.mockReturnValue(0.1);
    const traceId2 = tm.startTrace('t2');
    tm.endTrace(traceId2);
    await new Promise((r) => setImmediate(r));
    expect(exportTrace).toHaveBeenCalledTimes(1);

    randomSpy.mockRestore();
    await tm.dispose();
  });

  it('setSamplingRate updates rate at runtime', async () => {
    const tm = createTraceManager({ defaultSamplingRate: 1 });
    expect(() => tm.setSamplingRate(0.1)).not.toThrow();
    expect(() => tm.setSamplingRate(-1)).toThrow(/samplingRate must be/);
    expect(() => tm.setSamplingRate(1.5)).toThrow(/samplingRate must be/);
    expect(() => tm.setSamplingRate(Number.NaN)).toThrow(/samplingRate must be/);
    await tm.dispose();
  });

  it('rejects invalid defaultSamplingRate at construction', () => {
    expect(() => createTraceManager({ defaultSamplingRate: -0.1 })).toThrow(/defaultSamplingRate must be/);
    expect(() => createTraceManager({ defaultSamplingRate: 1.1 })).toThrow(/defaultSamplingRate must be/);
  });

  it('structured logger overrides console.warn for export errors', async () => {
    const warn = vi.fn();
    const logger = { warn };
    const exporter = makeExporter({
      exportSpan: vi.fn(async () => { throw new Error('export failed'); }),
    });
    const tm = createTraceManager({ exporters: [exporter], logger });
    const traceId = tm.startTrace('t1');
    const spanId = tm.startSpan(traceId, 's1');
    tm.endSpan(spanId);
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalled();
    await tm.dispose();
  });

  it('initialize() failure is recorded but does not block subsequent calls', async () => {
    const onExportError = vi.fn();
    const initialize = vi.fn(async () => { throw new Error('init failed'); });
    const exportSpan = vi.fn(async () => {});
    const exporter = makeExporter({ initialize, exportSpan });

    const tm = createTraceManager({ exporters: [exporter], onExportError });
    const traceId = tm.startTrace('t1');
    const spanId = tm.startSpan(traceId, 's1');
    tm.endSpan(spanId);
    await new Promise((r) => setImmediate(r));

    expect(onExportError).toHaveBeenCalled();
    // exportSpan still attempted after init failed (the export itself may fail again later,
    // but we don't want a transient init failure to permanently block the exporter)
    expect(exportSpan).toHaveBeenCalledTimes(1);
    await tm.dispose();
  });

  it('TEST-011: spans continue to export successfully after a transient init failure', async () => {
    // Sequence of interest:
    //   1. initialize() rejects once (transient) → the failure is reported.
    //   2. Subsequent endSpan() calls must still reach exportSpan and succeed.
    // This guards against regressions where a rejected init promise permanently
    // poisons the exporter and silently drops every subsequent span.
    const onExportError = vi.fn();
    const initialize = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(new Error('transient init failure'));
    const exportedSpans: string[] = [];
    const exportSpan = vi.fn(async (span: { name: string }) => {
      exportedSpans.push(span.name);
    });
    const exporter = makeExporter({ initialize, exportSpan });

    const tm = createTraceManager({ exporters: [exporter], onExportError });
    const traceId = tm.startTrace('recover-trace');

    // Span 1: init fails, but the manager must still try exportSpan.
    const s1 = tm.startSpan(traceId, 'span-after-init-fail');
    tm.endSpan(s1);
    await new Promise((r) => setImmediate(r));

    // Span 2: init promise is cached (no second init attempt), and the
    // exporter continues to accept spans.
    const s2 = tm.startSpan(traceId, 'subsequent-span');
    tm.endSpan(s2);
    await new Promise((r) => setImmediate(r));

    // Span 3: one more to prove the exporter remains live indefinitely.
    const s3 = tm.startSpan(traceId, 'final-span');
    tm.endSpan(s3);
    await new Promise((r) => setImmediate(r));

    tm.endTrace(traceId);
    await tm.dispose();

    // LM-003: the first init rejects and is reported once. `createLazyAsync`
    // then clears the cached promise so the next export retries — initialize
    // is invoked again and (per the mock) resolves. Subsequent exports join
    // the cached success.
    expect(onExportError).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
    // All three spans made it through export — the init failure did not
    // permanently disable the exporter.
    expect(exportSpan).toHaveBeenCalledTimes(3);
    expect(exportedSpans).toEqual([
      'span-after-init-fail',
      'subsequent-span',
      'final-span',
    ]);
  });
});

describe('Wave 4a — LM-003 / A1-3: concurrent lazy init', () => {
  it('shares the same init promise across concurrent first exports', async () => {
    let initCalls = 0;
    let resolveInit: () => void = () => {};
    const initialize = vi.fn<[], Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          initCalls++;
          resolveInit = resolve;
        }),
    );
    const exportSpan = vi.fn<[{ name: string }], Promise<void>>(async () => {});
    const exporter: TraceExporter = {
      name: 'concurrent',
      initialize,
      exportTrace: async () => {},
      exportSpan,
      flush: async () => {},
    };

    const tm = createTraceManager({ exporters: [exporter] });
    const traceId = tm.startTrace('t');
    // Fire 3 concurrent endSpan calls BEFORE init resolves — all three
    // should join the same in-flight init promise, not kick duplicates.
    const s1 = tm.startSpan(traceId, 'a');
    const s2 = tm.startSpan(traceId, 'b');
    const s3 = tm.startSpan(traceId, 'c');
    tm.endSpan(s1);
    tm.endSpan(s2);
    tm.endSpan(s3);

    // Allow microtasks to settle so the init promise is observed by all three.
    await new Promise((r) => setImmediate(r));
    expect(initCalls).toBe(1);

    resolveInit();
    await tm.flush();
    expect(exportSpan).toHaveBeenCalledTimes(3);
    await tm.dispose();
  });
});

describe('Wave 4a — LM-016: dead trace evict-at-birth', () => {
  it('returns a dead trace id when every exporter is unhealthy', () => {
    const exporter: TraceExporter = {
      name: 'unhealthy',
      isHealthy: () => false,
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const tm = createTraceManager({ exporters: [exporter] });
    const id = tm.startTrace('dead');
    expect(id.startsWith('dead-')).toBe(true);
    // Trace was never admitted to internal storage.
    expect(tm.getTrace(id)).toBeUndefined();
  });

  it('admits traces normally when at least one exporter is healthy', () => {
    const unhealthy: TraceExporter = {
      name: 'u',
      isHealthy: () => false,
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const healthy: TraceExporter = {
      name: 'h',
      isHealthy: () => true,
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const tm = createTraceManager({ exporters: [unhealthy, healthy] });
    const id = tm.startTrace('live');
    expect(id.startsWith('dead-')).toBe(false);
    expect(tm.getTrace(id)).toBeDefined();
  });

  it('startSpan / endSpan / addSpanEvent no-op on dead trace handle', () => {
    const exporter: TraceExporter = {
      name: 'u',
      isHealthy: () => false,
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const tm = createTraceManager({ exporters: [exporter] });
    const traceId = tm.startTrace('dead');
    const spanId = tm.startSpan(traceId, 'span');
    expect(spanId.startsWith('dead-span-')).toBe(true);
    // All subsequent ops must not throw.
    expect(() => tm.addSpanEvent(spanId, { name: 'ev' })).not.toThrow();
    expect(() => tm.setSpanAttributes(spanId, { k: 'v' })).not.toThrow();
    expect(() => tm.setTraceSystemMetadata(traceId, { a: 1 })).not.toThrow();
    expect(() => tm.endSpan(spanId)).not.toThrow();
    expect(() => tm.endTrace(traceId)).not.toThrow();
  });

  it('traces map stays empty across many dead-trace calls (no zombie growth)', () => {
    const exporter: TraceExporter = {
      name: 'u',
      isHealthy: () => false,
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const tm = createTraceManager({ exporters: [exporter] });
    for (let i = 0; i < 100; i++) {
      const tid = tm.startTrace(`t${i}`);
      const sid = tm.startSpan(tid, 's');
      tm.endSpan(sid);
      tm.endTrace(tid);
    }
    // There were no actual spans ever admitted.
    expect(tm.getActiveSpans()).toEqual([]);
  });

  it('isHealthy true for any exporter admits the trace', () => {
    const exporter: TraceExporter = {
      name: 'sometimes',
      isHealthy: () => true,
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const tm = createTraceManager({ exporters: [exporter] });
    const id = tm.startTrace('ok');
    expect(id.startsWith('dead-')).toBe(false);
  });

  it('exporter without isHealthy is treated as healthy', () => {
    // An exporter that does not implement isHealthy must not cause dead-trace
    // behavior — it is presumed healthy.
    const exporter: TraceExporter = {
      name: 'no-health-hook',
      exportTrace: async () => {},
      exportSpan: async () => {},
      flush: async () => {},
    };
    const tm = createTraceManager({ exporters: [exporter] });
    const id = tm.startTrace('ok');
    expect(id.startsWith('dead-')).toBe(false);
  });
});

