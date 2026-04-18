/**
 * Wave-13 Track B-5: message-queue observability tests.
 *
 * Covers:
 *  - `harness.orch.queue_depth` gauge emitted on every push, keyed by agent_id.
 *  - `harness.orch.queue_dropped` counter incremented on drops, keyed by agent_id.
 *  - Structured warn log on drop events when a logger is injected.
 *  - Backward compatibility: no logger/metrics → zero observability traffic.
 */
import { describe, it, expect } from 'vitest';
import { createMessageQueue } from '../message-queue.js';
import type {
  MetricsPort,
  MetricCounter,
  MetricGauge,
  MetricAttributes,
} from '../../observe/metrics-port.js';
import type { Logger } from '../../observe/logger.js';
import type { AgentMessage } from '../types.js';

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    from: 'sender',
    to: 'receiver',
    type: 'request',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

interface LoggerSpy {
  logger: Logger;
  warn: Array<{ msg: string; meta?: Readonly<Record<string, unknown>> }>;
}

function makeLoggerSpy(): LoggerSpy {
  const spy: LoggerSpy = { logger: undefined as unknown as Logger, warn: [] };
  spy.logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, meta) => { spy.warn.push({ msg, ...(meta !== undefined && { meta }) }); },
    error: () => {},
    child: () => spy.logger,
  };
  return spy;
}

interface MetricsSpy {
  metrics: MetricsPort;
  counter: Record<string, Array<{ value: number; attrs?: MetricAttributes }>>;
  gauge: Record<string, Array<{ value: number; attrs?: MetricAttributes }>>;
}

function makeMetricsSpy(): MetricsSpy {
  const counterMap: MetricsSpy['counter'] = {};
  const gaugeMap: MetricsSpy['gauge'] = {};
  const metrics: MetricsPort = {
    counter(name: string): MetricCounter {
      if (!counterMap[name]) counterMap[name] = [];
      return { add(value, attrs) { counterMap[name]!.push({ value, ...(attrs !== undefined && { attrs }) }); } };
    },
    gauge(name: string): MetricGauge {
      if (!gaugeMap[name]) gaugeMap[name] = [];
      return { record(value, attrs) { gaugeMap[name]!.push({ value, ...(attrs !== undefined && { attrs }) }); } };
    },
    histogram(name: string) {
      return { record() { void name; } };
    },
  };
  return { metrics, counter: counterMap, gauge: gaugeMap };
}

describe('MessageQueue — Wave-13 B-5 observability', () => {
  it('Wave-13 B-5: emits queue_depth gauge on every push keyed by agent_id', () => {
    const metricsSpy = makeMetricsSpy();
    const mq = createMessageQueue({ metrics: metricsSpy.metrics });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    mq.push('a1', makeMessage({ to: 'a1' }));
    mq.createQueue('a2');
    mq.push('a2', makeMessage({ to: 'a2' }));

    const observations = metricsSpy.gauge['harness.orch.queue_depth'] ?? [];
    expect(observations.length).toBe(3);
    expect(observations[0]).toEqual({ value: 1, attrs: { agent_id: 'a1' } });
    expect(observations[1]).toEqual({ value: 2, attrs: { agent_id: 'a1' } });
    expect(observations[2]).toEqual({ value: 1, attrs: { agent_id: 'a2' } });
  });

  it('Wave-13 B-5: gauge observation uses post-mutation depth', () => {
    const metricsSpy = makeMetricsSpy();
    const mq = createMessageQueue({ maxQueueSize: 2, metrics: metricsSpy.metrics });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    mq.push('a1', makeMessage({ to: 'a1' }));
    // Third push triggers drop-oldest then pushes; depth stays at 2 afterward.
    mq.push('a1', makeMessage({ to: 'a1' }));
    const observations = metricsSpy.gauge['harness.orch.queue_depth'] ?? [];
    expect(observations[2]).toEqual({ value: 2, attrs: { agent_id: 'a1' } });
  });

  it('Wave-13 B-5: emits drop counter on overflow keyed by agent_id', () => {
    const metricsSpy = makeMetricsSpy();
    const mq = createMessageQueue({ maxQueueSize: 1, metrics: metricsSpy.metrics });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    mq.push('a1', makeMessage({ to: 'a1' })); // drop 1
    mq.push('a1', makeMessage({ to: 'a1' })); // drop 2

    const drops = metricsSpy.counter['harness.orch.queue_dropped'] ?? [];
    expect(drops.length).toBe(2);
    expect(drops[0]).toEqual({ value: 1, attrs: { agent_id: 'a1' } });
    expect(drops[1]).toEqual({ value: 1, attrs: { agent_id: 'a1' } });
  });

  it('Wave-13 B-5: emits structured warn log on drop when logger is injected', () => {
    const logSpy = makeLoggerSpy();
    const mq = createMessageQueue({ maxQueueSize: 1, logger: logSpy.logger });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    mq.push('a1', makeMessage({ to: 'a1' }));

    const warn = logSpy.warn.find((e) => e.msg === 'message-queue drop');
    expect(warn).toBeDefined();
    expect(warn?.meta).toMatchObject({
      agent_id: 'a1',
      dropped_count: 1,
      max_queue_size: 1,
    });
  });

  it('Wave-13 B-5: logger + metrics coexist with existing onWarning/onEvent callbacks', () => {
    const logSpy = makeLoggerSpy();
    const metricsSpy = makeMetricsSpy();
    const onWarning: Array<{ droppedCount: number }> = [];
    const onEvent: Array<{ agentId: string; droppedCount: number }> = [];
    const mq = createMessageQueue({
      maxQueueSize: 1,
      logger: logSpy.logger,
      metrics: metricsSpy.metrics,
      onWarning: (w) => { onWarning.push(w); },
      onEvent: (e) => { if (e.type === 'message_dropped') onEvent.push({ agentId: e.agentId, droppedCount: e.droppedCount }); },
    });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    mq.push('a1', makeMessage({ to: 'a1' })); // drop

    expect(onWarning.length).toBe(1);
    expect(onEvent.length).toBe(1);
    expect(logSpy.warn.length).toBe(1);
    expect((metricsSpy.counter['harness.orch.queue_dropped'] ?? []).length).toBe(1);
  });

  it('Wave-13 B-5: no observability traffic when logger/metrics absent', () => {
    // Smoke test: the no-op path must not throw even under heavy churn.
    const mq = createMessageQueue({ maxQueueSize: 1 });
    mq.createQueue('a1');
    for (let i = 0; i < 10; i++) {
      expect(mq.push('a1', makeMessage({ to: 'a1' }))).toBe(true);
    }
    expect(mq.size('a1')).toBe(1);
  });

  it('Wave-13 B-5: logger exceptions do not break drop path', () => {
    const mq = createMessageQueue({
      maxQueueSize: 1,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => { throw new Error('logger boom'); },
        error: () => {},
        child: () => ({
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({
            debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => ({} as unknown as Logger),
          }),
        }),
      },
    });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    // Should not throw even though logger.warn does.
    expect(() => mq.push('a1', makeMessage({ to: 'a1' }))).not.toThrow();
  });

  it('Wave-13 B-5: depth gauge not emitted when push rejected in backpressure mode', () => {
    const metricsSpy = makeMetricsSpy();
    const mq = createMessageQueue({ maxQueueSize: 1, backpressure: true, metrics: metricsSpy.metrics });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    // Backpressure mode: second push throws and depth should NOT receive a
    // post-push observation for the rejected call.
    expect(() => mq.push('a1', makeMessage({ to: 'a1' }))).toThrow();
    const observations = metricsSpy.gauge['harness.orch.queue_depth'] ?? [];
    // Only the successful first push should have recorded depth.
    expect(observations).toEqual([{ value: 1, attrs: { agent_id: 'a1' } }]);
  });

  it('Wave-13 B-5: drop counter not emitted in backpressure mode (throws instead)', () => {
    const metricsSpy = makeMetricsSpy();
    const mq = createMessageQueue({ maxQueueSize: 1, backpressure: true, metrics: metricsSpy.metrics });
    mq.createQueue('a1');
    mq.push('a1', makeMessage({ to: 'a1' }));
    expect(() => mq.push('a1', makeMessage({ to: 'a1' }))).toThrow();
    const drops = metricsSpy.counter['harness.orch.queue_dropped'] ?? [];
    expect(drops.length).toBe(0);
  });
});
