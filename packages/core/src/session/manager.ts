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

  /** Register an event handler. */
  onEvent(handler: (event: SessionEvent) => void): void;

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
  const accessOrder: string[] = []; // For LRU
  const eventHandlers: ((event: SessionEvent) => void)[] = [];
  let nextId = 1;

  function genId(): string {
    return `sess-${nextId++}-${Date.now().toString(36)}`;
  }

  function emit(type: SessionEvent['type'], sessionId: string): void {
    const event: SessionEvent = { type, sessionId, timestamp: Date.now() };
    for (const handler of eventHandlers) {
      handler(event);
    }
  }

  function isExpired(session: MutableSession): boolean {
    return Date.now() - session.lastAccessedAt > ttlMs;
  }

  function touchAccessOrder(id: string): void {
    const idx = accessOrder.indexOf(id);
    if (idx !== -1) accessOrder.splice(idx, 1);
    accessOrder.push(id);
  }

  function evictLRU(): void {
    while (sessions.size > maxSessions && accessOrder.length > 0) {
      const oldestId = accessOrder.shift()!;
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
      accessOrder.push(id);
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
          // Only unlock if still exists and is locked
          const s = sessions.get(id);
          if (s && s.status === 'locked') {
            s.status = 'active';
            s.lastAccessedAt = Date.now();
            emit('unlocked', id);
          }
        },
      };
    },

    destroy(id: string): void {
      const idx = accessOrder.indexOf(id);
      if (idx !== -1) accessOrder.splice(idx, 1);
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
          const idx = accessOrder.indexOf(id);
          if (idx !== -1) accessOrder.splice(idx, 1);
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

    onEvent(handler: (event: SessionEvent) => void): void {
      eventHandlers.push(handler);
    },

    dispose(): void {
      if (gcTimer) clearInterval(gcTimer);
    },
  };

  return manager;
}
