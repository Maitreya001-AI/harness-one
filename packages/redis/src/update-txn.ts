/**
 * Optimistic-locking update for the Redis memory store: WATCH → GET → MULTI
 * → EXEC, retried up to `MAX_RETRIES` times on concurrent modification.
 *
 * Wave-16 M2 extraction. The transaction body has a dozen subtle invariants
 * (pre-WATCH computation, UNWATCH on every error path, no `await` between
 * MULTI and EXEC) documented in place — pulling it into its own module
 * keeps the store factory readable and makes this critical section easy to
 * find in the future.
 *
 * @module
 * @internal
 */

import type { Redis } from 'ioredis';
import type { MemoryEntry } from 'harness-one/memory';
import { HarnessError, HarnessErrorCode } from 'harness-one/core';
import { parseEntryFromRedis } from './codec.js';
import type { RedisKeyspace } from './keys.js';

/** Minimal logger shape shared with the store. */
interface WarnLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/** Runtime context for the transactional update. */
export interface RedisUpdateContext {
  readonly client: Redis;
  readonly keyspace: RedisKeyspace;
  readonly defaultTTL: number | undefined;
  readonly logger: WarnLogger;
}

const MAX_RETRIES = 3;

/**
 * Update an entry with optimistic locking via WATCH/MULTI/EXEC.
 *
 * F10: The read-modify-write cycle is protected against concurrent
 * mutations. If another client modifies the key between WATCH and EXEC,
 * the transaction returns `null` and we retry (up to `MAX_RETRIES` times).
 *
 * Wave-13 P0-7: Hardened around the WATCH/UNWATCH contract.
 *   (a) All data that does NOT depend on the read (i.e. the updates bag
 *       and the serialisation overhead) is prepared BEFORE WATCH, so the
 *       WATCH → GET → MULTI → EXEC window is as tight as possible.
 *   (b) Every error path (not-found, corrupt, unexpected throw from
 *       GET / parse / JSON.stringify / EXEC) runs UNWATCH via a
 *       `safeUnwatch` helper that never re-throws.
 *   (c) No `await` sits between MULTI pipeline construction and EXEC —
 *       the pipeline is built synchronously and EXEC is the next `await`.
 *   (d) A failed EXEC (returns null) runs UNWATCH defensively before the
 *       next iteration re-WATCHes, so a client driver that left the
 *       session in a watched state can't accumulate stale watches.
 */
export async function transactionalUpdate(
  ctx: RedisUpdateContext,
  id: string,
  updates: Partial<Pick<MemoryEntry, 'content' | 'grade' | 'metadata' | 'tags'>>,
): Promise<MemoryEntry> {
  const { client, keyspace, defaultTTL, logger } = ctx;
  const key = keyspace.entryKey(id);

  const now = (): number => Date.now();

  const safeUnwatch = async (): Promise<void> => {
    try {
      await client.unwatch();
    } catch (err) {
      // UNWATCH is best-effort — a transient connection failure just means
      // the server will expire our watch on its own. Log at warn so the
      // signal isn't completely swallowed.
      logger.warn('[harness-one/redis] UNWATCH failed', {
        entryId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await client.watch(key);

    let raw: string | null;
    try {
      raw = await client.get(key);
    } catch (err) {
      // (b): any throw from GET must release WATCH before propagating.
      await safeUnwatch();
      throw err;
    }

    if (!raw) {
      await safeUnwatch();
      throw new HarnessError(`Memory entry not found: ${id}`, HarnessErrorCode.MEMORY_NOT_FOUND);
    }

    const existing = parseEntryFromRedis(raw, id, logger);
    if (!existing) {
      await safeUnwatch();
      throw new HarnessError(
        `Corrupted memory entry: ${id}`,
        HarnessErrorCode.MEMORY_CORRUPT,
        'Delete and recreate the entry',
      );
    }

    // (c): build the pipeline synchronously — no `await` between MULTI and
    // EXEC. All value-computation happens here so the server sees
    // WATCH → GET → MULTI → EXEC with no interleaved round-trips.
    try {
      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: now(),
      };
      const value = JSON.stringify(updated);

      const pipeline = client.multi();
      if (defaultTTL) {
        pipeline.set(key, value, 'EX', defaultTTL);
      } else {
        pipeline.set(key, value);
      }
      pipeline.sadd(keyspace.indexKey, id);
      const result = await pipeline.exec();

      if (result !== null) {
        return updated; // Success — no conflict, WATCH is auto-released by EXEC
      }
      // (d): EXEC returned null — WATCH detected a concurrent modification.
      // EXEC auto-releases the watch, but UNWATCH is idempotent and cheap;
      // calling it keeps the session state consistent if the driver
      // retained any watch metadata.
      await safeUnwatch();
    } catch (err) {
      // (b): any throw between MULTI build and EXEC must release WATCH.
      await safeUnwatch();
      throw err;
    }
    // result was null → retry on next loop iteration.
  }

  throw new HarnessError(
    `Concurrent update conflict after ${MAX_RETRIES} retries for entry: ${id}`,
    HarnessErrorCode.MEMORY_RELAY_CONFLICT,
    'Retry the operation or use application-level serialization',
  );
}
