/**
 * @harness-one/redis — Redis-backed memory store for harness-one.
 *
 * Provides persistent memory storage using Redis, with support for
 * filtering, compaction, and key indexing.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MemoryStore } from 'harness-one/memory';
import type {
  MemoryEntry,
  MemoryFilter,
  CompactionPolicy,
} from 'harness-one/memory';
import { HarnessError } from 'harness-one/core';

/** Configuration for the Redis memory store. */
export interface RedisStoreConfig {
  /** A pre-configured ioredis client instance. */
  readonly client: Redis;
  /** Key prefix for Redis keys. Defaults to 'harness:memory'. */
  readonly prefix?: string;
  /** Default TTL in seconds for entries. Undefined = no expiry. */
  readonly defaultTTL?: number;
}

/**
 * Create a MemoryStore backed by Redis.
 *
 * Requires a pre-configured ioredis client. For production use, configure
 * the client with: `retryStrategy` for reconnection, `reconnectOnError` for
 * transient failures, and appropriate `maxRetriesPerRequest`. Connection
 * pooling is managed by ioredis internally.
 *
 * Data model:
 * - Each entry: STRING key `prefix:id` -> JSON(MemoryEntry)
 * - Key index: SET `prefix:__keys__` -> { id1, id2, ... }
 */
export function createRedisStore(config: RedisStoreConfig): MemoryStore {
  const { client } = config;
  const prefix = config.prefix ?? 'harness:memory';
  const defaultTTL = config.defaultTTL;

  if (!client) {
    throw new HarnessError('Redis client is required', 'INVALID_CONFIG', 'Provide a valid ioredis client instance');
  }
  if (defaultTTL !== undefined && defaultTTL <= 0) {
    throw new HarnessError('defaultTTL must be > 0', 'INVALID_CONFIG', 'Provide a positive TTL value in seconds');
  }

  function entryKey(id: string): string {
    return `${prefix}:${id}`;
  }

  const indexKey = `${prefix}:__keys__`;

  function generateId(): string {
    return `mem_${randomUUID()}`;
  }

  async function getEntry(id: string): Promise<MemoryEntry | null> {
    const raw = await client.get(entryKey(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MemoryEntry;
    } catch {
      // Corrupted entry — remove from index silently and return null
      await client.del(entryKey(id));
      await client.srem(indexKey, id);
      return null;
    }
  }

  async function setEntry(entry: MemoryEntry): Promise<void> {
    const key = entryKey(entry.id);
    const value = JSON.stringify(entry);
    const pipeline = client.multi();
    if (defaultTTL) {
      pipeline.set(key, value, 'EX', defaultTTL);
    } else {
      pipeline.set(key, value);
    }
    pipeline.sadd(indexKey, entry.id);
    await pipeline.exec();
  }

  return {
    async write(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>) {
      const now = Date.now();
      const entry: MemoryEntry = {
        id: generateId(),
        key: input.key,
        content: input.content,
        grade: input.grade,
        createdAt: now,
        updatedAt: now,
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        ...(input.tags !== undefined && { tags: input.tags }),
      };
      await setEntry(entry);
      return entry;
    },

    async read(id: string) {
      return getEntry(id);
    },

    async query(filter: MemoryFilter) {
      const allIds = await client.smembers(indexKey);
      const entries: MemoryEntry[] = [];

      const batchSize = 100;
      for (let i = 0; i < allIds.length; i += batchSize) {
        const batch = allIds.slice(i, i + batchSize);
        const keys = batch.map(entryKey);
        const values = await client.mget(...keys);

        for (const raw of values) {
          if (!raw) continue;
          let entry: MemoryEntry;
          try {
            entry = JSON.parse(raw) as MemoryEntry;
          } catch {
            continue; // Skip corrupted entries
          }

          if (filter.grade && entry.grade !== filter.grade) continue;
          if (filter.tags && filter.tags.length > 0) {
            if (!filter.tags.every((t) => entry.tags?.includes(t))) continue;
          }
          if (filter.since !== undefined && entry.updatedAt < filter.since) continue;
          if (filter.search && typeof filter.search === 'string') {
            const term = filter.search.toLowerCase();
            if (!entry.content.toLowerCase().includes(term)) continue;
          }
          if (filter.sessionId !== undefined && entry.metadata?.['sessionId'] !== filter.sessionId) continue;

          entries.push(entry);
        }
      }

      entries.sort((a, b) => b.updatedAt - a.updatedAt);

      if (filter.offset !== undefined && filter.offset > 0) {
        entries.splice(0, filter.offset);
      }

      if (filter.limit !== undefined && filter.limit > 0) {
        return entries.slice(0, filter.limit);
      }

      return entries;
    },

    async update(id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'grade' | 'metadata' | 'tags'>>) {
      const raw = await client.get(entryKey(id));
      if (!raw) {
        throw new HarnessError(`Memory entry not found: ${id}`, 'NOT_FOUND');
      }
      let existing: MemoryEntry;
      try {
        existing = JSON.parse(raw) as MemoryEntry;
      } catch {
        throw new HarnessError(`Corrupted memory entry: ${id}`, 'DATA_CORRUPTION', 'Delete and recreate the entry');
      }
      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      await setEntry(updated);
      return updated;
    },

    async delete(id: string) {
      const existed = await client.del(entryKey(id));
      await client.srem(indexKey, id);
      return existed > 0;
    },

    async compact(policy: CompactionPolicy) {
      const allIds = await client.smembers(indexKey);
      const entries: MemoryEntry[] = [];

      const batchSize = 100;
      for (let i = 0; i < allIds.length; i += batchSize) {
        const batch = allIds.slice(i, i + batchSize);
        const keys = batch.map(entryKey);
        const values = await client.mget(...keys);
        for (const raw of values) {
          if (!raw) continue;
          let entry: MemoryEntry;
          try {
            entry = JSON.parse(raw) as MemoryEntry;
          } catch {
            continue; // Skip corrupted entries
          }
          entries.push(entry);
        }
      }

      const now = Date.now();
      const weights = policy.gradeWeights ?? {
        critical: 1.0,
        useful: 0.5,
        ephemeral: 0.1,
      };
      const freedSet = new Set<string>();

      if (policy.maxAge !== undefined) {
        for (const entry of entries) {
          if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
            await client.del(entryKey(entry.id));
            await client.srem(indexKey, entry.id);
            freedSet.add(entry.id);
          }
        }
      }

      const remaining = entries.filter((e) => !freedSet.has(e.id));
      if (policy.maxEntries !== undefined && remaining.length > policy.maxEntries) {
        remaining.sort(
          (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
        );
        while (remaining.length > policy.maxEntries) {
          const victim = remaining.shift()!;
          if (weights[victim.grade] < 1.0) {
            await client.del(entryKey(victim.id));
            await client.srem(indexKey, victim.id);
            freedSet.add(victim.id);
          } else {
            break;
          }
        }
      }

      return {
        removed: freedSet.size,
        remaining: await client.scard(indexKey),
        freedEntries: [...freedSet],
      };
    },

    async count() {
      return client.scard(indexKey);
    },

    async clear() {
      const allIds = await client.smembers(indexKey);
      if (allIds.length > 0) {
        const keys = allIds.map(entryKey);
        await client.del(...keys, indexKey);
      }
    },
  };
}
