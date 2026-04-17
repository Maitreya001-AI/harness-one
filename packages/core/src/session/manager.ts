/**
 * Session management with TTL, LRU eviction, and prompt locking.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { asSessionId, prefixedSecureId } from '../infra/ids.js';
import type { SessionId } from '../core/types.js';
import type { Session, SessionEvent } from './types.js';
import type { SessionManager } from './manager-types.js';
export type { SessionManager } from './manager-types.js';

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
   *
   * This complements the deep-clone performed on every read in `toReadonly()`
   * — a documented size ceiling at write time prevents pathological metadata
   * from dominating the clone cost per access.
   */
  maxMetadataBytes?: number;
}): SessionManager {
  const maxSessions = config?.maxSessions ?? 100;
  const ttlMs = config?.ttlMs ?? 5 * 60 * 1000;
  const gcIntervalMs = config?.gcIntervalMs ?? 60000;
  const logger = config?.logger;
  const maxMetadataBytes = config?.maxMetadataBytes;

  if (maxSessions < 1) {
    throw new HarnessError('maxSessions must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive maxSessions value');
  }
  if (ttlMs <= 0) {
    throw new HarnessError('ttlMs must be > 0', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive TTL value');
  }

  interface MutableSession {
    id: SessionId;
    createdAt: number;
    lastAccessedAt: number;
    metadata: Record<string, unknown>;
    status: 'active' | 'locked' | 'expired';
  }

  const sessions = new Map<SessionId, MutableSession>();
  /**
   * Split the LRU order by lock state. `unlockedOrder` contains only
   * evictable sessions — we pop from its head in O(1) instead of linearly
   * scanning past locked sessions. `lockedIds` is a membership set so
   * lock/unlock transitions are constant-time.
   */
  const unlockedOrder = new Map<SessionId, true>(); // LRU of active (unlocked)
  const lockedIds = new Set<SessionId>();
  // Set-backed event-handler storage — JS Sets preserve insertion order, so
  // emit order is stable. Unsubscribe is O(1). Registering the same handler
  // reference twice is deduplicated (stored once).
  const eventHandlers = new Set<(event: SessionEvent) => void>();

  // Emit reentry protection: queue events if already emitting.
  // Cap the pending queue to prevent unbounded growth if event handlers
  // trigger cascading events (e.g., handler calls destroy() which emits
  // more events). 1000 is generous enough for legitimate reentry depth.
  const MAX_PENDING_EVENTS = 1000;
  let emitting = false;
  const pendingEvents: SessionEvent[] = [];
  // Counters are intentionally write-only to keep event emission
  // allocation-free. Consumers surface them via the `SessionManager` if needed.

  let _droppedHandlerErrors = 0;
  // Keep the most recent handler error so operators can pull it out of
  // `getLastHandlerError()` for diagnosis.
  let _lastHandlerError: { error: unknown; eventType: SessionEvent['type'] } | undefined;

  let _droppedEvents = 0;
  // Rate-limit the queue-overflow warn() to at most 1 per second by
  // remembering when we last emitted. Every single drop still increments
  // `_droppedEvents` so counter-consumers see the real number. Two
  // independent windows: pure-drop and priority-eviction convey different
  // operational signals (lost low-priority audit data vs admitted
  // high-priority event), so each is rate-limited separately.
  const DROP_WARN_INTERVAL_MS = 1000;
  let _lastDropWarnAt = 0;
  let _lastEvictionWarnAt = 0;

  // Use cryptographically secure random IDs instead of a predictable counter
  // + timestamp combination. Predictable session IDs enable session-hijacking
  // and enumeration attacks.
  function genId(): SessionId {
    return asSessionId(prefixedSecureId('sess'));
  }

  /**
   * Prioritized event types. High-priority events
   * (`created`/`destroyed`/`error`-shaped — `expired`/`evicted`) carry
   * lifecycle state that external listeners need to reconcile; dropping
   * them silently leaks refs and breaks auditing. When the queue is full,
   * we evict the oldest LOW-priority event to make room for a new
   * high-priority one instead of dropping the high-priority event.
   */
  const HIGH_PRIORITY_EVENTS: ReadonlySet<SessionEvent['type']> = new Set([
    'created',
    'destroyed',
    'expired',
    'evicted',
  ]);
  function isHighPriority(type: SessionEvent['type']): boolean {
    return HIGH_PRIORITY_EVENTS.has(type);
  }

  function emit(type: SessionEvent['type'], sessionId: SessionId, reason?: string): void {
    const event: SessionEvent = { type, sessionId, timestamp: Date.now(), ...(reason !== undefined && { reason }) };
    if (emitting) {
      if (pendingEvents.length >= MAX_PENDING_EVENTS) {
        // Attempt priority-aware drop before refusing the event. If the new
        // event is HIGH and there is at least one LOW queued, evict the
        // oldest LOW to make room. Otherwise fall back to dropping the
        // incoming event.
        if (isHighPriority(type)) {
          const lowIdx = pendingEvents.findIndex(e => !isHighPriority(e.type));
          if (lowIdx !== -1) {
            pendingEvents.splice(lowIdx, 1);
            _droppedEvents++;
            // Emit a warn on every eviction, rate-limited to 1/sec via an
            // INDEPENDENT window so a flood of low-priority drops (handled
            // below) doesn't suppress high-signal eviction warnings from
            // the same second.
            const nowMs = Date.now();
            if (logger && nowMs - _lastEvictionWarnAt >= DROP_WARN_INTERVAL_MS) {
              _lastEvictionWarnAt = nowMs;
              try {
                logger.warn(
                  '[harness-one/session-manager] low-priority event evicted to admit high-priority event',
                  {
                    evictedType: 'low',
                    admittedType: type,
                    droppedEventCount: _droppedEvents,
                  },
                );
              } catch { /* logger failure non-fatal */ }
            }
            pendingEvents.push(event);
            return;
          }
        }
        _droppedEvents++;
        // Warn on EVERY drop (not just the first), but rate-limit to 1/sec
        // using a timestamp comparison (no timers needed). The counter is
        // always incremented so operators can observe the true drop rate
        // via `droppedEventCount`.
        if (logger) {
          const nowMs = Date.now();
          if (nowMs - _lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
            _lastDropWarnAt = nowMs;
            try {
              logger.warn('[harness-one/session-manager] event dropped — pending queue overflow', {
                maxPendingEvents: MAX_PENDING_EVENTS,
                droppedType: type,
                droppedEventCount: _droppedEvents,
              });
            } catch { /* logger failure non-fatal */ }
          }
        }
        return;
      }
      pendingEvents.push(event);
      return;
    }
    emitting = true;
    try {
      for (const handler of eventHandlers) {
        try { handler(event); } catch (err) {
          // Prevent misbehaving handler from breaking event delivery, but
          // don't silently swallow — log via injected logger when present
          // and preserve the last error for diagnostic access.
          _droppedHandlerErrors++;
          _lastHandlerError = { error: err, eventType: event.type };
          if (logger) {
            const logFn = logger.error ?? logger.warn;
            try {
              logFn('[harness-one/session-manager] event handler threw', {
                eventType: event.type,
                error: err instanceof Error ? err.message : String(err),
                handlerErrorCount: _droppedHandlerErrors,
              });
            } catch { /* logger failure non-fatal */ }
          }
        }
      }
      while (pendingEvents.length > 0) {
        const queued = pendingEvents.shift() as SessionEvent;
        const snapshot = [...eventHandlers];
        for (const handler of snapshot) {
          try { handler(queued); } catch (err) {
            _droppedHandlerErrors++;
            _lastHandlerError = { error: err, eventType: queued.type };
            if (logger) {
              const logFn = logger.error ?? logger.warn;
              try {
                logFn('[harness-one/session-manager] event handler threw', {
                  eventType: queued.type,
                  error: err instanceof Error ? err.message : String(err),
                  handlerErrorCount: _droppedHandlerErrors,
                });
              } catch { /* logger failure non-fatal */ }
            }
          }
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
  // Only the unlocked order needs LRU positioning; locked sessions are
  // temporarily off the eviction path and rejoin the queue on unlock.
  function touchAccessOrder(id: SessionId): void {
    if (lockedIds.has(id)) return; // locked sessions carry no LRU position
    unlockedOrder.delete(id);
    unlockedOrder.set(id, true);
  }

  function markLocked(id: SessionId): void {
    unlockedOrder.delete(id);
    lockedIds.add(id);
  }

  function markUnlocked(id: SessionId): void {
    lockedIds.delete(id);
    unlockedOrder.delete(id);
    unlockedOrder.set(id, true);
  }

  // Amortize eviction by only triggering once we exceed
  // `maxSessions + evictThreshold`. Without this amortization, each create()
  // at capacity scans unlockedOrder even when eviction is unnecessary.
  // Threshold = 5% of maxSessions (min 1).
  const evictThreshold = Math.max(1, Math.floor(maxSessions * 0.05));

  function evictLRU(): void {
    // O(1) per eviction: pop from the head of unlockedOrder until sessions
    // fit the cap or no unlocked session remains. Locked sessions are never
    // scanned. If every session is locked at capacity, create() raises
    // SESSION_LIMIT — that's the correct behavior rather than silently
    // exceeding the cap.
    //
    // Only begin evicting when we've grown past `maxSessions + evictThreshold`.
    // Once we pass the threshold, evict all the way down to `maxSessions` to
    // keep steady-state size correct.
    if (sessions.size <= maxSessions + evictThreshold) return;
    while (sessions.size > maxSessions && unlockedOrder.size > 0) {
      const oldestId = unlockedOrder.keys().next().value as SessionId;
      unlockedOrder.delete(oldestId);
      const session = sessions.get(oldestId);
      if (session) {
        emit('evicted', oldestId, 'lru_capacity');
        sessions.delete(oldestId);
        emit('destroyed', oldestId);
      }
    }
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
        // Fall through to recursive clone on non-cloneable inputs (functions,
        // class instances with methods, etc.).
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
   * `get()` / `list()` latency. The real fix requires breaking the public
   * contract (e.g., returning a Proxy or a frozen-but-shared view); we
   * deliberately keep deep-clone semantics to preserve isolation. Callers
   * concerned about clone cost should:
   *
   *   1. Configure `maxMetadataBytes` to cap the input side at creation.
   *   2. Prefer `get()` over `access()` when lastAccessedAt doesn't need to
   *      change.
   *   3. Avoid stuffing large blobs into `metadata`; use an out-of-band
   *      key/value store keyed by `session.id` instead.
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

  // Auto-GC interval
  const gcTimer = gcIntervalMs > 0
    ? setInterval(() => { manager.gc(); }, gcIntervalMs)
    : null;

  // The GC timer is unref'd so it will not prevent process exit. If your
  // application needs session persistence across restarts, use an external
  // store (e.g., Redis, database).
  if (gcTimer && typeof gcTimer === 'object' && 'unref' in gcTimer) {
    gcTimer.unref();
  }

  const manager: SessionManager = {
    create(metadata?: Record<string, unknown>): Session {
      // O(1) capacity check: if we're at cap and have no evictable sessions,
      // creating one more would overflow since we can't evict any. Previously
      // this scanned all sessions — now we use the unlockedOrder size.
      if (sessions.size >= maxSessions && unlockedOrder.size === 0) {
        throw new HarnessError(
          'Cannot create session: all sessions are locked and max capacity reached',
          HarnessErrorCode.SESSION_LIMIT,
          'Unlock or destroy an existing session before creating a new one',
        );
      }
      const id = genId();
      const now = Date.now();
      // Enforce optional byte cap at creation time so we never store
      // metadata that will be expensive to clone on every read.
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
      unlockedOrder.set(id, true);
      evictLRU();
      emit('created', id);
      return toReadonly(session);
    },

    get(id: string): Session | undefined {
      const key = id as SessionId;
      const session = sessions.get(key);
      if (!session) return undefined;
      // Check TTL on read — expired sessions are treated as non-existent
      if (session.status === 'active' && isExpired(session)) {
        session.status = 'expired';
        emit('expired', key);
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
      touchAccessOrder(key);
      emit('accessed', key);
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
        emit('expired', key);
        throw new HarnessError(
          `Session has expired: ${id}`,
          HarnessErrorCode.SESSION_EXPIRED,
          'Create a new session',
        );
      }

      session.status = 'locked';
      markLocked(key);
      emit('locked', key);

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
            markUnlocked(key);
            emit('unlocked', key);
          }
        },
      };
    },

    destroy(id: string): void {
      const key = id as SessionId;
      unlockedOrder.delete(key);
      lockedIds.delete(key);
      sessions.delete(key);
      emit('destroyed', key);
    },

    list(): Session[] {
      const result: Session[] = [];
      const newlyExpired: SessionId[] = [];
      for (const session of sessions.values()) {
        if (session.status === 'active' && isExpired(session)) {
          session.status = 'expired';
          newlyExpired.push(session.id);
        }
        // Only return non-expired sessions — expired sessions are logically deleted.
        if (session.status !== 'expired') {
          result.push(toReadonly(session));
        }
      }
      // Emit events after iteration to avoid re-entrancy during Map iteration
      for (const id of newlyExpired) {
        emit('expired', id);
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
          unlockedOrder.delete(id);
          lockedIds.delete(id);
          sessions.delete(id);
          emit('destroyed', id);
          count++;
        }
      }
      return count;
    },

    get activeSessions(): number {
      // Approximate count: sessions.size minus locked sessions that may have expired.
      // Locked sessions are always counted active (they are in use). Unlocked
      // sessions that haven't been touched since `ttlMs` may be expired but we
      // don't re-scan them here for O(1) access — gc() handles cleanup.
      // For an exact count, call gc() first.
      return sessions.size;
    },

    get maxSessions(): number {
      return maxSessions;
    },

    get droppedEvents(): number {
      return _droppedEvents;
    },

    get droppedEventCount(): number {
      return _droppedEvents;
    },

    get handlerErrorCount(): number {
      return _droppedHandlerErrors;
    },

    getLastHandlerError(): { error: unknown; eventType: SessionEvent['type'] } | undefined {
      return _lastHandlerError;
    },

    onEvent(handler: (event: SessionEvent) => void): () => void {
      // O(1) add + O(1) delete — Set preserves insertion order so emit()
      // runs handlers in registration order.
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },

    dispose(): void {
      // Guard clearInterval with try/finally so that, even if one of the
      // cleanup steps throws (e.g., a custom Map subclass overriding clear),
      // the GC timer is always released. Leaking the interval keeps the
      // entire manager closure alive and defeats memory reclamation.
      try {
        // Clear all sessions to release memory and prevent stale references.
        sessions.clear();
        unlockedOrder.clear();
        lockedIds.clear();
        // Clear event handlers to prevent memory leaks when handlers close over
        // external state that would otherwise be retained by the disposed manager.
        eventHandlers.clear();
      } finally {
        if (gcTimer) clearInterval(gcTimer);
      }
    },
  };

  return manager;
}
