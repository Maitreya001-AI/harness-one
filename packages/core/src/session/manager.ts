/**
 * Session management with TTL, LRU eviction, and prompt locking.
 *
 * @module
 */

import { HarnessError } from '../core/errors.js';
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

  /** Register an event handler. Returns an unsubscribe function. */
  onEvent(handler: (event: SessionEvent) => void): () => void;

  /** Dispose the manager (clears auto-GC interval). */
  dispose(): void;
}

/**
 * Create a new SessionManager instance.
 *
 * @example
 * ```ts
 * const sm = createSessionManager({ maxSessions: 10, ttlMs: 60000 });
 * const session = sm.create({ userId: 'alice' });
 * const accessed = sm.access(session.id);
 * sm.destroy(session.id);
 * sm.dispose();
 * ```
 */
export function createSessionManager(config?: {
  maxSessions?: number;
  ttlMs?: number;
  gcIntervalMs?: number;
}): SessionManager {
  const maxSessions = config?.maxSessions ?? 100;
  const ttlMs = config?.ttlMs ?? 5 * 60 * 1000;
  const gcIntervalMs = config?.gcIntervalMs ?? 60000;

  interface MutableSession {
    id: string;
    createdAt: number;
    lastAccessedAt: number;
    metadata: Record<string, unknown>;
    status: 'active' | 'locked' | 'expired';
  }

  const sessions = new Map<string, MutableSession>();
  const accessOrder = new Map<string, true>(); // Map insertion order for O(1) LRU
  const eventHandlers: ((event: SessionEvent) => void)[] = [];
  let nextId = 1;

  // Emit reentry protection: queue events if already emitting
  let emitting = false;
  const pendingEvents: SessionEvent[] = [];

  function genId(): string {
    return `sess-${nextId++}-${Date.now().toString(36)}`;
  }

  function emit(type: SessionEvent['type'], sessionId: string): void {
    const event: SessionEvent = { type, sessionId, timestamp: Date.now() };
    if (emitting) {
      pendingEvents.push(event);
      return;
    }
    emitting = true;
    try {
      for (const handler of eventHandlers) {
        try { handler(event); } catch { /* Prevent misbehaving handler from breaking event delivery */ }
      }
      while (pendingEvents.length > 0) {
        const queued = pendingEvents.shift()!;
        for (const handler of eventHandlers) {
          try { handler(queued); } catch { /* ignore */ }
        }
      }
    } finally {
      emitting = false;
    }
  }

  function isExpired(session: MutableSession): boolean {
    return Date.now() - session.lastAccessedAt > ttlMs;
  }

  // O(1) LRU using Map insertion order: delete + re-set moves entry to end.
  function touchAccessOrder(id: string): void {
    accessOrder.delete(id);
    accessOrder.set(id, true);
  }

  function evictLRU(): void {
    while (sessions.size > maxSessions && accessOrder.size > 0) {
      const oldestId = accessOrder.keys().next().value as string;
      accessOrder.delete(oldestId);
      const session = sessions.get(oldestId);
      if (session) {
        sessions.delete(oldestId);
        emit('destroyed', oldestId);
      }
    }
  }

  function toReadonly(ms: MutableSession): Session {
    return {
      id: ms.id,
      createdAt: ms.createdAt,
      lastAccessedAt: ms.lastAccessedAt,
      metadata: { ...ms.metadata },
      status: ms.status,
    };
  }

  // Auto-GC interval
  const gcTimer = gcIntervalMs > 0
    ? setInterval(() => { manager.gc(); }, gcIntervalMs)
    : null;

  // Prevent timer from keeping the process alive
  if (gcTimer && typeof gcTimer === 'object' && 'unref' in gcTimer) {
    gcTimer.unref();
  }

  const manager: SessionManager = {
    create(metadata?: Record<string, unknown>): Session {
      const id = genId();
      const now = Date.now();
      const session: MutableSession = {
        id,
        createdAt: now,
        lastAccessedAt: now,
        metadata: metadata ? { ...metadata } : {},
        status: 'active',
      };
      sessions.set(id, session);
      accessOrder.set(id, true);
      evictLRU();
      emit('created', id);
      return toReadonly(session);
    },

    get(id: string): Session | undefined {
      const session = sessions.get(id);
      if (!session) return undefined;
      // Mark expired if needed
      if (session.status === 'active' && isExpired(session)) {
        session.status = 'expired';
        emit('expired', id);
      }
      return toReadonly(session);
    },

    access(id: string): Session {
      const session = sessions.get(id);
      if (!session) {
        throw new HarnessError(
          `Session not found: ${id}`,
          'SESSION_NOT_FOUND',
          'Create a session before accessing it',
        );
      }

      if (session.status === 'locked') {
        throw new HarnessError(
          `Session is locked: ${id}`,
          'SESSION_LOCKED',
          'Wait for the session to be unlocked',
        );
      }

      if (session.status === 'expired' || isExpired(session)) {
        session.status = 'expired';
        throw new HarnessError(
          `Session has expired: ${id}`,
          'SESSION_EXPIRED',
          'Create a new session',
        );
      }

      session.lastAccessedAt = Date.now();
      touchAccessOrder(id);
      emit('accessed', id);
      return toReadonly(session);
    },

    lock(id: string): { unlock: () => void } {
      const session = sessions.get(id);
      if (!session) {
        throw new HarnessError(
          `Session not found: ${id}`,
          'SESSION_NOT_FOUND',
          'Create a session before locking it',
        );
      }

      session.status = 'locked';
      emit('locked', id);

      return {
        unlock: () => {
          const s = sessions.get(id);
          if (!s) {
            throw new HarnessError(
              `Session was destroyed while locked: ${id}`,
              'SESSION_NOT_FOUND',
              'Do not destroy a session while it is locked',
            );
          }
          if (s.status === 'locked') {
            s.status = 'active';
            s.lastAccessedAt = Date.now();
            emit('unlocked', id);
          }
        },
      };
    },

    destroy(id: string): void {
      accessOrder.delete(id);
      sessions.delete(id);
      emit('destroyed', id);
    },

    list(): Session[] {
      const result: Session[] = [];
      for (const session of sessions.values()) {
        if (session.status === 'active' && isExpired(session)) {
          session.status = 'expired';
          emit('expired', session.id);
        }
        result.push(toReadonly(session));
      }
      return result;
    },

    gc(): number {
      let count = 0;
      for (const [id, session] of sessions) {
        if (session.status === 'expired' || (session.status === 'active' && isExpired(session))) {
          accessOrder.delete(id);
          sessions.delete(id);
          emit('destroyed', id);
          count++;
        }
      }
      return count;
    },

    get activeSessions(): number {
      let count = 0;
      for (const session of sessions.values()) {
        if (session.status !== 'expired' && !isExpired(session)) {
          count++;
        }
      }
      return count;
    },

    get maxSessions(): number {
      return maxSessions;
    },

    onEvent(handler: (event: SessionEvent) => void): () => void {
      eventHandlers.push(handler);
      return () => {
        const idx = eventHandlers.indexOf(handler);
        if (idx >= 0) eventHandlers.splice(idx, 1);
      };
    },

    dispose(): void {
      if (gcTimer) clearInterval(gcTimer);
    },
  };

  return manager;
}
