import { describe, it, expect } from 'vitest';
import { createTraceManager } from '../trace-manager.js';
import { HarnessError } from '../../core/errors.js';
import type { TraceExporter } from '../types.js';
import type { MetricsPort } from '../../core/metrics-port.js';

function makeRecordingMetricsPort(): {
  port: MetricsPort;
  counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }>;
} {
  const counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }> = [];
  const port: MetricsPort = {
    counter(name) {
      return { add: (value, attrs) => counters.push({ name, value, attrs: attrs as Record<string, unknown> | undefined }) };
    },
    gauge() { return { record: () => {} }; },
    histogram() { return { record: () => {} }; },
  };
  return { port, counters };
}

function slowExporter(delayMs: number, name: string): TraceExporter {
  return {
    name,
    async exportTrace() {},
    async exportSpan() {},
    async flush() {
      await new Promise((r) => setTimeout(r, delayMs));
    },
  };
}

describe('Wave-13 trace-manager fixes', () => {
  describe('Wave-13 C-4: flush() uses Promise.allSettled with per-exporter timeout', () => {
    it('does not block on the slowest exporter past per-exporter deadline', async () => {
      const fast: TraceExporter = {
        name: 'fast',
        async exportTrace() {},
        async exportSpan() {},
        async flush() {},
      };
      const slow = slowExporter(5_000, 'slow');
      const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
      const tm = createTraceManager({
        exporters: [fast, slow],
        flushTimeoutMs: 100,
        logger: { warn: (msg, meta) => warns.push({ msg, meta }) },
      });
      const start = Date.now();
      await tm.flush();
      const elapsed = Date.now() - start;
      // Per-exporter timeout = 100 / 2 = 50ms. flush() should return well
      // before the slow exporter's 5s deadline.
      expect(elapsed).toBeLessThan(1500);
      expect(warns.some((w) => w.msg.includes('slow'))).toBe(true);
    });

    it('flushResults surfaces rejections via reportExportError rather than throwing', async () => {
      const failing: TraceExporter = {
        name: 'failing',
        async exportTrace() {},
        async exportSpan() {},
        async flush() { throw new Error('boom'); },
      };
      const errors: unknown[] = [];
      const tm = createTraceManager({
        exporters: [failing],
        onExportError: (e) => errors.push(e),
      });
      await expect(tm.flush()).resolves.toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Wave-13 C-5: startSpan on dead trace is observable', () => {
    it('returns a dead span id and increments counter when strictSpanCreation=false', () => {
      const unhealthy: TraceExporter = {
        name: 'unhealthy',
        async exportTrace() {},
        async exportSpan() {},
        async flush() {},
        isHealthy: () => false,
      };
      const { port, counters } = makeRecordingMetricsPort();
      const debugCalls: Array<{ msg: string }> = [];
      const tm = createTraceManager({
        exporters: [unhealthy],
        metrics: port,
        logger: {
          warn: () => {},
          debug: (msg) => debugCalls.push({ msg }),
        },
      });
      const traceId = tm.startTrace('t'); // dead handle
      const spanId = tm.startSpan(traceId, 's');
      expect(String(spanId).startsWith('dead-span-')).toBe(true);
      expect(counters.some((c) => c.name === 'harness.trace.dead_span_attempts.total' && c.attrs?.reason === 'trace_dead')).toBe(true);
      expect(debugCalls.some((d) => d.msg.includes('dead trace'))).toBe(true);
    });

    it('throws when strictSpanCreation=true on a dead trace', () => {
      const unhealthy: TraceExporter = {
        name: 'unhealthy',
        async exportTrace() {},
        async exportSpan() {},
        async flush() {},
        isHealthy: () => false,
      };
      const tm = createTraceManager({
        exporters: [unhealthy],
        strictSpanCreation: true,
      });
      const traceId = tm.startTrace('t');
      expect(() => tm.startSpan(traceId, 's')).toThrow(HarnessError);
    });

    it('increments trace_missing counter when trace id is unknown', () => {
      const { port, counters } = makeRecordingMetricsPort();
      const tm = createTraceManager({ metrics: port });
      expect(() => tm.startSpan('does-not-exist', 's')).toThrow(HarnessError);
      expect(counters.some((c) => c.name === 'harness.trace.dead_span_attempts.total' && c.attrs?.reason === 'trace_missing')).toBe(true);
    });
  });

  describe('Wave-13 C-6: initialize() promises are tracked so flush() awaits them', () => {
    it('awaits lazy init promises via flush()', async () => {
      let initResolved = false;
      const lazyExporter: TraceExporter = {
        name: 'lazy',
        async initialize() {
          await new Promise((r) => setTimeout(r, 50));
          initResolved = true;
        },
        async exportTrace() {},
        async exportSpan() {},
        async flush() {},
      };
      const tm = createTraceManager({ exporters: [lazyExporter] });
      // Kick off initialize() in the background, then flush immediately.
      tm.initialize().catch(() => {});
      await tm.flush();
      expect(initResolved).toBe(true);
    });

    it('initialize() uses allSettled — one failing exporter does not block others', async () => {
      const errors: unknown[] = [];
      let goodInit = false;
      const bad: TraceExporter = {
        name: 'bad',
        async initialize() { throw new Error('init failed'); },
        async exportTrace() {},
        async exportSpan() {},
        async flush() {},
      };
      const good: TraceExporter = {
        name: 'good',
        async initialize() { goodInit = true; },
        async exportTrace() {},
        async exportSpan() {},
        async flush() {},
      };
      const tm = createTraceManager({
        exporters: [bad, good],
        onExportError: (e) => errors.push(e),
      });
      await tm.initialize();
      expect(goodInit).toBe(true);
    });
  });

  describe('Wave-13 C-7: LRU mutation documentation', () => {
    it('still serialises concurrent startTrace()/endTrace() calls correctly under the synchronous model', () => {
      const tm = createTraceManager({ maxTraces: 3 });
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push(tm.startTrace(`t${i}`));
      // Only the most recent 3 traces are retained; older ones were evicted.
      let retained = 0;
      for (const id of ids) if (tm.getTrace(id)) retained++;
      expect(retained).toBe(3);
    });
  });

  describe('Wave-13 C-10: span LRU eviction emits metrics + 80% warning', () => {
    it('emits trace + span eviction counters when maxTraces is exceeded', () => {
      const { port, counters } = makeRecordingMetricsPort();
      const tm = createTraceManager({ maxTraces: 2, metrics: port });
      const t1 = tm.startTrace('t1');
      tm.startSpan(t1, 's1');
      const t2 = tm.startTrace('t2');
      tm.startSpan(t2, 's2');
      tm.startTrace('t3'); // forces eviction of t1
      const traceEvictions = counters.filter((c) => c.name === 'harness.trace.evictions.total');
      const spanEvictions = counters.filter((c) => c.name === 'harness.trace.span_evictions.total');
      expect(traceEvictions.length).toBeGreaterThan(0);
      expect(spanEvictions.length).toBeGreaterThan(0);
    });

    it('logs warn at 80% capacity', () => {
      const warns: Array<{ msg: string }> = [];
      const tm = createTraceManager({
        maxTraces: 10,
        logger: { warn: (msg) => warns.push({ msg }) },
      });
      // Need 8 traces to hit >= 80% (floor(10 * 0.8) == 8).
      for (let i = 0; i < 11; i++) tm.startTrace(`t${i}`);
      expect(warns.some((w) => w.msg.includes('80% capacity'))).toBe(true);
    });
  });

});
