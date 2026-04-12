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
});
