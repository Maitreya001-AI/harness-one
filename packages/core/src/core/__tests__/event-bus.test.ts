import { describe, it, expect, vi } from 'vitest';
import { createEventBus } from '../event-bus.js';

describe('createEventBus', () => {
  describe('on / emit', () => {
    it('delivers events to subscribed handlers', () => {
      const bus = createEventBus();
      const handler = vi.fn();
      bus.on('test', handler);
      bus.emit('test', { value: 42 });

      expect(handler).toHaveBeenCalledWith({ value: 42 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('supports multiple handlers for the same event', () => {
      const bus = createEventBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('evt', h1);
      bus.on('evt', h2);
      bus.emit('evt', 'data');

      expect(h1).toHaveBeenCalledWith('data');
      expect(h2).toHaveBeenCalledWith('data');
    });

    it('does not deliver events to handlers for different events', () => {
      const bus = createEventBus();
      const handler = vi.fn();
      bus.on('a', handler);
      bus.emit('b', 'data');

      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers multiple emissions', () => {
      const bus = createEventBus();
      const handler = vi.fn();
      bus.on('x', handler);
      bus.emit('x', 1);
      bus.emit('x', 2);
      bus.emit('x', 3);

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenNthCalledWith(1, 1);
      expect(handler).toHaveBeenNthCalledWith(2, 2);
      expect(handler).toHaveBeenNthCalledWith(3, 3);
    });

    it('handles emit with no subscribers gracefully', () => {
      const bus = createEventBus();
      // Should not throw
      expect(() => bus.emit('nonexistent', 'data')).not.toThrow();
    });
  });

  describe('on returns unsubscribe function', () => {
    it('stops receiving events after unsubscribe', () => {
      const bus = createEventBus();
      const handler = vi.fn();
      const unsub = bus.on('test', handler);

      bus.emit('test', 'before');
      unsub();
      bus.emit('test', 'after');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('before');
    });

    it('does not affect other handlers when one unsubscribes', () => {
      const bus = createEventBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub1 = bus.on('evt', h1);
      bus.on('evt', h2);

      unsub1();
      bus.emit('evt', 'data');

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledWith('data');
    });
  });

  describe('off', () => {
    it('removes a specific handler', () => {
      const bus = createEventBus();
      const handler = vi.fn();
      bus.on('test', handler);
      bus.off('test', handler);
      bus.emit('test', 'data');

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not throw for unknown event', () => {
      const bus = createEventBus();
      const handler = vi.fn();
      expect(() => bus.off('unknown', handler)).not.toThrow();
    });

    it('does not throw for unregistered handler', () => {
      const bus = createEventBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('test', h1);
      // h2 was never registered
      expect(() => bus.off('test', h2)).not.toThrow();
    });
  });

  describe('removeAll', () => {
    it('removes all handlers for a specific event', () => {
      const bus = createEventBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('a', h1);
      bus.on('a', h2);

      bus.removeAll('a');
      bus.emit('a', 'data');

      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });

    it('does not affect other events when removing specific event', () => {
      const bus = createEventBus();
      const hA = vi.fn();
      const hB = vi.fn();
      bus.on('a', hA);
      bus.on('b', hB);

      bus.removeAll('a');
      bus.emit('a', 'data');
      bus.emit('b', 'data');

      expect(hA).not.toHaveBeenCalled();
      expect(hB).toHaveBeenCalledWith('data');
    });

    it('removes all handlers across all events when called without argument', () => {
      const bus = createEventBus();
      const hA = vi.fn();
      const hB = vi.fn();
      bus.on('a', hA);
      bus.on('b', hB);

      bus.removeAll();
      bus.emit('a', 'data');
      bus.emit('b', 'data');

      expect(hA).not.toHaveBeenCalled();
      expect(hB).not.toHaveBeenCalled();
    });

    it('does not throw for unknown event', () => {
      const bus = createEventBus();
      expect(() => bus.removeAll('nonexistent')).not.toThrow();
    });
  });

  describe('type safety', () => {
    it('passes typed data through to handler', () => {
      const bus = createEventBus();
      const handler = vi.fn<[{ userId: string }]>();
      bus.on<{ userId: string }>('login', handler);
      bus.emit<{ userId: string }>('login', { userId: 'u-1' });

      expect(handler).toHaveBeenCalledWith({ userId: 'u-1' });
    });
  });
});
