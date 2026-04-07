// Install: npm install ioredis
//
// This example shows how to implement harness-one's MemoryStore interface
// backed by Redis. Memory entries are stored as JSON values with keys
// prefixed by a configurable namespace.

import Redis from 'ioredis';
import type { MemoryStore } from 'harness-one/memory';
import type {
  MemoryEntry,
  MemoryFilter,
  CompactionPolicy,
  CompactionResult,
} from 'harness-one/memory';

// ---------------------------------------------------------------------------
// Redis MemoryStore implementation
// ---------------------------------------------------------------------------

/**
 * Create a MemoryStore backed by Redis.
 *
 * Data model:
 *   - Each entry: SET  prefix:{id} -> JSON(MemoryEntry)
 *   - Key index:  SET  prefix:__keys__ -> { id1, id2, ... }
 *   - Optional TTL for automatic expiry
 *
 * Usage:
 *   const store = createRedisStore({ url: 'redis://localhost:6379' });
 */
export function createRedisStore(config: {
  url?: string;
  prefix?: string;
  defaultTTL?: number;
}): MemoryStore {
  const redis = new Redis(config.url ?? 'redis://localhost:6379');
  const prefix = config.prefix ?? 'harness:memory';
  const defaultTTL = config.defaultTTL; // seconds, undefined = no expiry

  let idCounter = 0;

  function entryKey(id: string): string {
    return `${prefix}:${id}`;
  }

  const indexKey = `${prefix}:__keys__`;

  function generateId(): string {
    return `mem_${Date.now()}_${++idCounter}`;
  }

  async function getEntry(id: string): Promise<MemoryEntry | null> {
    const raw = await redis.get(entryKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as MemoryEntry;
  }

  async function setEntry(entry: MemoryEntry): Promise<void> {
    const key = entryKey(entry.id);
    const value = JSON.stringify(entry);
    if (defaultTTL) {
      await redis.set(key, value, 'EX', defaultTTL);
    } else {
      await redis.set(key, value);
    }
    // Track the ID in our index set
    await redis.sadd(indexKey, entry.id);
  }

  return {
    // -----------------------------------------------------------------------
    // write: create a new entry
    // -----------------------------------------------------------------------
    async write(input) {
      const now = Date.now();
      const entry: MemoryEntry = {
        id: generateId(),
        key: input.key,
        content: input.content,
        grade: input.grade,
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata,
        tags: input.tags,
      };
      await setEntry(entry);
      return entry;
    },

    // -----------------------------------------------------------------------
    // read: fetch a single entry by ID
    // -----------------------------------------------------------------------
    async read(id) {
      return getEntry(id);
    },

    // -----------------------------------------------------------------------
    // query: filter entries using SCAN + in-memory filtering
    // -----------------------------------------------------------------------
    async query(filter: MemoryFilter) {
      // Get all known IDs from the index set
      const allIds = await redis.smembers(indexKey);
      const entries: MemoryEntry[] = [];

      // Fetch entries in batches using MGET for efficiency
      const batchSize = 100;
      for (let i = 0; i < allIds.length; i += batchSize) {
        const batch = allIds.slice(i, i + batchSize);
        const keys = batch.map(entryKey);
        const values = await redis.mget(...keys);

        for (const raw of values) {
          if (!raw) continue;
          const entry = JSON.parse(raw) as MemoryEntry;

          // Apply filters
          if (filter.grade && entry.grade !== filter.grade) continue;
          if (filter.tags && filter.tags.length > 0) {
            if (!filter.tags.some((t) => entry.tags?.includes(t))) continue;
          }
          if (filter.since !== undefined && entry.updatedAt < filter.since) continue;
          if (filter.search) {
            const term = filter.search.toLowerCase();
            if (!entry.content.toLowerCase().includes(term)) continue;
          }

          entries.push(entry);
        }
      }

      // Sort by most recently updated
      entries.sort((a, b) => b.updatedAt - a.updatedAt);

      // Apply limit
      if (filter.limit !== undefined && filter.limit > 0) {
        return entries.slice(0, filter.limit);
      }

      return entries;
    },

    // -----------------------------------------------------------------------
    // update: modify an existing entry
    // -----------------------------------------------------------------------
    async update(id, updates) {
      const existing = await getEntry(id);
      if (!existing) {
        throw new Error(`Memory entry not found: ${id}`);
      }
      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      await setEntry(updated);
      return updated;
    },

    // -----------------------------------------------------------------------
    // delete: remove an entry
    // -----------------------------------------------------------------------
    async delete(id) {
      const existed = await redis.del(entryKey(id));
      await redis.srem(indexKey, id);
      return existed > 0;
    },

    // -----------------------------------------------------------------------
    // compact: prune entries based on CompactionPolicy
    // -----------------------------------------------------------------------
    async compact(policy: CompactionPolicy) {
      const allIds = await redis.smembers(indexKey);
      const entries: MemoryEntry[] = [];

      for (const id of allIds) {
        const entry = await getEntry(id);
        if (entry) entries.push(entry);
      }

      const now = Date.now();
      const weights = policy.gradeWeights ?? {
        critical: 1.0,
        useful: 0.5,
        ephemeral: 0.1,
      };
      const freed: string[] = [];

      // Remove entries exceeding maxAge (except critical)
      if (policy.maxAge !== undefined) {
        for (const entry of entries) {
          if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
            await redis.del(entryKey(entry.id));
            await redis.srem(indexKey, entry.id);
            freed.push(entry.id);
          }
        }
      }

      // Trim to maxEntries by lowest-weighted first
      const remaining = entries.filter((e) => !freed.includes(e.id));
      if (policy.maxEntries !== undefined && remaining.length > policy.maxEntries) {
        remaining.sort(
          (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
        );
        while (remaining.length > policy.maxEntries) {
          const victim = remaining.shift()!;
          if (weights[victim.grade] < 1.0) {
            await redis.del(entryKey(victim.id));
            await redis.srem(indexKey, victim.id);
            freed.push(victim.id);
          } else {
            break;
          }
        }
      }

      return {
        removed: freed.length,
        remaining: (await redis.scard(indexKey)),
        freedEntries: freed,
      };
    },

    // -----------------------------------------------------------------------
    // count / clear
    // -----------------------------------------------------------------------
    async count() {
      return redis.scard(indexKey);
    },

    async clear() {
      const allIds = await redis.smembers(indexKey);
      if (allIds.length > 0) {
        const keys = allIds.map(entryKey);
        await redis.del(...keys, indexKey);
      }
    },
  };
}
