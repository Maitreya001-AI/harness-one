/**
 * File-system backed memory store. Each entry is stored as one JSON file.
 *
 * Business logic layer that delegates raw I/O to fs-io.ts.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { createFileIO } from './fs-io.js';
import { secureId } from '../infra/ids.js';
import type { MemoryEntry } from './types.js';
import type { MemoryStore } from './store.js';

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
}): MemoryStore {
  const io = createFileIO(config);

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

    async query(filter) {
      await io.ensureDir();
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
        try {
          await io.writeIndex(newIndex);
        } catch (err) {
          throw new HarnessError(
            'Failed to write index after clearing entries — store may be in an inconsistent state',
            HarnessErrorCode.MEMORY_STORE_CORRUPTION,
            'Re-run clear() or manually delete the index file to rebuild',
            err instanceof Error ? err : undefined,
          );
        }
      });
    },
  };
}
