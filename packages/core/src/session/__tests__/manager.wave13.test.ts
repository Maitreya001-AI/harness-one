/**
 * Wave-13 Track E tests for session manager.
 *
 * Covers:
 * - E-1: handler-throw logging + getLastHandlerError()
 * - E-2: per-drop counter + rate-limited drop warnings
 * - E-3: maxMetadataBytes enforcement at create() time
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionManager } from '../manager.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';

describe('SessionManager Wave-13 E-1: handler error logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs via logger.error when handler throws', () => {
    const warnSpy = vi.fn();
    const errorSpy = vi.fn();
    const sm = createSessionManager({
      gcIntervalMs: 0,
      logger: { warn: warnSpy, error: errorSpy },
    });
    sm.onEvent(() => {
      throw new Error('handler-boom');
    });
    sm.create(); // triggers 'created' event -> handler throws

    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls[0];
    expect(call[0]).toContain('event handler threw');
    expect(call[1]).toMatchObject({ eventType: 'created', error: 'handler-boom' });
    sm.dispose();
  });

  it('falls back to logger.warn when logger.error absent', () => {
    const warnSpy = vi.fn();
    const sm = createSessionManager({ gcIntervalMs: 0, logger: { warn: warnSpy } });
    sm.onEvent(() => { throw new Error('no-error-fn'); });
    sm.create();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('event handler threw'))).toBe(true);
    sm.dispose();
  });

  it('exposes getLastHandlerError() with the most recent error', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    expect(sm.getLastHandlerError()).toBeUndefined();

    const err = new Error('latest-error');
    sm.onEvent(() => { throw err; });
    sm.create();

    const last = sm.getLastHandlerError();
    expect(last).toBeDefined();
    expect(last!.error).toBe(err);
    expect(last!.eventType).toBe('created');
    sm.dispose();
  });

  it('increments handlerErrorCount on each throw', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    sm.onEvent(() => { throw new Error('always'); });
    expect(sm.handlerErrorCount).toBe(0);
    const s = sm.create(); // created
    sm.destroy(s.id); // destroyed
    expect(sm.handlerErrorCount).toBeGreaterThanOrEqual(2);
    sm.dispose();
  });

  it('does not break event delivery on handler throw', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    const okHandler = vi.fn();
    sm.onEvent(() => { throw new Error('first-handler-fails'); });
    sm.onEvent(okHandler);
    sm.create();
    expect(okHandler).toHaveBeenCalled();
    sm.dispose();
  });
});

describe('SessionManager Wave-13 E-2: drop counter + rate-limited warnings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Helper that forces queue overflow by triggering a re-entrant emit from
   * inside a handler. We register a handler that calls `destroy()` for non-
   * existent IDs in a TIGHT loop within ONE handler invocation. Each
   * destroy() schedules an event that the outer emit loop will drain after
   * the current handler returns. Since the handler runs ONCE per emit, this
   * does not recurse — it just floods the pendingEvents queue past the
   * MAX_PENDING_EVENTS=1000 cap.
   */
  function floodQueue(
    sm: ReturnType<typeof createSessionManager>,
    count: number,
  ): void {
    let fired = false;
    const off = sm.onEvent(() => {
      if (fired) return; // only flood ONCE — don't run again on the drained events
      fired = true;
      for (let i = 0; i < count; i++) {
        sm.destroy('nonexistent-' + i);
      }
    });
    sm.create(); // triggers initial emit -> handler runs once -> floods queue
    off();
  }

  it('increments droppedEventCount on each overflow', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    floodQueue(sm, 1500); // 1500 destroy() events; first ~1000 fit, ~500 dropped
    expect(sm.droppedEventCount).toBeGreaterThan(0);
    sm.dispose();
  });

  it('droppedEventCount alias mirrors droppedEvents', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    expect(sm.droppedEventCount).toBe(sm.droppedEvents);
    floodQueue(sm, 1500);
    expect(sm.droppedEventCount).toBe(sm.droppedEvents);
    sm.dispose();
  });

  it('rate-limits warnings to at most ~1 per second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const warnSpy = vi.fn();
    const sm = createSessionManager({
      gcIntervalMs: 0,
      logger: { warn: warnSpy },
    });
    floodQueue(sm, 1500);

    const dropWarns = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('event dropped'),
    );
    // Many drops happened within the same wall-clock ms → at most 1 warn.
    expect(dropWarns.length).toBeLessThanOrEqual(1);
    expect(sm.droppedEventCount).toBeGreaterThan(0);
    sm.dispose();
  });

  it('emits a second warning after the rate-limit interval elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const warnSpy = vi.fn();
    const sm = createSessionManager({
      gcIntervalMs: 0,
      logger: { warn: warnSpy },
    });

    floodQueue(sm, 1500);
    const firstCount = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('event dropped'),
    ).length;

    // Advance past the rate-limit window.
    vi.setSystemTime(new Date(Date.now() + 2000));

    floodQueue(sm, 1500);
    const totalCount = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('event dropped'),
    ).length;
    expect(totalCount).toBeGreaterThan(firstCount);
    sm.dispose();
  });
});

describe('SessionManager Wave-13 E-3: maxMetadataBytes', () => {
  it('rejects metadata larger than maxMetadataBytes at create()', () => {
    const sm = createSessionManager({
      gcIntervalMs: 0,
      maxMetadataBytes: 100,
    });
    const big = { blob: 'x'.repeat(500) };
    expect(() => sm.create(big)).toThrow(HarnessError);
    try {
      sm.create(big);
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_INPUT);
    }
    sm.dispose();
  });

  it('allows metadata within the cap', () => {
    const sm = createSessionManager({ gcIntervalMs: 0, maxMetadataBytes: 10_000 });
    expect(() => sm.create({ userId: 'alice' })).not.toThrow();
    sm.dispose();
  });

  it('no-op when maxMetadataBytes is undefined', () => {
    const sm = createSessionManager({ gcIntervalMs: 0 });
    expect(() => sm.create({ big: 'x'.repeat(100_000) })).not.toThrow();
    sm.dispose();
  });

  it('rejects non-serializable metadata with CORE_INVALID_INPUT', () => {
    const sm = createSessionManager({ gcIntervalMs: 0, maxMetadataBytes: 100 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => sm.create(cyclic)).toThrow(HarnessError);
    sm.dispose();
  });
});
