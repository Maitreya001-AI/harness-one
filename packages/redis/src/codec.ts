/**
 * Payload codec for the Redis memory store — owns the
 * JSON parse/validate/stringify round-trip and the small "write this
 * entry + add id to the tenant index" primitive.
 *
 * Wave-16 M2 extraction from `index.ts` so the store factory can stay
 * focused on orchestration. The codec is a pure function of its inputs;
 * it reaches into the client only via the pipeline + get APIs that ioredis
 * already exposes.
 *
 * @module
 * @internal
 */

import type { Redis } from 'ioredis';
import type { MemoryEntry } from 'harness-one/memory';
import { validateMemoryEntry, parseJsonSafe } from 'harness-one/memory';
import type { RedisKeyspace } from './keys.js';

/** Minimal logger shape shared with the store. */
interface WarnLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Parse + validate a MemoryEntry from a Redis-stored JSON string.
 * Returns null on corruption (invalid JSON or shape mismatch); callers
 * decide whether to skip silently or raise. Always logs one line so
 * corruption isn't invisible.
 *
 * SEC-014: previously this function auto-deleted corrupt payloads inline,
 * letting any malformed-string write evict entries on first read. That
 * behaviour now lives in the explicit `repair()` admin routine; this
 * function is strictly read-only.
 */
export function parseEntryFromRedis(
  raw: string,
  id: string,
  logger: WarnLogger,
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
    return validateMemoryEntry(parsed.value);
  } catch (err) {
    logger.warn(`[harness-one/redis] corrupted entry ${id}: ${err instanceof Error ? err.message : String(err)}`, {
      entryId: id,
      reason: 'schema_violation',
    });
    return null;
  }
}

/**
 * SEC-014: Non-destructive read. Returns `null` on corruption with a
 * warning; callers who want to evict corrupt records must invoke
 * `repair()` explicitly.
 */
export async function getEntry(
  client: Redis,
  keyspace: RedisKeyspace,
  id: string,
  logger: WarnLogger,
): Promise<MemoryEntry | null> {
  const raw = await client.get(keyspace.entryKey(id));
  if (!raw) return null;
  return parseEntryFromRedis(raw, id, logger);
}

/**
 * Write an entry + SADD its id to the tenant index in one pipeline. Honours
 * `defaultTTL` when set. Does not retry; callers own the retry policy.
 */
export async function setEntry(
  client: Redis,
  keyspace: RedisKeyspace,
  entry: MemoryEntry,
  defaultTTL: number | undefined,
): Promise<void> {
  const key = keyspace.entryKey(entry.id);
  const value = JSON.stringify(entry);
  const pipeline = client.multi();
  // `defaultTTL === undefined` → persist without an expiry; any explicit
  // numeric value (including `0`, which Redis treats as "expire
  // immediately") is forwarded verbatim via SET EX.
  if (defaultTTL !== undefined) {
    pipeline.set(key, value, 'EX', defaultTTL);
  } else {
    pipeline.set(key, value);
  }
  pipeline.sadd(keyspace.indexKey, entry.id);
  await pipeline.exec();
}
