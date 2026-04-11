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
 * **Important:** Always call `dispose()` when the manager is no longer needed.
 * `dispose()` clears the auto-GC interval timer AND all stored sessions to
 * prevent memory leaks. Failing to call `dispose()` will leak the GC interval
 * timer and all session data.
 *
 * **Lazy Expiry (Fix 12):** Sessions expire lazily -- they are only removed
 * when accessed, listed, or when gc() runs. In long-running services, expired
 * sessions remain in memory until one of these operations triggers cleanup.
 * For aggressive cleanup, ensure gc is enabled (gcIntervalMs config). The
 * default gcIntervalMs is 60000 (60 seconds).
 *
 * @example
 * ```ts
 * const sm = createSessionManager({ maxSessions: 10, ttlMs: 60000 });
 * const session = sm.create({ userId: 'alice' });
 * const accessed = sm.access(session.id);
 * sm.destroy(session.id);
 * sm.dispose(); // Always call dispose() when done!
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

  if (maxSessions < 1) {
    throw new HarnessError('maxSessions must be >= 1', 'INVALID_CONFIG', 'Provide a positive maxSessions value');
  }
  if (ttlMs <= 0) {
    throw new HarnessError('ttlMs must be > 0', 'INVALID_CONFIG', 'Provide a positive TTL value');
  }

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

  function emit(type: SessionEvent['type'], sessionId: string, reason?: string): void {
    const event: SessionEvent = { type, sessionId, timestamp: Date.now(), ...(reason !== undefined && { reason }) };
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
    // Safety counter: prevent infinite loop when all sessions are locked.
    // If every remaining session is locked, we cannot evict any of them —
    // the loop must terminate even though sessions.size > maxSessions.
    let attempts = 0;
    const maxAttempts = accessOrder.size;

    while (sessions.size > maxSessions && accessOrder.size > 0 && attempts < maxAttempts) {
      const oldestId = accessOrder.keys().next().value as string;
      const session = sessions.get(oldestId);

      if (session && session.status === 'locked') {
        // Skip locked sessions: move to end of access order and try next
        accessOrder.delete(oldestId);
        accessOrder.set(oldestId, true);
        attempts++;
        continue;
      }

      accessOrder.delete(oldestId);
      if (session) {
        // Fix 11: Emit distinct 'evicted' event before destroying via LRU
        emit('evicted', oldestId, 'lru_capacity');
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

  // Fix 13: The GC timer is unref'd so it will not prevent process exit.
  // If your application needs session persistence across restarts, use an
  // external store (e.g., Redis, database).
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

      // Capture the session reference at lock time so unlock operates on the
      // same object without re-fetching from the Map. This makes the
      // check-and-modify atomic: no window between fetching and mutating.
      const lockedSession = session;

      return {
        unlock: () => {
          // Verify the session still exists in the map (not destroyed).
          if (!sessions.has(id)) {
            throw new HarnessError(
              `Session was destroyed while locked: ${id}`,
              'SESSION_NOT_FOUND',
              'Do not destroy a session while it is locked',
            );
          }
          // Use the captured reference for atomic check-and-modify.
          if (lockedSession.status === 'locked') {
            lockedSession.status = 'active';
            lockedSession.lastAccessedAt = Date.now();
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
        // Locked sessions are excluded — they are actively in use.
        if (session.status === 'locked') continue;
        const alreadyExpired = session.status === 'expired';
        if (alreadyExpired || (session.status === 'active' && isExpired(session))) {
          if (!alreadyExpired) {
            session.status = 'expired';
          }
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
      // Clear all sessions to release memory and prevent stale references.
      sessions.clear();
      accessOrder.clear();
      // Clear event handlers to prevent memory leaks when handlers close over
      // external state that would otherwise be retained by the disposed manager.
      eventHandlers.length = 0;
    },
  };

  return manager;
}
