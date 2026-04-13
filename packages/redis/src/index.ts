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
import { validateMemoryEntry, parseJsonSafe } from 'harness-one/memory';
import { HarnessError } from 'harness-one/core';

/**
 * Minimal structured logger accepted by the Redis store. Falls back to
 * `console.warn` when no logger is supplied so we never drop diagnostics
 * silently. Matches the shape the rest of harness-one uses (`logger.warn`).
 */
export interface RedisStoreLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Parse + validate a MemoryEntry from a Redis-stored JSON string.
 * Returns null on corruption (invalid JSON or shape mismatch); callers decide
 * whether to skip silently or raise. Always logs one line so corruption
 * isn't invisible.
 */
function parseEntryFromRedis(
  raw: string,
  id: string,
  logger: RedisStoreLogger,
): MemoryEntry | null {
  const parsed = parseJsonSafe(raw);
  if (!parsed.ok) {
    logger.warn(`[harness-one/redis] corrupted entry ${id}: ${parsed.error.message}`, {
      entryId: id,
      reason: 'invalid_json',
    });
    return null;
  }
  try {
    return validateMemoryEntry(parsed.value, `redis entry ${id}`);
  } catch (err) {
    logger.warn(
      `[harness-one/redis] invalid entry shape ${id}: ${err instanceof Error ? err.message : String(err)}`,
      { entryId: id, reason: 'invalid_shape' },
    );
    return null;
  }
}

/** Configuration for the Redis memory store. */
export interface RedisStoreConfig {
  /** A pre-configured ioredis client instance. */
  readonly client: Redis;
  /** Key prefix for Redis keys. Defaults to 'harness:memory'. */
  readonly prefix?: string;
  /** Default TTL in seconds for entries. Undefined = no expiry. */
  readonly defaultTTL?: number;
  /**
   * Optional logger for diagnostic warnings (e.g., corrupt entries).
   * Defaults to a `console.warn`-backed shim so warnings remain visible.
   */
  readonly logger?: RedisStoreLogger;
}

/**
 * Redis memory store extended with operator-facing maintenance operations.
 * `repair()` is additive to the base {@link MemoryStore} contract — callers
 * must opt in explicitly because it performs destructive cleanup.
 */
export interface RedisMemoryStore extends MemoryStore {
  /**
   * Scan the index, detect corrupt entries (invalid JSON or shape), and
   * remove them from both the STRING bucket and the index SET. Returns the
   * count of entries removed. Safe to run idempotently.
   *
   * Exposed separately from `read()` so a single malformed payload cannot be
   * weaponised to trigger auto-delete on every lookup (SEC-014): observation
   * is read-only by default; destructive cleanup is an explicit operator call.
   */
  repair(): Promise<{ repaired: number }>;
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
export function createRedisStore(config: RedisStoreConfig): RedisMemoryStore {
  const { client } = config;
  const prefix = config.prefix ?? 'harness:memory';
  const defaultTTL = config.defaultTTL;
  // Default logger delegates to console.warn so existing callers keep their
  // diagnostic output. Operators who want structured logs can inject one.
  const logger: RedisStoreLogger = config.logger ?? {
    warn: (message) => console.warn(message),
  };

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

  /**
   * SEC-014: Non-destructive read. A corrupted payload used to auto-delete
   * itself here (`DEL` + `SREM`), which let any write of a malformed string
   * erase entries on first read — a denial-of-service gadget for multi-tenant
   * deployments. We now return `null` with a warning; callers who want to
   * evict corrupt records must invoke {@link RedisMemoryStore.repair}
   * explicitly.
   */
  async function getEntry(id: string): Promise<MemoryEntry | null> {
    const raw = await client.get(entryKey(id));
    if (!raw) return null;
    const entry = parseEntryFromRedis(raw, id, logger);
    if (!entry) {
      return null;
    }
    return entry;
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
        let values: (string | null)[];
        try {
          values = await client.mget(...keys);
        } catch {
          // Connection failure mid-batch: skip this chunk and continue
          logger.warn('[harness-one/redis] batch read failed, results may be partial');
          continue;
        }

        for (let k = 0; k < values.length; k++) {
          const raw = values[k];
          if (!raw) continue;
          const entry = parseEntryFromRedis(raw, batch[k], logger);
          if (!entry) continue; // Skip corrupted entries (already warned)

          if (filter.grade && entry.grade !== filter.grade) continue;
          if (filter.tags && filter.tags.length > 0) {
            // CQ-006: OR semantics — match entries that carry ANY of the
            // requested tags. Aligned with the in-memory and fs-store
            // implementations so the MemoryStore contract is backend-agnostic.
            if (!filter.tags.some((t) => entry.tags?.includes(t))) continue;
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

    /**
     * Update an entry. Note: this is NOT atomic across processes.
     * For concurrent access, use Redis transactions (WATCH/MULTI/EXEC) at the application level.
     */
    async update(id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'grade' | 'metadata' | 'tags'>>) {
      const raw = await client.get(entryKey(id));
      if (!raw) {
        throw new HarnessError(`Memory entry not found: ${id}`, 'NOT_FOUND');
      }
      const existing = parseEntryFromRedis(raw, id, logger);
      if (!existing) {
        throw new HarnessError(
          `Corrupted memory entry: ${id}`,
          'DATA_CORRUPTION',
          'Delete and recreate the entry',
        );
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
        let values: (string | null)[];
        try {
          values = await client.mget(...keys);
        } catch {
          // Connection failure mid-batch: skip this chunk and continue
          continue;
        }
        for (let k = 0; k < values.length; k++) {
          const raw = values[k];
          if (!raw) continue;
          const entry = parseEntryFromRedis(raw, batch[k], logger);
          if (!entry) continue;
          entries.push(entry);
        }
      }

      const now = Date.now();
      const weights = policy.gradeWeights ?? {
        critical: 1.0,
        useful: 0.5,
        ephemeral: 0.1,
      };
      const victims: string[] = [];

      if (policy.maxAge !== undefined) {
        for (const entry of entries) {
          if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
            victims.push(entry.id);
          }
        }
      }

      // Compute set of IDs already scheduled for removal so the second pass
      // can skip them when ranking the remaining entries by weight/age.
      const victimSet = new Set(victims);
      if (policy.maxEntries !== undefined) {
        const remaining = entries.filter((e) => !victimSet.has(e.id));
        if (remaining.length > policy.maxEntries) {
          remaining.sort(
            (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
          );
          let survivingCount = remaining.length;
          for (const victim of remaining) {
            if (survivingCount <= policy.maxEntries) break;
            if (weights[victim.grade] < 1.0) {
              victims.push(victim.id);
              victimSet.add(victim.id);
              survivingCount--;
            } else {
              // Remaining entries share the same or higher weight (we sorted
              // by ascending weight), so there are no more evictable victims.
              break;
            }
          }
        }
      }

      // CQ-023: Batch all DEL/SREM calls through a single MULTI pipeline
      // instead of N sequential round-trips. Chunked at 1000 members per
      // SREM to keep each command bounded and avoid oversized RESP frames.
      if (victims.length > 0) {
        const chunkSize = 1000;
        for (let i = 0; i < victims.length; i += chunkSize) {
          const chunk = victims.slice(i, i + chunkSize);
          const pipeline = client.multi();
          for (const id of chunk) {
            pipeline.del(entryKey(id));
          }
          // Single SREM with multiple members is O(N) on the server but only
          // one network round-trip, versus one SREM per member before.
          pipeline.srem(indexKey, ...chunk);
          await pipeline.exec();
        }
      }

      return {
        removed: victimSet.size,
        remaining: await client.scard(indexKey),
        freedEntries: [...victimSet],
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

    /**
     * SEC-014: Explicit corruption sweep. Walks the index, re-reads each
     * payload, and removes any that fail JSON parse or schema validation.
     * Unlike the old auto-delete-on-read behaviour, this is opt-in — callers
     * invoke it from a maintenance job or admin endpoint, never from a hot
     * request path.
     */
    async repair(): Promise<{ repaired: number }> {
      const allIds = await client.smembers(indexKey);
      const corruptIds: string[] = [];
      const batchSize = 100;
      for (let i = 0; i < allIds.length; i += batchSize) {
        const batch = allIds.slice(i, i + batchSize);
        const keys = batch.map(entryKey);
        let values: (string | null)[];
        try {
          values = await client.mget(...keys);
        } catch {
          // Transient failure — skip this chunk and let the next repair pass
          // handle it. Never throw from a maintenance routine.
          logger.warn('[harness-one/redis] repair batch read failed, skipping chunk');
          continue;
        }
        for (let k = 0; k < values.length; k++) {
          const raw = values[k];
          if (raw === null) {
            // STRING missing but id still in SET — dangling index reference.
            corruptIds.push(batch[k]);
            continue;
          }
          const entry = parseEntryFromRedis(raw, batch[k], logger);
          if (!entry) corruptIds.push(batch[k]);
        }
      }

      if (corruptIds.length > 0) {
        const chunkSize = 1000;
        for (let i = 0; i < corruptIds.length; i += chunkSize) {
          const chunk = corruptIds.slice(i, i + chunkSize);
          const pipeline = client.multi();
          for (const id of chunk) {
            pipeline.del(entryKey(id));
          }
          pipeline.srem(indexKey, ...chunk);
          await pipeline.exec();
        }
      }

      return { repaired: corruptIds.length };
    },
  };
}
