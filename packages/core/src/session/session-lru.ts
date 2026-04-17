/**
 * LRU order bookkeeping for {@link SessionManager}.
 *
 * Extracted from `session/manager.ts`. Splits the LRU order by lock
 * state so eviction pops from the head in O(1) instead of linearly
 * scanning past locked sessions:
 *
 * - `unlockedOrder` is a `Map<id, true>` used purely for insertion-order
 *   access (the classic Map-as-LRU trick — delete + re-set moves an
 *   entry to the tail).
 * - `lockedIds` is a membership set; locked sessions carry no LRU
 *   position and rejoin the queue on unlock.
 * - `evictLRU` amortises: we only start evicting once the session count
 *   exceeds `maxSessions + evictThreshold` (5% of maxSessions, min 1),
 *   preventing a scan on every create() when the cap is barely breached.
 *
 * @module
 */

export interface SessionLruCallbacks<Id> {
  /**
   * Called with each id that is about to be evicted. The session manager
   * uses this to emit `evicted` + `destroyed` events and to remove the
   * session from its own internal map.
   */
  readonly onEvict: (id: Id) => void;
}

export interface SessionLruConfig<Id> {
  readonly maxSessions: number;
  readonly callbacks: SessionLruCallbacks<Id>;
}

export interface SessionLru<Id> {
  /** Move `id` to the tail of the unlocked LRU. No-op if `id` is locked. */
  readonly touchAccessOrder: (id: Id) => void;
  /** Insert a new id at the tail of the unlocked LRU. */
  readonly insertUnlocked: (id: Id) => void;
  /** Transition `id` from unlocked to locked. */
  readonly markLocked: (id: Id) => void;
  /** Transition `id` from locked back to unlocked tail. */
  readonly markUnlocked: (id: Id) => void;
  /** Remove `id` from both tracking structures. */
  readonly remove: (id: Id) => void;
  /** Is `id` currently locked? */
  readonly isLocked: (id: Id) => boolean;
  /** Number of unlocked (evictable) sessions. */
  readonly unlockedSize: () => number;
  /** Try to evict from the head until we're at or below the cap. */
  readonly evictExcess: (currentSessionCount: number) => void;
  /** Wipe both tracking structures. */
  readonly clear: () => void;
}

export function createSessionLru<Id>(config: SessionLruConfig<Id>): SessionLru<Id> {
  const { maxSessions, callbacks } = config;
  const unlockedOrder = new Map<Id, true>();
  const lockedIds = new Set<Id>();

  // Amortize eviction: only trigger once we exceed `maxSessions + threshold`.
  const evictThreshold = Math.max(1, Math.floor(maxSessions * 0.05));

  function touchAccessOrder(id: Id): void {
    if (lockedIds.has(id)) return;
    unlockedOrder.delete(id);
    unlockedOrder.set(id, true);
  }

  function insertUnlocked(id: Id): void {
    unlockedOrder.delete(id);
    unlockedOrder.set(id, true);
  }

  function markLocked(id: Id): void {
    unlockedOrder.delete(id);
    lockedIds.add(id);
  }

  function markUnlocked(id: Id): void {
    lockedIds.delete(id);
    unlockedOrder.delete(id);
    unlockedOrder.set(id, true);
  }

  function remove(id: Id): void {
    unlockedOrder.delete(id);
    lockedIds.delete(id);
  }

  function evictExcess(currentSessionCount: number): void {
    if (currentSessionCount <= maxSessions + evictThreshold) return;
    let remaining = currentSessionCount;
    while (remaining > maxSessions && unlockedOrder.size > 0) {
      const oldestId = unlockedOrder.keys().next().value as Id;
      unlockedOrder.delete(oldestId);
      callbacks.onEvict(oldestId);
      remaining--;
    }
  }

  return {
    touchAccessOrder,
    insertUnlocked,
    markLocked,
    markUnlocked,
    remove,
    isLocked: (id) => lockedIds.has(id),
    unlockedSize: () => unlockedOrder.size,
    evictExcess,
    clear(): void {
      unlockedOrder.clear();
      lockedIds.clear();
    },
  };
}
