/**
 * In-process event bus for decoupled component communication.
 *
 * @module
 */

/**
 * A handler function for a specific event type.
 * @deprecated The global event bus is not used by any module. Prefer per-module
 * event subscriptions (e.g. `sessions.onEvent()`). Will be removed in a future major version.
 */
export type EventHandler<T = unknown> = (data: T) => void;

/**
 * A simple synchronous pub/sub event bus.
 * @deprecated The global event bus is not used by any module. Each module
 * (sessions, orchestrator, etc.) exposes its own `onEvent()` subscription.
 * Prefer per-module event subscriptions instead. Will be removed in a future major version.
 */
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

/** Configuration options for creating an event bus. */
export interface EventBusOptions {
  /**
   * Optional callback invoked when a handler throws during emit().
   * Receives the event name and the error (normalized to an Error instance).
   * If not provided, handler errors are silently caught to prevent
   * one misbehaving handler from breaking event delivery.
   */
  onHandlerError?: (event: string, error: Error) => void;
}

/**
 * Create an in-process event bus.
 *
 * @deprecated The global event bus is not used by any module. Each module
 * (sessions, orchestrator, etc.) exposes its own `onEvent()` subscription.
 * Prefer per-module event subscriptions instead. Will be removed in a future major version.
 *
 * @example
 * ```ts
 * const bus = createEventBus();
 * const unsub = bus.on('user:login', (data) => console.log(data));
 * bus.emit('user:login', { userId: '123' });
 * unsub(); // unsubscribe
 * ```
 */
export function createEventBus(options?: EventBusOptions): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();
  const onHandlerError = options?.onHandlerError;

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
        const s = handlers.get(event);
        if (s) {
          s.delete(h);
          // Prevent memory leak: remove the empty Set from the Map so it
          // can be garbage-collected. Long-running apps with many
          // subscribe/unsubscribe cycles would otherwise accumulate empty
          // Sets for every event name ever used.
          if (s.size === 0) handlers.delete(event);
        }
      };
    },
    emit<T>(event: string, data: T): void {
      const set = handlers.get(event);
      if (set) {
        for (const h of set) {
          try {
            h(data);
          } catch (err) {
            if (onHandlerError) {
              // Wrap in try/catch so a throwing onHandlerError doesn't break
              // delivery of remaining handlers. Without this, the first
              // handler error + a buggy error-handler stops all subsequent
              // handlers from firing.
              try {
                onHandlerError(event, err instanceof Error ? err : new Error(String(err)));
              } catch {
                // onHandlerError itself threw — swallow to preserve delivery.
              }
            }
          }
        }
      }
    },
    off(event: string, handler: EventHandler): void {
      const s = handlers.get(event);
      if (s) {
        s.delete(handler);
        if (s.size === 0) handlers.delete(event);
      }
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
