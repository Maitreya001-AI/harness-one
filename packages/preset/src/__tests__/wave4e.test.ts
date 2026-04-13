/**
 * Wave 4e fixes for the preset package:
 *  - ARCH-007: Harness.initialize() eager boot hook.
 *  - ARCH-010: Harness.eventBus deprecation (dead stub).
 */

import { describe, it, expect, vi } from 'vitest';
import { createHarness } from '../index.js';
import type { AgentAdapter } from 'harness-one/core';
import { HarnessError } from 'harness-one/core';

function stubAdapter(): AgentAdapter {
  return {
    async chat() {
      return {
        message: { role: 'assistant', content: 'hi' },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

describe('Harness.initialize() (ARCH-007)', () => {
  it('initialize() resolves without throwing when no exporters declare initialize()', async () => {
    const harness = createHarness({ adapter: stubAdapter(), logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await expect(harness.initialize?.()).resolves.toBeUndefined();
    await harness.shutdown();
  });

  it('initialize() is idempotent — concurrent calls share a single promise', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const harness = createHarness({ adapter: stubAdapter(), logger });
    const p1 = harness.initialize?.();
    const p2 = harness.initialize?.();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    await harness.shutdown();
  });

  it('initialize() can be called before run() and does not break it', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const harness = createHarness({ adapter: stubAdapter(), logger });
    await harness.initialize?.();
    let sawDone = false;
    for await (const ev of harness.run([{ role: 'user', content: 'hi' }])) {
      if (ev.type === 'done') sawDone = true;
    }
    expect(sawDone).toBe(true);
    await harness.shutdown();
  });
});

describe('Harness.eventBus deprecation (ARCH-010)', () => {
  it('first property access on eventBus logs a one-time warning', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const harness = createHarness({ adapter: stubAdapter(), logger });
    // Sanity: no eventBus warning has fired yet.
    let eventBusWarns = logger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('eventBus'),
    );
    expect(eventBusWarns.length).toBe(0);
    // Access a property on the stub — this traps through the Proxy and
    // fires the deprecation warning.
    const bus = harness.eventBus as unknown as { subscribe?: unknown };
    void bus.subscribe;
    void bus.subscribe; // second access — no additional warning.
    eventBusWarns = logger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('eventBus'),
    );
    expect(eventBusWarns.length).toBe(1);
    expect(String(eventBusWarns[0][0])).toContain('Harness.eventBus is deprecated');
  });

  it('invoking any method on the dead stub throws DEPRECATED_EVENT_BUS', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const harness = createHarness({ adapter: stubAdapter(), logger });
    const bus = harness.eventBus as unknown as {
      publish: (e: unknown) => void;
      subscribe: (h: (e: unknown) => void) => () => void;
    };
    expect(() => bus.publish({ type: 'x' })).toThrow(HarnessError);
    try {
      bus.publish({ type: 'x' });
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError);
      expect((err as HarnessError).code).toBe('DEPRECATED_EVENT_BUS');
    }
    expect(() => bus.subscribe(() => undefined)).toThrow(/DEPRECATED/i);
  });
});
