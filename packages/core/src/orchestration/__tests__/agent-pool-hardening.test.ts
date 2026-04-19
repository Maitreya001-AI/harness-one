/**
 * agent-pool observability tests (B-1..B-4).
 *
 * Covers:
 *  - B-1: queue-depth debug log + gauge on `acquireAsync()` queueing, plus
 *    warn + counter on POOL_QUEUE_FULL throw.
 *  - B-2: structured info log on `resize()` entry + size gauge.
 *  - B-3: warn + counter for every agent `dispose()` rejection.
 *  - B-4: `pool_acquire_timeout` span event before POOL_TIMEOUT rejection.
 *
 * Tests intentionally use a minimal in-memory MetricsPort + Logger double so
 * assertions target the exact call shape the production code relies on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../core/agent-loop.js';
import { HarnessErrorCode } from '../../core/errors.js';
import { createAgentPool } from '../agent-pool.js';
import type {
  MetricsPort,
  MetricCounter,
  MetricGauge,
  MetricAttributes,
} from '../../observe/metrics-port.js';
import type { Logger } from '../../observe/logger.js';
import type { TraceManager } from '../../observe/trace-manager.js';

/** In-memory Logger spy for assertion-friendly observation. */
interface LoggerSpy {
  logger: Logger;
  debug: Array<{ msg: string; meta?: Readonly<Record<string, unknown>> }>;
  info: Array<{ msg: string; meta?: Readonly<Record<string, unknown>> }>;
  warn: Array<{ msg: string; meta?: Readonly<Record<string, unknown>> }>;
  error: Array<{ msg: string; meta?: Readonly<Record<string, unknown>> }>;
}

function makeLoggerSpy(): LoggerSpy {
  const spy: LoggerSpy = {
    logger: undefined as unknown as Logger,
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  spy.logger = {
    debug: (msg, meta) => { spy.debug.push({ msg, ...(meta !== undefined && { meta }) }); },
    info: (msg, meta) => { spy.info.push({ msg, ...(meta !== undefined && { meta }) }); },
    warn: (msg, meta) => { spy.warn.push({ msg, ...(meta !== undefined && { meta }) }); },
    error: (msg, meta) => { spy.error.push({ msg, ...(meta !== undefined && { meta }) }); },
    child: () => spy.logger,
  };
  return spy;
}

interface MetricsSpy {
  metrics: MetricsPort;
  counterCalls: Record<string, Array<{ value: number; attrs?: MetricAttributes }>>;
  gaugeCalls: Record<string, Array<{ value: number; attrs?: MetricAttributes }>>;
  histogramCalls: Record<string, Array<{ value: number; attrs?: MetricAttributes }>>;
}

function makeMetricsSpy(): MetricsSpy {
  const counterCalls: MetricsSpy['counterCalls'] = {};
  const gaugeCalls: MetricsSpy['gaugeCalls'] = {};
  const histogramCalls: MetricsSpy['histogramCalls'] = {};
  const metrics: MetricsPort = {
    counter(name: string): MetricCounter {
      if (!counterCalls[name]) counterCalls[name] = [];
      return {
        add(value, attrs) {
          counterCalls[name]!.push({ value, ...(attrs !== undefined && { attrs }) });
        },
      };
    },
    gauge(name: string): MetricGauge {
      if (!gaugeCalls[name]) gaugeCalls[name] = [];
      return {
        record(value, attrs) {
          gaugeCalls[name]!.push({ value, ...(attrs !== undefined && { attrs }) });
        },
      };
    },
    histogram(name: string) {
      if (!histogramCalls[name]) histogramCalls[name] = [];
      return {
        record(value, attrs) {
          histogramCalls[name]!.push({ value, ...(attrs !== undefined && { attrs }) });
        },
      };
    },
  };
  return { metrics, counterCalls, gaugeCalls, histogramCalls };
}

/** Factory that yields an AgentLoop whose `dispose()` rejects. Used for B-3. */
function makeFailingDisposeFactory(): () => AgentLoop {
  return () =>
    new AgentLoop({
      adapter: {
        async chat() {
          return {
            message: { role: 'assistant' as const, content: 'ok' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      // Patch dispose() on the returned instance below.
    });
}

function makeOkFactory(): () => AgentLoop {
  return () =>
    new AgentLoop({
      adapter: {
        async chat() {
          return {
            message: { role: 'assistant' as const, content: 'ok' },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
}

describe('AgentPool — Track B observability', () => {
  let pool: ReturnType<typeof createAgentPool> | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.dispose().catch(() => undefined);
      pool = undefined;
    }
  });

  describe('acquireAsync queue-depth observability', () => {
    it('emits debug log + gauge when a request is queued', async () => {
      const logSpy = makeLoggerSpy();
      const metricsSpy = makeMetricsSpy();
      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 1,
        logger: logSpy.logger,
        metrics: metricsSpy.metrics,
        poolId: 'test-pool-b1',
      });
      const held = pool.acquire(); // exhaust
      const pendingP = pool.acquireAsync(60_000);
      pendingP.catch(() => undefined);

      // Flush microtasks so the queue-push observability fires.
      await Promise.resolve();

      const debugEntry = logSpy.debug.find((e) => e.msg === 'pool acquire queued');
      expect(debugEntry).toBeDefined();
      expect(debugEntry?.meta).toMatchObject({
        pool_id: 'test-pool-b1',
        pending_queue_depth: 1,
        active: 1,
        idle: 0,
      });

      const gaugeObservations = metricsSpy.gaugeCalls['harness.pool.queue_depth'] ?? [];
      expect(gaugeObservations.length).toBeGreaterThanOrEqual(1);
      expect(gaugeObservations[gaugeObservations.length - 1]).toMatchObject({
        value: 1,
        attrs: { pool_id: 'test-pool-b1' },
      });

      // Clean up: release so the pending promise resolves and doesn't leak.
      pool.release(held);
      await pendingP;
    });

    it('emits warn + counter before throwing POOL_QUEUE_FULL', async () => {
      const logSpy = makeLoggerSpy();
      const metricsSpy = makeMetricsSpy();
      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 1,
        maxPendingQueueSize: 1,
        logger: logSpy.logger,
        metrics: metricsSpy.metrics,
        poolId: 'test-pool-b1-full',
      });
      pool.acquire(); // exhaust
      const queued = pool.acquireAsync(60_000);
      queued.catch(() => undefined);

      await expect(pool.acquireAsync(60_000)).rejects.toMatchObject({
        code: HarnessErrorCode.POOL_QUEUE_FULL,
      });

      const warnEntry = logSpy.warn.find((e) => e.msg === 'pool acquire queue full');
      expect(warnEntry).toBeDefined();
      expect(warnEntry?.meta).toMatchObject({
        pool_id: 'test-pool-b1-full',
        pending_queue_depth: 1,
        max_pending_queue_size: 1,
      });
      const counterObservations = metricsSpy.counterCalls['harness.pool.queue_full'] ?? [];
      expect(counterObservations).toEqual([
        { value: 1, attrs: { pool_id: 'test-pool-b1-full' } },
      ]);
    });

    it('no observability traffic when logger/metrics absent (no throw)', async () => {
      pool = createAgentPool({ factory: makeOkFactory(), max: 1 });
      const held = pool.acquire();
      const pendingP = pool.acquireAsync(60_000);
      pendingP.catch(() => undefined);
      // Just assert no throw — the no-op path must not reach logger/metrics.
      pool.release(held);
      await pendingP;
    });
  });

  describe('resize observability', () => {
    it('emits info log + size gauge on resize()', () => {
      const logSpy = makeLoggerSpy();
      const metricsSpy = makeMetricsSpy();
      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 10,
        logger: logSpy.logger,
        metrics: metricsSpy.metrics,
        poolId: 'test-pool-b2',
      });
      pool.resize(3);

      const infoEntry = logSpy.info.find((e) => e.msg === 'pool resize');
      expect(infoEntry).toBeDefined();
      expect(infoEntry?.meta).toMatchObject({
        pool_id: 'test-pool-b2',
        from: 0,
        to: 3,
        active: 0,
        idle: 0,
      });

      const gaugeObservations = metricsSpy.gaugeCalls['harness.pool.size'] ?? [];
      expect(gaugeObservations.length).toBe(1);
      expect(gaugeObservations[0]).toMatchObject({
        value: 3,
        attrs: { pool_id: 'test-pool-b2' },
      });
    });

    it('trim path also logs + emits gauge', () => {
      const logSpy = makeLoggerSpy();
      const metricsSpy = makeMetricsSpy();
      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 10,
        logger: logSpy.logger,
        metrics: metricsSpy.metrics,
      });
      // Pre-warm to 3 idle, then trim to 1.
      pool.resize(3);
      logSpy.info.length = 0; // reset
      metricsSpy.gaugeCalls['harness.pool.size'] = [];

      pool.resize(1);
      const infoEntry = logSpy.info.find((e) => e.msg === 'pool resize');
      expect(infoEntry?.meta).toMatchObject({ from: 3, to: 1 });
      const gaugeObservations = metricsSpy.gaugeCalls['harness.pool.size'] ?? [];
      expect(gaugeObservations[0]?.value).toBe(1);
    });
  });

  describe('dispose-error observability', () => {
    it('emits warn + counter when an agent.dispose() rejects', async () => {
      const logSpy = makeLoggerSpy();
      const metricsSpy = makeMetricsSpy();
      const factory = makeFailingDisposeFactory();
      // Wrap so the returned loop's dispose rejects synchronously.
      const wrappedFactory = (): AgentLoop => {
        const loop = factory();
        (loop as unknown as { dispose: () => Promise<void> }).dispose = () =>
          Promise.reject(new Error('boom'));
        return loop;
      };
      pool = createAgentPool({
        factory: wrappedFactory,
        max: 3,
        logger: logSpy.logger,
        metrics: metricsSpy.metrics,
        poolId: 'test-pool-b3',
      });
      const a = pool.acquire();
      pool.release(a);
      await pool.dispose();
      // Give the microtask queue time to surface the rejection.
      await new Promise((r) => setTimeout(r, 10));

      const warnEntry = logSpy.warn.find((e) => e.msg === 'agent dispose failed');
      expect(warnEntry).toBeDefined();
      expect(warnEntry?.meta).toMatchObject({
        pool_id: 'test-pool-b3',
        error: { name: 'Error', message: 'boom' },
      });
      expect(warnEntry?.meta?.total_errors).toBeGreaterThanOrEqual(1);

      const counterObservations = metricsSpy.counterCalls['harness.pool.dispose_errors'] ?? [];
      expect(counterObservations.length).toBeGreaterThanOrEqual(1);
      expect(counterObservations[0]).toMatchObject({
        value: 1,
        attrs: { pool_id: 'test-pool-b3' },
      });
      // Null the pool reference so afterEach does not re-dispose.
      pool = undefined;
    });

    it('dispose error still increments stats.disposeErrors for back-compat', async () => {
      const factory = makeFailingDisposeFactory();
      const wrappedFactory = (): AgentLoop => {
        const loop = factory();
        (loop as unknown as { dispose: () => Promise<void> }).dispose = () =>
          Promise.reject(new Error('boom'));
        return loop;
      };
      pool = createAgentPool({ factory: wrappedFactory, max: 1 });
      const a = pool.acquire();
      pool.release(a);
      await pool.dispose();
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.stats.disposeErrors).toBeGreaterThanOrEqual(1);
      pool = undefined;
    });
  });

  describe('acquireAsync POOL_TIMEOUT span event', () => {
    it('attaches pool_acquire_timeout span event before POOL_TIMEOUT rejection', async () => {
      const addSpanEvent = vi.fn();
      const traceManager = {
        addSpanEvent,
      } as unknown as TraceManager;

      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 1,
        traceManager,
        poolId: 'test-pool-b4',
      });
      pool.acquire(); // exhaust

      await expect(
        pool.acquireAsync({ timeoutMs: 30, spanId: 'span-123' }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.POOL_TIMEOUT });

      expect(addSpanEvent).toHaveBeenCalledTimes(1);
      const [spanId, event] = addSpanEvent.mock.calls[0]!;
      expect(spanId).toBe('span-123');
      expect(event).toMatchObject({
        name: 'pool_acquire_timeout',
        attributes: {
          pool_id: 'test-pool-b4',
          timeout_ms: 30,
          active_agents: 1,
        },
      });
      // queue_depth is captured post-splice; the timed-out entry has already
      // been removed, so depth reported here is `0` for a single-requestor
      // scenario. We only assert the key exists.
      expect((event as { attributes: Record<string, unknown> }).attributes).toHaveProperty('queue_depth');
    });

    it('no span event when traceManager is absent', async () => {
      pool = createAgentPool({ factory: makeOkFactory(), max: 1, poolId: 'test-pool-b4-notrace' });
      pool.acquire();
      await expect(
        pool.acquireAsync({ timeoutMs: 30, spanId: 'ignored' }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.POOL_TIMEOUT });
      // No assertion beyond "didn't throw a different error": absence is the test.
    });

    it('no span event when spanId is absent (even with traceManager)', async () => {
      const addSpanEvent = vi.fn();
      const traceManager = { addSpanEvent } as unknown as TraceManager;
      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 1,
        traceManager,
      });
      pool.acquire();
      await expect(pool.acquireAsync({ timeoutMs: 30 })).rejects.toMatchObject({
        code: HarnessErrorCode.POOL_TIMEOUT,
      });
      expect(addSpanEvent).not.toHaveBeenCalled();
    });

    it('span event failure does not block POOL_TIMEOUT rejection', async () => {
      const traceManager = {
        addSpanEvent: () => {
          throw new Error('trace boom');
        },
      } as unknown as TraceManager;
      pool = createAgentPool({
        factory: makeOkFactory(),
        max: 1,
        traceManager,
      });
      pool.acquire();
      // Must reject with POOL_TIMEOUT even though the span hook throws.
      await expect(
        pool.acquireAsync({ timeoutMs: 30, spanId: 'bad-span' }),
      ).rejects.toMatchObject({ code: HarnessErrorCode.POOL_TIMEOUT });
    });
  });
});
