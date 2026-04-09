/**
 * In-process event bus for decoupled component communication.
 *
 * @module
 */

/** A handler function for a specific event type. */
export type EventHandler<T = unknown> = (data: T) => void;

/** A simple synchronous pub/sub event bus. */
export interface EventBus {
  /** Subscribe to an event. Returns an unsubscribe function. */
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
  /** Emit an event to all registered handlers. */
  emit<T = unknown>(event: string, data: T): void;
  /** Remove a specific handler for an event. */
  off(event: string, handler: EventHandler): void;
  /** Remove all handlers for a specific event, or all handlers if no event given. */
  removeAll(event?: string): void;
}

/**
 * Create an in-process event bus.
 *
 * @example
 * ```ts
 * const bus = createEventBus();
 * const unsub = bus.on('user:login', (data) => console.log(data));
 * bus.emit('user:login', { userId: '123' });
 * unsub(); // unsubscribe
 * ```
 */
export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();

  return {
    on<T>(event: string, handler: EventHandler<T>): () => void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      const h = handler as EventHandler;
      set.add(h);
      return () => {
        handlers.get(event)?.delete(h);
      };
    },
    emit<T>(event: string, data: T): void {
      const set = handlers.get(event);
      if (set) {
        for (const h of set) h(data);
      }
    },
    off(event: string, handler: EventHandler): void {
      handlers.get(event)?.delete(handler);
    },
    removeAll(event?: string): void {
      if (event) {
        handlers.delete(event);
      } else {
        handlers.clear();
      }
    },
  };
}
