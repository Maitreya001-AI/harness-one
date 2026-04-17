/**
 * Public type surface for the session manager — the `SessionManager`
 * interface. Split out of `manager.ts` so the implementation file can focus
 * on state machinery.
 *
 * @module
 */

import type { Session, SessionEvent } from './types.js';

/** Manager for creating and tracking sessions. */
export interface SessionManager {
  /** Create a new session. */
  create(metadata?: Record<string, unknown>): Session;
  /** Get a session by ID (does not update lastAccessedAt). */
  get(id: string): Session | undefined;
  /** Access a session (updates lastAccessedAt). Throws if expired or locked. */
  access(id: string): Session;
  /** Lock a session for exclusive use. Returns an unlock function. */
  lock(id: string): { unlock: () => void };
  /** Destroy a session. */
  destroy(id: string): void;
  /** List all active sessions. */
  list(): Session[];
  /** Garbage collect expired sessions. Returns count removed. */
  gc(): number;

  /** Number of active sessions. */
  readonly activeSessions: number;
  /** Maximum allowed sessions. */
  readonly maxSessions: number;
  /** Number of events dropped due to reentrant event queue overflow. */
  readonly droppedEvents: number;
  /** Alias for `droppedEvents` — dedicated per-drop counter. */
  readonly droppedEventCount: number;
  /** Cumulative count of errors thrown by registered event handlers. */
  readonly handlerErrorCount: number;

  /** Register an event handler. Returns an unsubscribe function. */
  onEvent(handler: (event: SessionEvent) => void): () => void;

  /**
   * Diagnostic accessor returning the most recent event-handler error, along
   * with the event type that triggered it. Returns `undefined` when no
   * handler has thrown. Intended for debugging / health reporting — not for
   * control-flow decisions.
   */
  getLastHandlerError(): { error: unknown; eventType: SessionEvent['type'] } | undefined;

  /** Dispose the manager (clears auto-GC interval). */
  dispose(): void;
}
