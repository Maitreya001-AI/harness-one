/**
 * Tests for `createShutdownHandler` — SIGTERM/SIGINT registration.
 *
 * Production behaviour exercised:
 * - Listener registration / cleanup pair (no leaked listeners across tests).
 * - Signal handler invokes `harness.drain(timeoutMs)` with the configured
 *   timeout.
 * - Reentry path: second SIGTERM during in-flight drain force-exits.
 * - Error path: drain rejection is logged and surfaces a non-zero exit code.
 * - Custom `onEvent` overrides the default console.error sink.
 *
 * Always runs with `exit: false` so the test process is never killed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createShutdownHandler } from '../shutdown.js';
import type { Harness } from '../index.js';

function stubHarness(drainImpl?: (timeoutMs?: number) => Promise<void>): Pick<Harness, 'drain'> {
  return {
    drain: drainImpl ?? (async () => undefined),
  };
}

// Each test must clean up its listeners — leaks would surface as
// EventEmitter MaxListenersExceededWarning across the suite.
let cleanupFns: Array<() => void> = [];

beforeEach(() => {
  cleanupFns = [];
});

afterEach(() => {
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
});

describe('createShutdownHandler', () => {
  it('registers SIGTERM and SIGINT listeners, returns cleanup that removes them', () => {
    const before = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    const cleanup = createShutdownHandler(stubHarness(), { exit: false });
    cleanupFns.push(cleanup);
    const during = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    expect(during - before).toBe(2);

    cleanup();
    cleanupFns.pop(); // already cleaned

    const after = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });

  it('SIGTERM triggers harness.drain(timeoutMs)', async () => {
    const drain = vi.fn(async () => undefined);
    const events: string[] = [];
    const cleanup = createShutdownHandler(stubHarness(drain), {
      exit: false,
      timeoutMs: 12_345,
      onEvent: (m) => events.push(m),
    });
    cleanupFns.push(cleanup);

    process.emit('SIGTERM' as unknown as 'beforeExit');
    // drain() is invoked synchronously inside the handler; await microtasks.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith(12_345);
    expect(events.some((m) => m.includes('SIGTERM') && m.includes('12345'))).toBe(true);
    expect(events.some((m) => m.includes('Graceful shutdown complete'))).toBe(true);
  });

  it('SIGINT also triggers drain (separate signal path)', async () => {
    const drain = vi.fn(async () => undefined);
    const events: string[] = [];
    const cleanup = createShutdownHandler(stubHarness(drain), {
      exit: false,
      onEvent: (m) => events.push(m),
    });
    cleanupFns.push(cleanup);

    process.emit('SIGINT' as unknown as 'beforeExit');
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(drain).toHaveBeenCalledTimes(1);
    expect(events.some((m) => m.includes('SIGINT'))).toBe(true);
  });

  it('second signal during in-flight shutdown logs "forcing exit"', async () => {
    // First signal starts an awaitable drain; a second signal arrives while
    // drain is still pending. The handler should log a force-exit message
    // and (with exit:false) return without calling drain a second time.
    let releaseDrain: (() => void) | undefined;
    const drain = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
    const events: string[] = [];
    const cleanup = createShutdownHandler(stubHarness(drain), {
      exit: false,
      onEvent: (m) => events.push(m),
    });
    cleanupFns.push(cleanup);

    process.emit('SIGTERM' as unknown as 'beforeExit');
    process.emit('SIGTERM' as unknown as 'beforeExit'); // re-entry
    expect(drain).toHaveBeenCalledTimes(1);
    expect(events.some((m) => m.includes('again during shutdown'))).toBe(true);
    expect(events.some((m) => m.includes('forcing exit'))).toBe(true);

    // Release the in-flight drain so afterEach doesn't dangle.
    releaseDrain?.();
    await new Promise<void>((r) => setImmediate(r));
  });

  it('drain rejection is logged with the error message', async () => {
    const drain = vi.fn(async () => {
      throw new Error('drain failed: store down');
    });
    const events: string[] = [];
    const cleanup = createShutdownHandler(stubHarness(drain), {
      exit: false,
      onEvent: (m) => events.push(m),
    });
    cleanupFns.push(cleanup);

    process.emit('SIGTERM' as unknown as 'beforeExit');
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(events.some((m) => m.includes('Shutdown error') && m.includes('store down'))).toBe(true);
  });

  it('non-Error throw in drain is stringified', async () => {
    const drain = vi.fn(async () => {
      throw 'plain string';
    });
    const events: string[] = [];
    const cleanup = createShutdownHandler(stubHarness(drain), {
      exit: false,
      onEvent: (m) => events.push(m),
    });
    cleanupFns.push(cleanup);

    process.emit('SIGTERM' as unknown as 'beforeExit');
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(events.some((m) => m.includes('Shutdown error') && m.includes('plain string'))).toBe(true);
  });

  it('default onEvent uses console.error (covers the default logger branch)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const drain = vi.fn(async () => undefined);
    const cleanup = createShutdownHandler(stubHarness(drain), { exit: false });
    cleanupFns.push(cleanup);

    process.emit('SIGTERM' as unknown as 'beforeExit');
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('uses default 30s timeout when not specified', async () => {
    const drain = vi.fn(async () => undefined);
    const cleanup = createShutdownHandler(stubHarness(drain), { exit: false });
    cleanupFns.push(cleanup);

    process.emit('SIGTERM' as unknown as 'beforeExit');
    await new Promise<void>((r) => setImmediate(r));

    expect(drain).toHaveBeenCalledWith(30_000);
  });
});
