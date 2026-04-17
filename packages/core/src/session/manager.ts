/**
 * Session management with TTL, LRU eviction, and prompt locking.
 *
 * After Wave-14 the concerns are split:
 *
 * - This file owns session lifecycle (create/get/access/lock/destroy/list/gc)
 *   and the metadata-size guard.
 * - `session-lru.ts` owns LRU order + eviction amortisation.
 * - `session-event-bus.ts` owns emit + re-entry protection + priority drop.
 * - `session-gc.ts` owns the background GC timer.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import { asSessionId, prefixedSecureId } from '../infra/ids.js';
import type { SessionId } from '../core/types.js';
import type { Session, SessionEvent } from './types.js';
import type { SessionManager } from './manager-types.js';
import { startSessionGc } from './session-gc.js';
import { createSessionLru } from './session-lru.js';
import { createSessionEventBus } from './session-event-bus.js';
export type { SessionManager } from './manager-types.js';

/**
 * Wave-15: pluggable session storage backend. The default in-process Map
 * implementation is suitable for single-instance deployments; distributed
 * deployments can supply a Redis- or DB-backed implementation so session
 * state survives process restarts and is shared across nodes.
 *
 * Only the Map-like surface the manager depends on is abstracted — size,
 * iteration, and the five get/set/delete/has/clear operations. Async
 * backends should wrap their network calls with a write-through cache so
 * the synchronous contract holds.
 */
export interface SessionStore<T> {
  get(key: SessionId): T | undefined;
  set(key: SessionId, value: T): void;
  delete(key: SessionId): boolean;
  has(key: SessionId): boolean;
  clear(): void;
  readonly size: number;
  values(): IterableIterator<T>;
  keys(): IterableIterator<SessionId>;
  entries(): IterableIterator<[SessionId, T]>;
  [Symbol.iterator](): IterableIterator<[SessionId, T]>;
}

/**
 * Create a new SessionManager instance.
 *
 * **Important:** Always call `dispose()` when the manager is no longer needed.
 * `dispose()` clears the auto-GC interval timer AND all stored sessions to
 * prevent memory leaks. Failing to call `dispose()` will leak the GC interval
 * timer and all session data.
 *
 * **Lazy Expiry:** Sessions expire lazily -- they are only removed when
 * accessed, listed, or when gc() runs. In long-running services, expired
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
  /**
   * Optional structured logger for surfacing event-drop warnings and
   * event-handler exceptions.
   */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Maximum byte size of per-session metadata (stringified via JSON). When
   * set and the size is exceeded at `create()` time, the creation is
   * rejected with `CORE_INVALID_INPUT`. Defaults to `undefined` (no cap).
   */
  maxMetadataBytes?: number;
  /**
   * Wave-15: optional storage backend. Defaults to an in-process `Map`,
   * which is correct for single-instance deployments. Distributed
   * deployments can supply a shared implementation (e.g. backed by
   * `@harness-one/redis`) so session state survives restarts.
   */
  store?: SessionStore<{
    id: SessionId;
    createdAt: number;
    lastAccessedAt: number;
    metadata: Record<string, unknown>;
    status: 'active' | 'locked' | 'expired';
  }>;
}): SessionManager {
  const maxSessions = config?.maxSessions ?? 100;
  const ttlMs = config?.ttlMs ?? 5 * 60 * 1000;
  const gcIntervalMs = config?.gcIntervalMs ?? 60000;
  const logger = config?.logger;
  const maxMetadataBytes = config?.maxMetadataBytes;

  if (maxSessions < 1) {
    throw new HarnessError(
      'maxSessions must be >= 1',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive maxSessions value',
    );
  }
  if (ttlMs <= 0) {
    throw new HarnessError(
      'ttlMs must be > 0',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive TTL value',
    );
  }

  interface MutableSession {
    id: SessionId;
    createdAt: number;
    lastAccessedAt: number;
    metadata: Record<string, unknown>;
    status: 'active' | 'locked' | 'expired';
  }

  const sessions: SessionStore<MutableSession> =
    (config?.store as SessionStore<MutableSession> | undefined) ?? new Map<SessionId, MutableSession>();

  // Event bus owns handler registry + re-entry protection + priority drops.
  const eventBus = createSessionEventBus({
    ...(logger !== undefined && { logger }),
  });

  function emitEvent(
    type: SessionEvent['type'],
    sessionId: SessionId,
    reason?: string,
  ): void {
    eventBus.emit({
      type,
      sessionId,
      timestamp: Date.now(),
      ...(reason !== undefined && { reason }),
    });
  }

  // LRU owns unlocked order + locked set + amortised eviction. Eviction is
  // wired through a callback so the manager can emit events + remove the
  // session from its own map.
  const lru = createSessionLru<SessionId>({
    maxSessions,
    callbacks: {
      onEvict(id: SessionId): void {
        const session = sessions.get(id);
        if (session) {
          emitEvent('evicted', id, 'lru_capacity');
          sessions.delete(id);
          emitEvent('destroyed', id);
        }
      },
    },
  });

  // Use cryptographically secure random IDs instead of a predictable counter
  // + timestamp combination. Predictable session IDs enable session-hijacking
  // and enumeration attacks.
  function genId(): SessionId {
    return asSessionId(prefixedSecureId('sess'));
  }

  function isExpired(session: MutableSession): boolean {
    return Date.now() - session.lastAccessedAt > ttlMs;
  }

  /**
   * Deep-clone the metadata bag so nested mutations on the returned readonly
   * view cannot bleed back into internal manager state. `structuredClone` is
   * preferred because it handles Dates, Maps, Sets, typed arrays, and cycles
   * natively. For runtimes that lack it, fall back to a recursive clone
   * limited to plain JSON-compatible shapes.
   */
  function deepCloneMetadata(m: Record<string, unknown>): Record<string, unknown> {
    const sc = (globalThis as { structuredClone?: (v: unknown) => unknown }).structuredClone;
    if (typeof sc === 'function') {
      try {
        return sc(m) as Record<string, unknown>;
      } catch {
        /* noop: fall through to recursive clone for non-cloneable inputs
           (functions, class instances with methods, etc.) */
      }
    }
    return recursiveClone(m) as Record<string, unknown>;
  }

  function recursiveClone(v: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (v === null || typeof v !== 'object') return v;
    const existing = seen.get(v as object);
    if (existing !== undefined) return existing;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v as object, out);
      for (const item of v) out.push(recursiveClone(item, seen));
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(v as object, out);
    for (const k of Object.keys(v as object)) {
      out[k] = recursiveClone((v as Record<string, unknown>)[k], seen);
    }
    return out;
  }

  /**
   * Convert a mutable session to a readonly snapshot.
   *
   * **Performance warning:** `metadata` is deep-cloned on every call. For
   * large or frequently-accessed sessions, this can dominate `access()` /
   * `get()` / `list()` latency. Callers concerned about clone cost should
   * configure `maxMetadataBytes` and prefer `get()` over `access()` when
   * `lastAccessedAt` does not need to change.
   */
  function toReadonly(ms: MutableSession): Session {
    return {
      id: ms.id,
      createdAt: ms.createdAt,
      lastAccessedAt: ms.lastAccessedAt,
      metadata: deepCloneMetadata(ms.metadata),
      status: ms.status,
    };
  }

  /**
   * Enforce an optional byte cap on metadata at set time (rather than clone
   * time). Uses `JSON.stringify` + UTF-8 byte length as a proxy for
   * serialized size. Throws `CORE_INVALID_INPUT` when exceeded so the caller
   * can trim the payload before it ever enters the manager.
   */
  function assertMetadataSize(metadata: Record<string, unknown>): void {
    if (maxMetadataBytes === undefined || maxMetadataBytes <= 0) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(metadata);
    } catch (err) {
      throw new HarnessError(
        'Session metadata is not JSON-serializable',
        HarnessErrorCode.CORE_INVALID_INPUT,
        'Remove cyclic or non-serializable values from metadata',
        err instanceof Error ? err : undefined,
      );
    }
    const byteLen = Buffer.byteLength(serialized, 'utf8');
    if (byteLen > maxMetadataBytes) {
      throw new HarnessError(
        `Session metadata exceeds maxMetadataBytes (${byteLen} > ${maxMetadataBytes} bytes)`,
        HarnessErrorCode.CORE_INVALID_INPUT,
        'Reduce metadata size or raise maxMetadataBytes',
      );
    }
  }

  const manager: SessionManager = {
    create(metadata?: Record<string, unknown>): Session {
      if (sessions.size >= maxSessions && lru.unlockedSize() === 0) {
        throw new HarnessError(
          'Cannot create session: all sessions are locked and max capacity reached',
          HarnessErrorCode.SESSION_LIMIT,
          'Unlock or destroy an existing session before creating a new one',
        );
      }
      const id = genId();
      const now = Date.now();
      const initialMetadata = metadata ? { ...metadata } : {};
      assertMetadataSize(initialMetadata);
      const session: MutableSession = {
        id,
        createdAt: now,
        lastAccessedAt: now,
        metadata: initialMetadata,
        status: 'active',
      };
      sessions.set(id, session);
      lru.insertUnlocked(id);
      lru.evictExcess(sessions.size);
      emitEvent('created', id);
      return toReadonly(session);
    },

    get(id: string): Session | undefined {
      const key = id as SessionId;
      const session = sessions.get(key);
      if (!session) return undefined;
      if (session.status === 'active' && isExpired(session)) {
        session.status = 'expired';
        emitEvent('expired', key);
      }
      if (session.status === 'expired') return undefined;
      return toReadonly(session);
    },

    access(id: string): Session {
      const key = id as SessionId;
      const session = sessions.get(key);
      if (!session) {
        throw new HarnessError(
          `Session not found: ${id}`,
          HarnessErrorCode.SESSION_NOT_FOUND,
          'Create a session before accessing it',
        );
      }

      if (session.status === 'locked') {
        throw new HarnessError(
          `Session is locked: ${id}`,
          HarnessErrorCode.SESSION_LOCKED,
          'Wait for the session to be unlocked',
        );
      }

      if (session.status === 'expired' || isExpired(session)) {
        session.status = 'expired';
        throw new HarnessError(
          `Session has expired: ${id}`,
          HarnessErrorCode.SESSION_EXPIRED,
          'Create a new session',
        );
      }

      session.lastAccessedAt = Date.now();
      lru.touchAccessOrder(key);
      emitEvent('accessed', key);
      return toReadonly(session);
    },

    lock(id: string): { unlock: () => void } {
      const key = id as SessionId;
      const session = sessions.get(key);
      if (!session) {
        throw new HarnessError(
          `Session not found: ${id}`,
          HarnessErrorCode.SESSION_NOT_FOUND,
          'Create a session before locking it',
        );
      }

      if (session.status === 'expired' || (session.status === 'active' && isExpired(session))) {
        session.status = 'expired';
        emitEvent('expired', key);
        throw new HarnessError(
          `Session has expired: ${id}`,
          HarnessErrorCode.SESSION_EXPIRED,
          'Create a new session',
        );
      }

      session.status = 'locked';
      lru.markLocked(key);
      emitEvent('locked', key);

      const lockedSession = session;

      return {
        unlock: () => {
          if (!sessions.has(key)) {
            throw new HarnessError(
              `Session was destroyed while locked: ${key}`,
              HarnessErrorCode.SESSION_NOT_FOUND,
              'Do not destroy a session while it is locked',
            );
          }
          if (lockedSession.status === 'locked') {
            lockedSession.status = 'active';
            lockedSession.lastAccessedAt = Date.now();
            lru.markUnlocked(key);
            emitEvent('unlocked', key);
          }
        },
      };
    },

    destroy(id: string): void {
      const key = id as SessionId;
      lru.remove(key);
      sessions.delete(key);
      emitEvent('destroyed', key);
    },

    list(): Session[] {
      const result: Session[] = [];
      const newlyExpired: SessionId[] = [];
      for (const session of sessions.values()) {
        if (session.status === 'active' && isExpired(session)) {
          session.status = 'expired';
          newlyExpired.push(session.id);
        }
        if (session.status !== 'expired') {
          result.push(toReadonly(session));
        }
      }
      for (const id of newlyExpired) {
        emitEvent('expired', id);
      }
      return result;
    },

    gc(): number {
      let count = 0;
      for (const [id, session] of sessions) {
        if (session.status === 'locked') continue;
        const alreadyExpired = session.status === 'expired';
        if (alreadyExpired || (session.status === 'active' && isExpired(session))) {
          if (!alreadyExpired) {
            session.status = 'expired';
          }
          lru.remove(id);
          sessions.delete(id);
          emitEvent('destroyed', id);
          count++;
        }
      }
      return count;
    },

    get activeSessions(): number {
      return sessions.size;
    },

    get maxSessions(): number {
      return maxSessions;
    },

    get droppedEvents(): number {
      return eventBus.droppedEventCount();
    },

    get droppedEventCount(): number {
      return eventBus.droppedEventCount();
    },

    get handlerErrorCount(): number {
      return eventBus.handlerErrorCount();
    },

    getLastHandlerError(): { error: unknown; eventType: SessionEvent['type'] } | undefined {
      return eventBus.getLastHandlerError();
    },

    onEvent(handler: (event: SessionEvent) => void): () => void {
      return eventBus.onEvent(handler);
    },

    dispose(): void {
      try {
        sessions.clear();
        lru.clear();
        eventBus.dispose();
      } finally {
        gcHandle.stop();
      }
    },
  };

  // Start the GC timer after `manager` is bound so the callback closure sees
  // a live reference. `session-gc.ts` handles the `.unref()` / error-swallow
  // contract.
  const gcHandle = startSessionGc(() => manager.gc(), gcIntervalMs);

  return manager;
}
