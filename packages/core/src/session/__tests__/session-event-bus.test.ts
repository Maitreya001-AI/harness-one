/**
 * Unit tests for the extracted session event bus. Pins re-entry
 * protection, priority-aware drop, rate-limited warnings, and
 * handler-exception counting.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSessionEventBus } from '../session-event-bus.js';
import type { SessionEvent } from '../types.js';
import type { SessionId } from '../../core/types.js';

function makeEvent(
  type: SessionEvent['type'],
  id: SessionId = 'sess_' as SessionId,
): SessionEvent {
  return { type, sessionId: id, timestamp: Date.now() };
}

describe('createSessionEventBus', () => {
  it('dispatches events to registered handlers in insertion order', () => {
    const bus = createSessionEventBus();
    const order: string[] = [];
    bus.onEvent(() => order.push('a'));
    bus.onEvent(() => order.push('b'));
    bus.emit(makeEvent('created'));
    expect(order).toEqual(['a', 'b']);
  });

  it('unsubscribe removes the handler', () => {
    const bus = createSessionEventBus();
    const h = vi.fn();
    const off = bus.onEvent(h);
    off();
    bus.emit(makeEvent('created'));
    expect(h).not.toHaveBeenCalled();
  });

  it('queues re-entrant emits and drains after the outer emit', () => {
    const bus = createSessionEventBus();
    const order: string[] = [];
    bus.onEvent((e) => {
      order.push(`outer:${e.type}`);
      if (e.type === 'created') {
        bus.emit(makeEvent('accessed'));
      }
    });
    bus.emit(makeEvent('created'));
    expect(order).toEqual(['outer:created', 'outer:accessed']);
  });

  it('counts dropped events when the pending queue overflows', () => {
    const bus = createSessionEventBus({ maxPendingEvents: 2 });
    let depth = 0;
    bus.onEvent(() => {
      depth++;
      if (depth === 1) {
        // Fill the queue with 3 low-priority events; the third is dropped.
        bus.emit(makeEvent('accessed'));
        bus.emit(makeEvent('accessed'));
        bus.emit(makeEvent('accessed'));
      }
    });
    bus.emit(makeEvent('created'));
    expect(bus.droppedEventCount()).toBe(1);
  });

  it('evicts a queued low-priority event to admit a high-priority one', () => {
    const seen: SessionEvent['type'][] = [];
    const bus = createSessionEventBus({ maxPendingEvents: 1 });
    let depth = 0;
    bus.onEvent((e) => {
      seen.push(e.type);
      depth++;
      if (depth === 1) {
        bus.emit(makeEvent('accessed'));       // queued
        bus.emit(makeEvent('destroyed'));      // evicts the low-prio queued one
      }
    });
    bus.emit(makeEvent('created'));
    // Drain order: outer 'created', then 'destroyed' (eviction winner).
    expect(seen).toEqual(['created', 'destroyed']);
    expect(bus.droppedEventCount()).toBe(1);
  });

  it('logs handler exceptions and records the last error', () => {
    const warn = vi.fn();
    const error = vi.fn();
    const bus = createSessionEventBus({ logger: { warn, error } });
    const boom = new Error('kaboom');
    bus.onEvent(() => { throw boom; });
    bus.emit(makeEvent('created'));
    expect(error).toHaveBeenCalled();
    expect(bus.handlerErrorCount()).toBe(1);
    expect(bus.getLastHandlerError()?.error).toBe(boom);
  });

  it('tolerates a throwing logger (logger failure must not abort dispatch)', () => {
    const warn = vi.fn(() => { throw new Error('bad logger'); });
    const bus = createSessionEventBus({ logger: { warn } });
    const seen: SessionEvent['type'][] = [];
    bus.onEvent((e) => { seen.push(e.type); });
    bus.onEvent(() => { throw new Error('handler'); });
    expect(() => bus.emit(makeEvent('created'))).not.toThrow();
    expect(seen).toContain('created');
  });

  it('dispose clears handlers and pending events', () => {
    const bus = createSessionEventBus();
    const h = vi.fn();
    bus.onEvent(h);
    bus.dispose();
    bus.emit(makeEvent('created'));
    expect(h).not.toHaveBeenCalled();
  });
});
