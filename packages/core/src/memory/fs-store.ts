/**
 * File-system backed memory store. Each entry is stored as one JSON file.
 *
 * @module
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '../core/errors.js';
import type { MemoryEntry } from './types.js';
import type { MemoryStore } from './store.js';

interface Index {
  keys: Record<string, string>; // key → id
}

/**
 * Create a file-system backed MemoryStore.
 *
 * Each entry is stored as `{directory}/{id}.json`. An index file maps keys to IDs.
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
  const dir = config.directory;
  const indexFileName = config.indexFile ?? '_index.json';
  const indexPath = join(dir, indexFileName);
  let idCounter = 0;

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
    return `mem_${Date.now()}_${++idCounter}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async function readIndex(): Promise<Index> {
    try {
      const raw = await readFile(indexPath, 'utf-8');
      return JSON.parse(raw) as Index;
    } catch {
      return { keys: {} };
    }
  }

  async function writeIndex(index: Index): Promise<void> {
    // Write-then-rename for atomicity: ensures the index is either
    // the old version or the new version, never a partially-written file.
    const tmpPath = indexPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
    await rename(tmpPath, indexPath);
  }

  /** Delete files in parallel batches to avoid fd exhaustion. */
  async function batchUnlink(paths: string[], batchSize = 50): Promise<void> {
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      await Promise.all(batch.map(p => unlink(p).catch(() => {})));
    }
  }

  function entryPath(id: string): string {
    return join(dir, `${id}.json`);
  }

  async function readEntry(id: string): Promise<MemoryEntry | null> {
    try {
      const raw = await readFile(entryPath(id), 'utf-8');
      return JSON.parse(raw) as MemoryEntry;
    } catch {
      return null;
    }
  }

  async function writeEntry(entry: MemoryEntry): Promise<void> {
    const path = entryPath(entry.id);
    const tmpPath = path + '.tmp';
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    await rename(tmpPath, path);
  }

  async function allEntries(): Promise<MemoryEntry[]> {
    try {
      const files = await readdir(dir);
      const jsonFiles = files.filter(f => f.endsWith('.json') && f !== indexFileName);
      const results = await Promise.all(
        jsonFiles.map(file => readEntry(file.replace('.json', '')))
      );
      return results.filter((e): e is MemoryEntry => e !== null);
    } catch {
      return [];
    }
  }

  return {
    async write(input) {
      await ensureDir();
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
      await writeEntry(entry);
      await withIndexLock(async () => {
        const index = await readIndex();
        index.keys[entry.key] = entry.id;
        await writeIndex(index);
      });
      return entry;
    },

    async read(id) {
      await ensureDir();
      return readEntry(id);
    },

    async query(filter) {
      await ensureDir();
      let results = await allEntries();

      if (filter.grade) {
        results = results.filter((e) => e.grade === filter.grade);
      }
      if (filter.tags && filter.tags.length > 0) {
        results = results.filter((e) =>
          filter.tags!.some((t) => e.tags?.includes(t)),
        );
      }
      if (filter.since !== undefined) {
        results = results.filter((e) => e.updatedAt >= filter.since!);
      }
      if (filter.search) {
        const term = filter.search.toLowerCase();
        results = results.filter((e) => e.content.toLowerCase().includes(term));
      }

      results.sort((a, b) => b.updatedAt - a.updatedAt);

      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }

      return results;
    },

    async update(id, updates) {
      await ensureDir();
      const existing = await readEntry(id);
      if (!existing) {
        throw new HarnessError(
          `Memory entry not found: ${id}`,
          'MEMORY_NOT_FOUND',
          'Check that the entry ID is correct',
        );
      }
      const updated: MemoryEntry = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      await writeEntry(updated);
      return updated;
    },

    async delete(id) {
      await ensureDir();
      return withIndexLock(async () => {
        try {
          await unlink(entryPath(id));
          const index = await readIndex();
          for (const [key, val] of Object.entries(index.keys)) {
            if (val === id) {
              delete index.keys[key];
            }
          }
          await writeIndex(index);
          return true;
        } catch {
          return false;
        }
      });
    },

    async compact(policy) {
      await ensureDir();
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
          for (const entry of all) {
            if (now - entry.createdAt > policy.maxAge && weights[entry.grade] < 1.0) {
              toDelete.push(entryPath(entry.id));
              freed.push(entry.id);
            } else {
              survivors.push(entry);
            }
          }
          await batchUnlink(toDelete);
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
          for (const victim of sorted) {
            if (current <= policy.maxEntries) break;
            if (weights[victim.grade] < 1.0) {
              toDelete.push(entryPath(victim.id));
              freed.push(victim.id);
              removedIds.add(victim.id);
              current--;
            }
          }
          await batchUnlink(toDelete);
          all = all.filter((e) => !removedIds.has(e.id));
        }

        // Rebuild index from remaining entries (no extra I/O needed)
        const newIndex: Index = { keys: {} };
        for (const entry of all) {
          newIndex.keys[entry.key] = entry.id;
        }
        await writeIndex(newIndex);

        return {
          removed: freed.length,
          remaining: all.length,
          freedEntries: freed,
        };
      });
    },

    async count() {
      await ensureDir();
      return (await allEntries()).length;
    },

    async clear() {
      await ensureDir();
      await withIndexLock(async () => {
        const all = await allEntries();
        await batchUnlink(all.map(e => entryPath(e.id)));
        await writeIndex({ keys: {} });
      });
    },
  };
}
