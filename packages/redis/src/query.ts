/**
 * Query + filter logic for the Redis memory store.
 *
 * Wave-16 M2 extraction. The MGET-batched fetch loop plus the in-memory
 * predicate application used to live inline inside `createRedisStore`. It
 * is split here so the factory body stays focused and so the "filter a
 * decoded entry by the MemoryFilter contract" predicate is sharable with
 * the compaction / repair paths.
 *
 * @module
 * @internal
 */

import type { Redis } from 'ioredis';
import type { MemoryEntry, MemoryFilter } from 'harness-one/memory';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { parseEntryFromRedis } from './codec.js';
import type { RedisKeyspace } from './keys.js';

/** Minimal logger shape shared with the store. */
interface WarnLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/** Runtime options passed into the query routine. */
export interface RedisQueryContext {
  readonly client: Redis;
  readonly keyspace: RedisKeyspace;
  readonly logger: WarnLogger;
  /** See `RedisStoreConfig.partialOk` — Wave-13 K-1 strict-by-default flag. */
  readonly partialOk: boolean;
}

/** Size of each MGET round-trip. */
const MGET_BATCH_SIZE = 100;

/**
 * True iff `entry` satisfies the non-id portions of `filter`. Kept as a
 * pure function so the compaction / repair paths can reuse the exact
 * predicate the query path applies. Aligned with the in-memory and
 * fs-store implementations (CQ-006: tag filter is OR across requested tags).
 */
export function matchesFilter(entry: MemoryEntry, filter: MemoryFilter): boolean {
  if (filter.grade && entry.grade !== filter.grade) return false;
  if (filter.tags && filter.tags.length > 0) {
    if (!filter.tags.some((t) => entry.tags?.includes(t))) return false;
  }
  if (filter.since !== undefined && entry.updatedAt < filter.since) return false;
  if (filter.search && typeof filter.search === 'string') {
    const term = filter.search.toLowerCase();
    if (!entry.content.toLowerCase().includes(term)) return false;
  }
  if (filter.sessionId !== undefined && entry.metadata?.['sessionId'] !== filter.sessionId) {
    return false;
  }
  return true;
}

/**
 * Apply `filter` over every entry in the tenant index, returning the
 * matching entries sorted by `updatedAt` desc. Offset/limit pagination is
 * applied after sort.
 */
export async function queryEntries(
  ctx: RedisQueryContext,
  filter: MemoryFilter,
): Promise<MemoryEntry[]> {
  const { client, keyspace, logger, partialOk } = ctx;
  const allIds = await client.smembers(keyspace.indexKey);
  const entries: MemoryEntry[] = [];

  for (let i = 0; i < allIds.length; i += MGET_BATCH_SIZE) {
    const batch = allIds.slice(i, i + MGET_BATCH_SIZE);
    const keys = batch.map((id) => keyspace.entryKey(id));
    let values: (string | null)[];
    try {
      values = await client.mget(...keys);
    } catch (err) {
      // Wave-13 K-1: by default, an MGET sub-batch failure is a hard
      // error so partial result sets never leak to the caller. Opt-in
      // `partialOk: true` restores the legacy "warn + skip chunk" semantics
      // for callers that explicitly accept degraded reads.
      if (!partialOk) {
        throw new HarnessError(
          `query() aborted: MGET batch ${Math.floor(i / MGET_BATCH_SIZE)} failed — partial results suppressed`,
          HarnessErrorCode.MEMORY_CORRUPT,
          'Set `partialOk: true` in the RedisStoreConfig if partial results are acceptable, otherwise verify Redis connectivity.',
          err instanceof Error ? err : undefined,
        );
      }
      logger.warn('[harness-one/redis] batch read failed, results may be partial (partialOk=true)', {
        batchSize: batch.length,
        batchIndex: Math.floor(i / MGET_BATCH_SIZE),
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (let k = 0; k < values.length; k++) {
      const raw = values[k];
      if (!raw) continue;
      const entry = parseEntryFromRedis(raw, batch[k], logger);
      if (!entry) continue; // Skip corrupted entries (already warned)
      if (matchesFilter(entry, filter)) entries.push(entry);
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
}
