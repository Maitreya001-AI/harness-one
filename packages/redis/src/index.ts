/**
 * The `@harness-one/redis` package — Redis-backed memory store for harness-one.
 *
 * Provides persistent memory storage using Redis, with support for
 * filtering, compaction, and key indexing.
 *
 * Wave-16 M2 split — the 569-LOC monolith that used to live here has been
 * decomposed into cohesive sub-modules. This file now only holds the
 * public types + the `createRedisStore` factory that wires them together.
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
import { requireFinitePositive } from 'harness-one/advanced';
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
   * Wave-13 K-1: opt-in to the legacy "warn + skip chunk" behaviour when a
   * batched MGET sub-request fails during `query()`. Default is strict:
   * the failure is re-thrown so partial result sets never leak.
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

/**
 * Create a Redis-backed memory store. The returned handle is a plain
 * object; ioredis ownership (connect/disconnect) stays with the caller.
 */
export function createRedisStore(config: RedisStoreConfig): RedisMemoryStore {
  const { client } = config;
  const prefix = config.prefix ?? 'harness:memory';
  const defaultTTL = config.defaultTTL;
  // Wave-5F T13: delegate default logger to core's redaction-enabled singleton.
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
  requireFinitePositive(defaultTTL, 'defaultTTL');

  const keyspace = createRedisKeyspace(prefix, config.tenantId, logger);

  function generateId(): string {
    return `mem_${randomUUID()}`;
  }

  return {
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
  };
}
