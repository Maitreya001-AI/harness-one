/**
 * File-system backed memory store. Each entry is stored as one JSON file.
 *
 * Business logic layer that delegates raw I/O to fs-io.ts.
 *
 * ### Crash-safety model
 *
 * Every single file write is atomic (write-temp → rename; see
 * {@link createFileIO}). Multi-file operations — `write()` / `delete()` /
 * `compact()` / `clear()` — are **not** transactional across files: a
 * process crash between the entry-file write and the index-file write
 * can leave the `_index.json` slightly out of date relative to what is
 * on disk.
 *
 * This does **not** affect `read(id)` or `query(filter)` — both operate
 * directly on entry files and never consult the index. The residual
 * consequences of a crash are therefore:
 *
 * - `write()` crash after entry, before index → an **orphan entry**
 *   visible to `query()` but absent from the index's key→id mapping.
 *   Dead disk weight until `reconcileIndex()` runs.
 * - `delete()` crash after unlink, before index → a **stale index
 *   entry** pointing to a now-missing file. Subsequent queries tolerate
 *   the missing file; the stale key lingers in the index until the next
 *   write overwrites it or `reconcileIndex()` runs.
 *
 * Call {@link FsMemoryStore.reconcileIndex} at boot, on a schedule, or
 * after a crash to rebuild `_index.json` from the actual entry files.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { createFileIO } from './fs-io.js';
import { secureId } from '../infra/ids.js';
import type { MemoryEntry } from './types.js';
import type { MemoryStore } from './store.js';

/**
 * File-system backed {@link MemoryStore}. Extends the base contract with a
 * recovery hook for rebuilding the on-disk index after a crash.
 */
export interface FsMemoryStore extends MemoryStore {
  /**
   * Rebuild `_index.json` from the actual entry files on disk.
   *
   * Walks every `{id}.json` under the store directory, re-derives the
   * `key → id` mapping (latest `updatedAt` wins on collisions), and
   * atomically replaces the index. Safe to call while the store is in
   * use — executes under the same in-process lock as writes.
   *
   * @returns counts of scanned entries and the number of distinct keys
   *          rebuilt into the index.
   */
  reconcileIndex(): Promise<{ scanned: number; keys: number }>;
}

/**
 * Create a file-system backed MemoryStore.
 *
 * Each entry is stored as `{directory}/{id}.json`. An index file maps keys to IDs.
 *
 * @warning This implementation uses in-process mutex only. It is NOT safe for
 * concurrent access from multiple processes. For multi-process scenarios, use a
 * database-backed store or add distributed file locking (e.g., `proper-lockfile`,
 * advisory locks via flock/fcntl).
 *
 * @example
 * ```ts
 * const store = createFileSystemStore({ directory: '/tmp/memory' });
 * await store.write({ key: 'greeting', content: 'hello', grade: 'useful' });
 * ```
 */
export function createFileSystemStore(config: {
  directory: string;
  indexFile?: string;
  /**
   * Optional structured logger. When set, partial failures from batched
   * deletes (compact / clear) emit a `warn` with the failure count and a
   * small sample of error strings so operators can investigate stale-entry
   * drift instead of silently corrupting the store.
   */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}): FsMemoryStore {
  const io = createFileIO(config);
  const logger = config.logger;

  /**
   * Wave-12 P1-5: log a `warn` when a batched unlink produced any failures.
   * We only sample the first three errors so the log line stays bounded,
   * regardless of how many deletes failed.
   */
  function logBatchUnlinkFailures(
    source: string,
    failed: Array<{ path: string; error: string }>,
  ): void {
    if (failed.length === 0 || !logger) return;
    try {
      logger.warn(
        `[harness-one/fs-store] ${source}: ${failed.length} entry delete(s) failed`,
        {
          source,
          failedCount: failed.length,
          sampleErrors: failed.slice(0, 3).map(f => f.error),
        },
      );
    } catch {
      // Logger failure is non-fatal — we must never let a logging hiccup
      // break the store operation.
    }
  }

  // Simple in-process mutex for index operations.
  // Prevents concurrent read-modify-write corruption of the index file.
  let indexLock: Promise<void> = Promise.resolve();

  function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = indexLock;
    indexLock = next;
    return prev.then(fn).finally(() => release());
  }

  function generateId(): string {
    // SEC-002: Use cryptographically secure randomness. On-disk entry IDs
    // appear in file paths, so predictable IDs allow enumeration of other
    // tenants' memory files.
    return `mem_${Date.now()}_${secureId()}`;
  }

  async function allEntries(): Promise<MemoryEntry[]> {
    const jsonFiles = await io.listEntryFiles();
    return io.batchRead(jsonFiles);
  }

  return {
    async write(input) {
      await io.ensureDir();
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
      // Write entry AND index inside the lock to prevent concurrent writes
      // for the same key from creating orphan entry files.
      await withIndexLock(async () => {
        await io.writeEntry(entry);
        const index = await io.readIndex();
        index.keys[entry.key] = entry.id;
        await io.writeIndex(index);
      });
      return entry;
    },

    async read(id) {
      await io.ensureDir();
      return io.readEntry(id);
    },

    async query(filter, opts) {
      await io.ensureDir();
      // Wave-13 E-5: honor AbortSignal between batches.
      const signal = opts?.signal;
      const throwIfAborted = (): void => {
        if (signal?.aborted) {
          throw new HarnessError(
            'Memory query aborted',
            HarnessErrorCode.CORE_ABORTED,
            'The provided AbortSignal was aborted before query completion',
          );
        }
      };
      throwIfAborted();
      // Stream entries in batches instead of loading all into memory.
      // Apply filters during read to minimize peak memory usage.
      const hasFilter = filter.grade !== undefined || (filter.tags && filter.tags.length > 0)
        || filter.since !== undefined || filter.search !== undefined;

      let results: MemoryEntry[];
      if (hasFilter) {
        // Filter during batch read to avoid holding all entries
        const allFiles = await io.listEntryFiles();

        results = [];
        const searchTerm = filter.search?.toLowerCase();
        const batchSize = 50;
        for (let i = 0; i < allFiles.length; i += batchSize) {
          // Wave-13 E-5: abort-check between each 50-entry batch.
          throwIfAborted();
          const batch = allFiles.slice(i, i + batchSize);
          const entries = await Promise.all(
            batch.map(file => io.readEntry(file.replace('.json', '')))
          );
          for (const e of entries) {
            if (!e) continue;
            if (filter.grade && e.grade !== filter.grade) continue;
            if (filter.tags && filter.tags.length > 0 && !filter.tags.some(t => e.tags?.includes(t))) continue;
            if (filter.since !== undefined && e.updatedAt < filter.since) continue;
            if (searchTerm && !e.content.toLowerCase().includes(searchTerm)) continue;
            results.push(e);
          }
        }
      } else {
        results = await allEntries();
      }

      results.sort((a, b) => b.updatedAt - a.updatedAt);

      if (filter.offset !== undefined && filter.offset > 0) {
        results = results.slice(filter.offset);
      }
      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }

      return results;
    },

    async update(id, updates) {
      await io.ensureDir();
      // Lock the entire read-modify-write to prevent concurrent updates
      // from causing lost writes (classic read-modify-write race).
      return withIndexLock(async () => {
        const existing = await io.readEntry(id);
        if (!existing) {
          throw new HarnessError(
            `Memory entry not found: ${id}`,
            HarnessErrorCode.MEMORY_NOT_FOUND,
            'Check that the entry ID is correct',
          );
        }
        const updated: MemoryEntry = {
          ...existing,
          ...updates,
          updatedAt: Date.now(),
        };
        await io.writeEntry(updated);
        return updated;
      });
    },

    async delete(id) {
      await io.ensureDir();
      return withIndexLock(async () => {
        try {
          const { unlink } = await import('node:fs/promises');
          await unlink(io.entryPath(id));
          const index = await io.readIndex();
          for (const [key, val] of Object.entries(index.keys)) {
            if (val === id) {
              delete index.keys[key];
            }
          }
          await io.writeIndex(index);
          return true;
        } catch {
          return false;
        }
      });
    },

    async compact(policy) {
      await io.ensureDir();
      return withIndexLock(async () => {
        // Read all entries once to avoid repeated I/O (was called 3 times before)
        let all = await allEntries();
        const now = Date.now();
        const weights = policy.gradeWeights ?? {
          critical: 1.0,
          useful: 0.5,
          ephemeral: 0.1,
        };
        const freed: string[] = [];

        // Remove entries older than maxAge
        if (policy.maxAge !== undefined) {
          const survivors: MemoryEntry[] = [];
          const toDelete: string[] = [];
          const deleteIdMap = new Map<string, string>(); // path -> entry id
          for (const entry of all) {
            if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
              const path = io.entryPath(entry.id);
              toDelete.push(path);
              deleteIdMap.set(path, entry.id);
            } else {
              survivors.push(entry);
            }
          }
          // Fix 19/20: Use structured batchUnlink result
          const result = await io.batchUnlink(toDelete);
          // Only count successfully deleted entries
          for (const deletedPath of result.deleted) {
            const entryId = deleteIdMap.get(deletedPath);
            if (entryId) freed.push(entryId);
          }
          // Fix 20: Keep failed entries in the survivor list so they remain in the index
          if (result.failed.length > 0) {
            for (const failure of result.failed) {
              const entryId = deleteIdMap.get(failure.path);
              if (entryId) {
                const entry = all.find(e => e.id === entryId);
                if (entry) survivors.push(entry);
              }
            }
          }
          // Wave-12 P1-5: surface partial-failure to the logger so operators
          // notice silent stale-entry accumulation.
          logBatchUnlinkFailures('compact.maxAge', result.failed);
          all = survivors;
        }

        // Trim to maxEntries
        if (policy.maxEntries !== undefined && all.length > policy.maxEntries) {
          const sorted = [...all].sort(
            (a, b) => weights[a.grade] - weights[b.grade] || a.updatedAt - b.updatedAt,
          );
          let current = all.length;
          const removedIds = new Set<string>();
          const toDelete: string[] = [];
          const deleteIdMap = new Map<string, string>(); // path -> entry id
          for (const victim of sorted) {
            if (current <= policy.maxEntries) break;
            if (weights[victim.grade] < 1.0) {
              const path = io.entryPath(victim.id);
              toDelete.push(path);
              deleteIdMap.set(path, victim.id);
              removedIds.add(victim.id);
              current--;
            }
          }
          // Fix 19/20: Use structured batchUnlink result
          const result = await io.batchUnlink(toDelete);
          // Only count successfully deleted entries
          const actuallyRemoved = new Set<string>();
          for (const deletedPath of result.deleted) {
            const entryId = deleteIdMap.get(deletedPath);
            if (entryId) {
              actuallyRemoved.add(entryId);
              freed.push(entryId);
            }
          }
          // Wave-12 P1-5: warn operators about partial-failure drift.
          logBatchUnlinkFailures('compact.maxEntries', result.failed);
          // Fix 20: Keep failed entries in the list (they were not deleted)
          all = all.filter((e) => !actuallyRemoved.has(e.id));
        }

        // Rebuild index from remaining entries (no extra I/O needed)
        const newIndex = { keys: {} as Record<string, string> };
        for (const entry of all) {
          newIndex.keys[entry.key] = entry.id;
        }
        await io.writeIndex(newIndex);

        return {
          removed: freed.length,
          remaining: all.length,
          freedEntries: freed,
        };
      });
    },

    async count() {
      await io.ensureDir();
      const files = await io.listEntryFiles();
      return files.length;
    },

    async reconcileIndex() {
      await io.ensureDir();
      return withIndexLock(async () => {
        const all = await allEntries();
        // Latest writer wins on key collisions — the entry with the
        // highest `updatedAt` represents the survivor. Ties break on
        // `createdAt` so deterministic ordering keeps tests stable even
        // when filesystem mtimes round to the millisecond.
        const latestByKey = new Map<string, MemoryEntry>();
        for (const entry of all) {
          const current = latestByKey.get(entry.key);
          if (
            !current ||
            entry.updatedAt > current.updatedAt ||
            (entry.updatedAt === current.updatedAt && entry.createdAt > current.createdAt)
          ) {
            latestByKey.set(entry.key, entry);
          }
        }
        const newIndex: { keys: Record<string, string> } = { keys: {} };
        for (const [key, entry] of latestByKey) {
          newIndex.keys[key] = entry.id;
        }
        await io.writeIndex(newIndex);
        return { scanned: all.length, keys: latestByKey.size };
      });
    },

    async clear() {
      await io.ensureDir();
      await withIndexLock(async () => {
        const all = await allEntries();
        const result = await io.batchUnlink(all.map(e => io.entryPath(e.id)));
        // Build index from entries that failed to delete
        const newIndex: { keys: Record<string, string> } = { keys: {} };
        if (result.failed.length > 0) {
          const failedPaths = new Set(result.failed.map(f => f.path));
          for (const entry of all) {
            if (failedPaths.has(io.entryPath(entry.id))) {
              newIndex.keys[entry.key] = entry.id;
            }
          }
        }
        // Wave-12 P1-5: surface partial-failure to the logger — `clear()` is a
        // blunt operation and a silent partial-success is especially hazardous.
        logBatchUnlinkFailures('clear', result.failed);
        try {
          await io.writeIndex(newIndex);
        } catch (err) {
          throw new HarnessError(
            'Failed to write index after clearing entries — store may be in an inconsistent state',
            HarnessErrorCode.MEMORY_CORRUPT,
            'Re-run clear() or manually delete the index file to rebuild',
            err instanceof Error ? err : undefined,
          );
        }
      });
    },
  };
}
