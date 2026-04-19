import { describe, it, expect } from 'vitest';
import { createHarnessLifecycle } from '../lifecycle.js';

describe('createHarnessLifecycle', () => {
  it('starts in init and tolerates health() before any component is registered', async () => {
    const lc = createHarnessLifecycle();
    expect(lc.status()).toBe('init');
    const h = await lc.health();
    expect(h.state).toBe('init');
    expect(h.ready).toBe(false);
    expect(Object.keys(h.components)).toEqual([]);
  });

  it('follows the init → ready → draining → shutdown happy path', () => {
    const lc = createHarnessLifecycle();
    lc.markReady();
    expect(lc.status()).toBe('ready');
    lc.beginDrain();
    expect(lc.status()).toBe('draining');
    lc.completeShutdown();
    expect(lc.status()).toBe('shutdown');
  });

  it('rejects invalid transitions with CORE_INVALID_STATE', () => {
    const lc = createHarnessLifecycle();
    expect(() => lc.beginDrain()).toThrow(/Invalid lifecycle transition init/);
    lc.markReady();
    expect(() => lc.markReady()).toThrow(/Invalid lifecycle transition ready/);
    lc.beginDrain();
    expect(() => lc.beginDrain()).toThrow(/Invalid lifecycle transition draining/);
  });

  it('forceShutdown jumps from any state terminally', () => {
    const lc = createHarnessLifecycle();
    lc.forceShutdown();
    expect(lc.status()).toBe('shutdown');
    // idempotent
    lc.forceShutdown();
    expect(lc.status()).toBe('shutdown');
  });

  it('health() aggregates component probes and catches thrown probes as down', async () => {
    const lc = createHarnessLifecycle();
    lc.registerHealthCheck('adapter', () => ({ status: 'up' }));
    lc.registerHealthCheck('exporter', async () => ({ status: 'degraded', detail: 'slow flush' }));
    lc.registerHealthCheck('store', () => {
      throw new Error('disk full');
    });
    const h = await lc.health();
    expect(h.components['adapter']).toEqual({ status: 'up' });
    expect(h.components['exporter']).toEqual({ status: 'degraded', detail: 'slow flush' });
    expect(h.components['store']).toEqual({ status: 'down', detail: 'disk full' });
  });
});
