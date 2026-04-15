/**
 * Wave 4e fixes for the preset package:
 *  - ARCH-007: Harness.initialize() eager boot hook.
 *  - ARCH-010: Harness.eventBus deprecation (dead stub) — REMOVED in Wave-5C.
 *    The eventBus property is no longer part of the Harness surface; the
 *    earlier deprecation-warning and DEPRECATED_EVENT_BUS tests were deleted
 *    along with the stub.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHarness } from '../index.js';
import type { AgentAdapter } from 'harness-one/core';

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

// Wave-5C T-1.6: Harness.eventBus deprecation (ARCH-010) — the dead-stub
// Proxy, DEPRECATED_EVENT_BUS error code, and all associated tests were
// removed. Preset no longer exposes an `eventBus` field. Per-module
// `onEvent()` subscriptions replace the global bus.
