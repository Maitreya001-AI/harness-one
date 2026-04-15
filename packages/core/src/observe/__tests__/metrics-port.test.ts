import { describe, it, expect } from 'vitest';
import { createNoopMetricsPort } from '../metrics-port.js';

describe('createNoopMetricsPort (Wave-5D ARCH-5)', () => {
  it('hands out instruments that silently discard observations', () => {
    const m = createNoopMetricsPort();
    const c = m.counter('harness.iterations.total', { description: 'iters' });
    const g = m.gauge('harness.inflight.requests');
    const h = m.histogram('harness.iteration.latency.ms', { unit: 'ms' });
    // None of these should throw, and none should observe any side effect.
    expect(() => {
      c.add(1);
      c.add(5, { tenant: 'a', path: 'chat' });
      g.record(42);
      h.record(123);
    }).not.toThrow();
  });
});
