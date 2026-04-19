/**
 * Compaction + repair routines for the Redis memory store.
 *
 * `compact()` implements policy-driven eviction;
 * `repair()` is the explicit corruption sweep that replaced the old
 * auto-delete-on-read behaviour (SEC-014).
 *
 * Both walk the tenant index via chunked MGET, decode payloads, and issue
 * batched DEL/SREM pipelines — the shared shape keeps them side-by-side.
 *
 * @module
 * @internal
 */

import type { Redis } from 'ioredis';
import type {
  MemoryEntry,
  CompactionPolicy,
  CompactionResult,
} from 'harness-one/memory';
import { parseEntryFromRedis } from './codec.js';
import type { RedisKeyspace } from './keys.js';

/** Minimal logger shape shared with the store. */
interface WarnLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export interface RedisCompactContext {
  readonly client: Redis;
  readonly keyspace: RedisKeyspace;
  readonly logger: WarnLogger;
}

const MGET_BATCH_SIZE = 100;
/** Max members per SREM call so RESP frames stay bounded. */
const DEL_CHUNK_SIZE = 1000;

async function readAllEntries(
  ctx: RedisCompactContext,
  { logOnError }: { logOnError: string },
): Promise<{ entries: MemoryEntry[]; danglingIds: string[] }> {
  const { client, keyspace, logger } = ctx;
  const allIds = await client.smembers(keyspace.indexKey);
  const entries: MemoryEntry[] = [];
  const danglingIds: string[] = [];

  for (let i = 0; i < allIds.length; i += MGET_BATCH_SIZE) {
    const batch = allIds.slice(i, i + MGET_BATCH_SIZE);
    const keys = batch.map((id) => keyspace.entryKey(id));
    let values: (string | null)[];
    try {
      values = await client.mget(...keys);
    } catch (err) {
      // Transient failure — skip this chunk and let the next pass handle
      // it. Never throw from a maintenance routine.
      logger.warn(logOnError, {
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (let k = 0; k < values.length; k++) {
      const raw = values[k];
      if (raw === null) {
        // STRING missing but id still in SET — dangling index reference.
        danglingIds.push(batch[k]);
        continue;
      }
      const entry = parseEntryFromRedis(raw, batch[k], logger);
      if (!entry) {
        danglingIds.push(batch[k]);
        continue;
      }
      entries.push(entry);
    }
  }
  return { entries, danglingIds };
}

async function deleteVictims(
  ctx: RedisCompactContext,
  victimIds: readonly string[],
): Promise<void> {
  if (victimIds.length === 0) return;
  const { client, keyspace } = ctx;
  for (let i = 0; i < victimIds.length; i += DEL_CHUNK_SIZE) {
    const chunk = victimIds.slice(i, i + DEL_CHUNK_SIZE);
    const pipeline = client.multi();
    for (const id of chunk) {
      pipeline.del(keyspace.entryKey(id));
    }
    // Single SREM with multiple members is O(N) on the server but only
    // one network round-trip, versus one SREM per member before.
    pipeline.srem(keyspace.indexKey, ...chunk);
    await pipeline.exec();
  }
}

/**
 * Policy-driven eviction. Walks the tenant index, decides which entries
 * to drop (by age and/or count bounds, weighted by grade), then issues
 * batched DEL/SREM pipelines. Returns the freed id set alongside the
 * remaining cardinality reported by SCARD.
 */
export async function compactEntries(
  ctx: RedisCompactContext,
  policy: CompactionPolicy,
): Promise<CompactionResult> {
  const { entries } = await readAllEntries(ctx, {
    logOnError: '[harness-one/redis] compact batch read failed, skipping chunk',
  });

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

  await deleteVictims(ctx, victims);

  return {
    removed: victimSet.size,
    remaining: await ctx.client.scard(ctx.keyspace.indexKey),
    freedEntries: [...victimSet],
  };
}

/**
 * SEC-014: Explicit corruption sweep. Walks the index, re-reads each
 * payload, and removes any that fail JSON parse or schema validation.
 * Unlike the old auto-delete-on-read behaviour, this is opt-in — callers
 * invoke it from a maintenance job or admin endpoint, never from a hot
 * request path.
 */
export async function repairEntries(
  ctx: RedisCompactContext,
): Promise<{ repaired: number }> {
  const { danglingIds } = await readAllEntries(ctx, {
    logOnError: '[harness-one/redis] repair batch read failed, skipping chunk',
  });
  await deleteVictims(ctx, danglingIds);
  return { repaired: danglingIds.length };
}
