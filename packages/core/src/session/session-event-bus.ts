/**
 * Event-dispatch machinery for {@link SessionManager}.
 *
 * Extracted from `session/manager.ts` so the manager body reads as
 * "session lifecycle" instead of interleaving three concerns (LRU,
 * locking, events). The bus owns:
 *
 * - Handler registration (`Set<Handler>` for O(1) add/remove, stable
 *   insertion-order iteration).
 * - Re-entry protection: if a handler synchronously triggers another
 *   `emit()`, the inner event is queued and drained after the outer
 *   emit completes. Cap the queue to prevent unbounded growth when a
 *   handler loops itself.
 * - Priority-aware drop policy: `created` / `destroyed` / `expired` /
 *   `evicted` are lifecycle-critical. When the queue is full and a
 *   high-priority event arrives, we evict the oldest low-priority
 *   queued event to make room instead of dropping the high one.
 * - Rate-limited drop warnings (1/sec per independent window) so ops
 *   see signal without a log storm; every drop still increments a
 *   counter the manager surfaces via `droppedEventCount`.
 * - Handler-exception tracking: count + last-error for diagnosis via
 *   `handlerErrorCount` / `getLastHandlerError()`.
 *
 * @module
 */

import type { SessionEvent } from './types.js';

export interface SessionEventBusLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface SessionEventBusConfig {
  /** Optional structured logger. Drop warnings route here. */
  readonly logger?: SessionEventBusLogger;
  /** Maximum queued events during re-entrant emission. Default 1000. */
  readonly maxPendingEvents?: number;
  /** Minimum milliseconds between consecutive drop warnings. Default 1000. */
  readonly dropWarnIntervalMs?: number;
}

export interface SessionEventBus {
  /** Synchronously emit an event to every registered handler. */
  readonly emit: (event: SessionEvent) => void;
  /** Register a handler. Returns an unsubscribe function. */
  readonly onEvent: (handler: (e: SessionEvent) => void) => () => void;
  /** Cumulative number of events dropped due to queue overflow. */
  readonly droppedEventCount: () => number;
  /** Cumulative number of handler exceptions. */
  readonly handlerErrorCount: () => number;
  /** Most recent handler exception (error + triggering event type). */
  readonly getLastHandlerError: () => { error: unknown; eventType: SessionEvent['type'] } | undefined;
  /** Clear handlers and internal queue. Used by `SessionManager.dispose()`. */
  readonly dispose: () => void;
}

const HIGH_PRIORITY_EVENTS: ReadonlySet<SessionEvent['type']> = new Set([
  'created',
  'destroyed',
  'expired',
  'evicted',
]);

function isHighPriority(type: SessionEvent['type']): boolean {
  return HIGH_PRIORITY_EVENTS.has(type);
}

export function createSessionEventBus(
  config: SessionEventBusConfig = {},
): SessionEventBus {
  const logger = config.logger;
  const MAX_PENDING_EVENTS = config.maxPendingEvents ?? 1000;
  const DROP_WARN_INTERVAL_MS = config.dropWarnIntervalMs ?? 1000;

  const handlers = new Set<(e: SessionEvent) => void>();
  let emitting = false;
  const pendingEvents: SessionEvent[] = [];
  let droppedEvents = 0;
  let handlerErrors = 0;
  let lastHandlerError: { error: unknown; eventType: SessionEvent['type'] } | undefined;
  let lastDropWarnAt = 0;
  let lastEvictionWarnAt = 0;

  function dispatchToHandlers(event: SessionEvent): void {
    const snapshot = [...handlers];
    for (const handler of snapshot) {
      try {
        handler(event);
      } catch (err) {
        handlerErrors++;
        lastHandlerError = { error: err, eventType: event.type };
        if (logger) {
          const logFn = logger.error ?? logger.warn;
          try {
            logFn('[harness-one/session-manager] event handler threw', {
              eventType: event.type,
              error: err instanceof Error ? err.message : String(err),
              handlerErrorCount: handlerErrors,
            });
          } catch {
            /* noop: logger failure is non-fatal and there is no further channel */
          }
        }
      }
    }
  }

  function emit(event: SessionEvent): void {
    if (emitting) {
      if (pendingEvents.length >= MAX_PENDING_EVENTS) {
        // Priority-aware drop: if the new event is HIGH and at least one LOW
        // is queued, evict the oldest LOW to admit the HIGH.
        if (isHighPriority(event.type)) {
          const lowIdx = pendingEvents.findIndex((e) => !isHighPriority(e.type));
          if (lowIdx !== -1) {
            pendingEvents.splice(lowIdx, 1);
            droppedEvents++;
            const now = Date.now();
            if (logger && now - lastEvictionWarnAt >= DROP_WARN_INTERVAL_MS) {
              lastEvictionWarnAt = now;
              try {
                logger.warn(
                  '[harness-one/session-manager] low-priority event evicted to admit high-priority event',
                  {
                    evictedType: 'low',
                    admittedType: event.type,
                    droppedEventCount: droppedEvents,
                  },
                );
              } catch {
                /* noop: logger failure is non-fatal */
              }
            }
            pendingEvents.push(event);
            return;
          }
        }
        droppedEvents++;
        if (logger) {
          const now = Date.now();
          if (now - lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
            lastDropWarnAt = now;
            try {
              logger.warn('[harness-one/session-manager] event dropped — pending queue overflow', {
                maxPendingEvents: MAX_PENDING_EVENTS,
                droppedType: event.type,
                droppedEventCount: droppedEvents,
              });
            } catch {
              /* noop: logger failure is non-fatal */
            }
          }
        }
        return;
      }
      pendingEvents.push(event);
      return;
    }

    emitting = true;
    try {
      dispatchToHandlers(event);
      while (pendingEvents.length > 0) {
        const queued = pendingEvents.shift() as SessionEvent;
        dispatchToHandlers(queued);
      }
    } finally {
      emitting = false;
    }
  }

  return {
    emit,
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    droppedEventCount: () => droppedEvents,
    handlerErrorCount: () => handlerErrors,
    getLastHandlerError: () => lastHandlerError,
    dispose(): void {
      handlers.clear();
      pendingEvents.length = 0;
    },
  };
}
