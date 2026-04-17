/**
 * LRU-tracked span lookup for the OTel exporter.
 *
 * Wave-16 M2 extraction. The exporter originally held four sibling Maps
 * (spanMap / spanParentMap / spanAccessTime / evictedParents +
 * evictedParentsAccessTime) and five helpers to keep them in sync. That
 * bookkeeping is one cohesive responsibility, so it lives here now and the
 * exporter factory orchestrates against a handful of intention-revealing
 * methods.
 *
 * All operations are O(1) amortised; eviction piggy-backs on Map insertion
 * order (the same trick `core/infra/lru-cache.ts` uses).
 *
 * @module
 * @internal
 */

import type { Span as OTelSpan } from '@opentelemetry/api';

export interface OTelSpanMapConfig {
  /**
   * How many already-ended parent spans to keep around so a late-arriving
   * child can still be linked correctly. Once the cap is reached, eviction
   * discards the oldest 10% in one pass.
   */
  readonly maxEvictedParents: number;
}

export interface OTelSpanMap {
  /** Register a live OTel span by its harness span id. */
  set(harnessSpanId: string, otelSpan: OTelSpan, harnessParentId?: string): void;
  /** Look up a live OTel span by id; does not touch the LRU bookkeeping. */
  getLive(harnessSpanId: string): OTelSpan | undefined;
  /** Look up an evicted-but-still-cached parent by id. */
  getEvictedParent(harnessSpanId: string): OTelSpan | undefined;
  /** True iff `harnessSpanId` is tracked as a currently-live span. */
  hasLive(harnessSpanId: string): boolean;
  /** True iff `harnessSpanId` lives in the evicted-parents LRU cache. */
  hasEvicted(harnessSpanId: string): boolean;
  /**
   * Mark this span as most-recently-used. Call on every access / update —
   * without this, LRU degenerates to FIFO.
   */
  touch(harnessSpanId: string): void;
  /**
   * Re-touch an entry in the evicted-parents cache so it doesn't fall off
   * when a late child arrives. Matches the legacy "move-to-tail" behaviour.
   */
  touchEvicted(harnessSpanId: string): void;
  /** Current count of live spans (before eviction). */
  liveSize(): number;
  /**
   * Evict `count` oldest live spans. Evicted spans move into the
   * evicted-parents LRU so late-arriving children can still link to them.
   */
  evictLive(count: number): void;
  /**
   * Flush every live span into the evicted-parents cache and bound the
   * cache to `maxEvictedParents`. Used by the exporter's `flush()` hook.
   */
  migrateLiveToEvicted(): void;
  /** Drop tracking for every id in `harnessSpanIds` (used during exportTrace). */
  deleteBatch(harnessSpanIds: readonly string[]): void;
}

export function createOTelSpanMap(config: OTelSpanMapConfig): OTelSpanMap {
  const { maxEvictedParents } = config;
  // spanId -> live OTel span.
  const live = new Map<string, OTelSpan>();
  // childId -> parentId (used for orphan-clean-up during eviction).
  const parents = new Map<string, string>();
  // Access timestamps, delete-then-set to keep insertion order == LRU order.
  const accessTime = new Map<string, number>();
  // Lightweight fallback for evicted parents: spanId -> OTel span.
  const evicted = new Map<string, OTelSpan>();
  // Access timestamps for the evicted-parents cache, same LRU invariant.
  const evictedAccessTime = new Map<string, number>();

  function purgeEvictedIfOverCap(): void {
    if (evicted.size <= maxEvictedParents) return;
    // Evict oldest 10% in one pass so amortised cost stays O(1) per insert.
    const epEvictCount = Math.ceil(maxEvictedParents * 0.1);
    let removed = 0;
    for (const [epId] of evictedAccessTime) {
      if (removed >= epEvictCount) break;
      evicted.delete(epId);
      evictedAccessTime.delete(epId);
      // Clean up orphaned parent references pointing to this evicted parent.
      for (const [childId, parentId] of parents) {
        if (parentId === epId) parents.delete(childId);
      }
      removed++;
    }
  }

  return {
    set(harnessSpanId, otelSpan, harnessParentId): void {
      live.set(harnessSpanId, otelSpan);
      accessTime.delete(harnessSpanId);
      accessTime.set(harnessSpanId, Date.now());
      if (harnessParentId !== undefined) {
        parents.set(harnessSpanId, harnessParentId);
      }
    },
    getLive(id): OTelSpan | undefined {
      return live.get(id);
    },
    getEvictedParent(id): OTelSpan | undefined {
      return evicted.get(id);
    },
    hasLive(id): boolean {
      return live.has(id);
    },
    hasEvicted(id): boolean {
      return evicted.has(id);
    },
    touch(id): void {
      if (!accessTime.has(id)) return;
      accessTime.delete(id);
      accessTime.set(id, Date.now());
    },
    touchEvicted(id): void {
      if (!evicted.has(id)) return;
      evictedAccessTime.delete(id);
      evictedAccessTime.set(id, Date.now());
    },
    liveSize(): number {
      return live.size;
    },
    evictLive(count): void {
      let evictedCount = 0;
      for (const [id] of accessTime) {
        if (evictedCount >= count) break;
        if (!live.has(id)) {
          accessTime.delete(id);
          continue;
        }
        const otelSpan = live.get(id);
        if (otelSpan) {
          evicted.set(id, otelSpan);
          evictedAccessTime.delete(id);
          evictedAccessTime.set(id, Date.now());
          purgeEvictedIfOverCap();
        }
        live.delete(id);
        parents.delete(id);
        accessTime.delete(id);
        evictedCount++;
      }
    },
    migrateLiveToEvicted(): void {
      // Snapshot before clearing so a concurrent late-exportSpan can still
      // resolve a parent from the evicted-parents cache.
      const snapshot = new Map(live);
      live.clear();
      parents.clear();
      accessTime.clear();
      for (const [id, span] of snapshot) {
        evicted.set(id, span);
        evictedAccessTime.delete(id);
        evictedAccessTime.set(id, Date.now());
      }
      // Wave-12 P1-9: purge-by-TTL removed — the race with in-flight child
      // exports caused orphaned subtrees. Size-based LRU is the only
      // retention policy.
      if (evicted.size > maxEvictedParents) {
        const excess = evicted.size - maxEvictedParents;
        let removed = 0;
        for (const [epId] of evictedAccessTime) {
          if (removed >= excess) break;
          evicted.delete(epId);
          evictedAccessTime.delete(epId);
          removed++;
        }
      }
    },
    deleteBatch(ids): void {
      for (const id of ids) {
        live.delete(id);
        parents.delete(id);
        accessTime.delete(id);
      }
    },
  };
}
