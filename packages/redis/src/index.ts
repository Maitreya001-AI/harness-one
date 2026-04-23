/**
 * The `@harness-one/redis` package — Redis-backed memory store for harness-one.
 *
 * Provides persistent memory storage using Redis, with support for
 * filtering, compaction, and key indexing.
 *
 * Structure: this file holds the public types + the `createRedisStore`
 * factory that wires together the cohesive sub-modules.
 *
 *   - `keys.ts`       tenant-aware key construction + tenantId guard
 *   - `codec.ts`      JSON parse/validate + SADD-tracked writes
 *   - `query.ts`      MGET-batched filter application
 *   - `update-txn.ts` WATCH/MULTI/EXEC optimistic-locking retry loop
 *   - `compact.ts`    policy eviction + explicit corruption sweep
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
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { createDefaultLogger } from 'harness-one/observe';

import { createRedisKeyspace } from './keys.js';
import { getEntry, setEntry } from './codec.js';
import { queryEntries } from './query.js';
import { transactionalUpdate } from './update-txn.js';
import { compactEntries, repairEntries } from './compact.js';

/**
 * Minimal structured logger accepted by the Redis store. Falls back to
 * `console.warn` when no logger is supplied so we never drop diagnostics
 * silently. Matches the shape the rest of harness-one uses (`logger.warn`).
 */
export interface RedisStoreLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export interface RedisStoreConfig {
  /** ioredis client instance (required). */
  client: Redis;
  /** Key prefix to scope this store's entries. Default: `'harness:memory'`. */
  prefix?: string;
  /** Default TTL in seconds for every stored entry. */
  defaultTTL?: number;
  /** Optional logger for warnings (e.g., corrupted payloads). */
  logger?: RedisStoreLogger;
  /**
   * Tenancy namespace for multi-tenant deployments. Defaults to `"default"`
   * with a logged warning — production callers MUST set this per tenant
   * to prevent cross-tenant reads.
   */
  tenantId?: string;
  /**
   * Opt-in to "warn + skip chunk" behaviour when a batched MGET
   * sub-request fails during `query()`. Default is strict: the failure
   * is re-thrown so partial result sets never leak.
   */
  partialOk?: boolean;
}

/**
 * Redis-backed {@link MemoryStore} with the extra `repair()` admin routine
 * for the SEC-014 corruption-sweep workflow.
 */
export interface RedisMemoryStore extends MemoryStore {
  /** Explicit corruption sweep — see `compact.ts`. */
  repair(): Promise<{ repaired: number }>;
}

function assertFinitePositive(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new HarnessError(
      `${name} must be a positive finite number`,
      HarnessErrorCode.CORE_INVALID_CONFIG,
    );
  }
}

/**
 * Create a Redis-backed memory store. The returned handle is a plain
 * object; ioredis ownership (connect/disconnect) stays with the caller.
 */
export function createRedisStore(config: RedisStoreConfig): RedisMemoryStore {
  const { client } = config;
  const prefix = config.prefix ?? 'harness:memory';
  const defaultTTL = config.defaultTTL;
  // Delegate default logger to core's redaction-enabled singleton.
  // `RedisStoreLogger` only needs `.warn`, which the core Logger satisfies.
  const logger: RedisStoreLogger = config.logger ?? createDefaultLogger();
  const partialOk = config.partialOk === true;

  if (!client) {
    throw new HarnessError(
      'Redis client is required',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a valid ioredis client instance',
    );
  }
  assertFinitePositive(defaultTTL, 'defaultTTL');

  const keyspace = createRedisKeyspace(prefix, config.tenantId, logger);
  const versionKey = (key: string): string =>
    `${prefix}:${keyspace.tenantId}:__version__:${encodeURIComponent(key)}`;

  function serializeMemoryValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  function parseMemoryValue<T>(content: string): T | undefined {
    try {
      return JSON.parse(content) as T;
    } catch {
      return content as T;
    }
  }

  async function findLatestByKey(key: string): Promise<MemoryEntry | null> {
    const entries = await queryEntries({ client, keyspace, logger, partialOk }, {});
    const matches = entries
      .filter((entry) => entry.key === key)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return matches[0] ?? null;
  }

  function generateId(): string {
    return `mem_${randomUUID()}`;
  }

  return {
    capabilities: {
      atomicWrite: true,
      atomicUpdate: true,
      supportsTtl: true,
      supportsTenantScope: true,
      supportsOptimisticLock: true,
    },

    async write(input) {
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
      await setEntry(client, keyspace, entry, defaultTTL);
      return entry;
    },

    async read(id: string) {
      return getEntry(client, keyspace, id, logger);
    },

    async query(filter: MemoryFilter) {
      return queryEntries({ client, keyspace, logger, partialOk }, filter);
    },

    async update(id, updates) {
      return transactionalUpdate({ client, keyspace, defaultTTL, logger }, id, updates);
    },

    async delete(id: string) {
      const existed = await client.del(keyspace.entryKey(id));
      await client.srem(keyspace.indexKey, id);
      return existed > 0;
    },

    async compact(policy: CompactionPolicy) {
      return compactEntries({ client, keyspace, logger }, policy);
    },

    async count() {
      return client.scard(keyspace.indexKey);
    },

    async clear() {
      const allIds = await client.smembers(keyspace.indexKey);
      if (allIds.length > 0) {
        const keys = allIds.map((id) => keyspace.entryKey(id));
        await client.del(...keys, keyspace.indexKey);
      }
    },

    async repair() {
      return repairEntries({ client, keyspace, logger });
    },

    async setWithTtl(key: string, value: unknown, ttlMs: number) {
      assertFinitePositive(ttlMs, 'ttlMs');
      const existing = await findLatestByKey(key);
      const now = Date.now();
      const entry: MemoryEntry = existing
        ? {
            ...existing,
            content: serializeMemoryValue(value),
            updatedAt: now,
          }
        : {
            id: generateId(),
            key,
            content: serializeMemoryValue(value),
            grade: 'ephemeral',
            createdAt: now,
            updatedAt: now,
          };

      const pipeline = client.multi();
      pipeline.set(keyspace.entryKey(entry.id), JSON.stringify(entry), 'PX', ttlMs);
      pipeline.sadd(keyspace.indexKey, entry.id);
      await pipeline.exec();
    },

    scopedView(tenantId: string) {
      return createRedisStore({ ...config, tenantId });
    },

    async updateWithVersion<T>(
      key: string,
      expectedVersion: number,
      updater: (value: T | undefined) => T,
    ) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new HarnessError(
          'expectedVersion must be a non-negative integer',
          HarnessErrorCode.CORE_INVALID_CONFIG,
        );
      }

      const vKey = versionKey(key);
      for (;;) {
        await client.watch(vKey);
        const currentVersion = Number(await client.get(vKey) ?? '0');
        if (currentVersion !== expectedVersion) {
          await client.unwatch();
          throw new HarnessError(
            `Version conflict for key "${key}": expected ${expectedVersion}, found ${currentVersion}`,
            HarnessErrorCode.STORE_VERSION_CONFLICT,
          );
        }

        const existing = await findLatestByKey(key);
        const existingTtlMs = existing ? await client.pttl(keyspace.entryKey(existing.id)) : -1;
        const nextValue = updater(existing ? parseMemoryValue<T>(existing.content) : undefined);
        const now = Date.now();
        const entry: MemoryEntry = existing
          ? {
              ...existing,
              content: serializeMemoryValue(nextValue),
              updatedAt: now,
            }
          : {
              id: generateId(),
              key,
              content: serializeMemoryValue(nextValue),
              grade: 'useful',
              createdAt: now,
              updatedAt: now,
            };

        const multi = client.multi();
        if (existingTtlMs > 0) {
          multi.set(keyspace.entryKey(entry.id), JSON.stringify(entry), 'PX', existingTtlMs);
        } else if (defaultTTL !== undefined) {
          multi.set(keyspace.entryKey(entry.id), JSON.stringify(entry), 'EX', defaultTTL);
        } else {
          multi.set(keyspace.entryKey(entry.id), JSON.stringify(entry));
        }
        multi.sadd(keyspace.indexKey, entry.id);
        multi.set(vKey, String(currentVersion + 1));
        const result = await multi.exec();
        if (result) {
          return { newVersion: currentVersion + 1 };
        }
      }
    },
  };
}
