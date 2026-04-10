/**
 * Raw file I/O operations for the file-system memory store.
 *
 * Handles reading/writing entries and the index file with atomicity guarantees
 * (write-then-rename), batched operations to avoid fd exhaustion, and
 * proper error discrimination (ENOENT vs other errors).
 *
 * @module
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { MemoryEntry } from './types.js';

/** Index mapping keys to entry IDs. */
export interface Index {
  keys: Record<string, string>; // key -> id
}

/**
 * Create a file I/O helper bound to a specific directory.
 */
export function createFileIO(config: { directory: string; indexFile?: string }) {
  const dir = config.directory;
  const indexFileName = config.indexFile ?? '_index.json';
  const indexPath = join(dir, indexFileName);

  /** Ensure the storage directory exists. */
  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Get the file path for an entry by ID. */
  function entryPath(id: string): string {
    return join(dir, `${id}.json`);
  }

  /** Read the index file. Returns empty index for ENOENT (first run). */
  async function readIndex(): Promise<Index> {
    try {
      const raw = await readFile(indexPath, 'utf-8');
      return JSON.parse(raw) as Index;
    } catch (err: unknown) {
      // ENOENT is expected on first run -- return empty index
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { keys: {} };
      // Re-throw permission errors, disk errors, etc.
      throw err;
    }
  }

  /** Write the index file atomically (write-then-rename). */
  async function writeIndex(index: Index): Promise<void> {
    const tmpPath = indexPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
    await rename(tmpPath, indexPath);
  }

  /** Read a single entry by ID. Returns null for ENOENT (missing file). */
  async function readEntry(id: string): Promise<MemoryEntry | null> {
    try {
      const raw = await readFile(entryPath(id), 'utf-8');
      return JSON.parse(raw) as MemoryEntry;
    } catch (err: unknown) {
      // ENOENT means the entry file doesn't exist -- return null
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Re-throw permission errors, disk errors, JSON parse errors, etc.
      throw err;
    }
  }

  /** Write a single entry atomically (write-then-rename). */
  async function writeEntry(entry: MemoryEntry): Promise<void> {
    const path = entryPath(entry.id);
    const tmpPath = path + '.tmp';
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    await rename(tmpPath, path);
  }

  /** Read entry files in parallel batches to avoid fd exhaustion. */
  async function batchRead(files: string[], batchSize = 50): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const entries = await Promise.all(
        batch.map(file => readEntry(basename(file, '.json')))
      );
      results.push(...entries.filter((e): e is MemoryEntry => e !== null));
    }
    return results;
  }

  /** Delete files in parallel batches to avoid fd exhaustion. */
  async function batchUnlink(paths: string[], batchSize = 50): Promise<void> {
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      await Promise.all(batch.map(p => unlink(p).catch(() => {})));
    }
  }

  /** List all JSON entry files in the directory (excluding the index file). */
  async function listEntryFiles(): Promise<string[]> {
    try {
      const files = await readdir(dir);
      return files.filter(f => f.endsWith('.json') && f !== indexFileName);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  return {
    ensureDir,
    entryPath,
    readIndex,
    writeIndex,
    readEntry,
    writeEntry,
    batchRead,
    batchUnlink,
    listEntryFiles,
    get indexFileName() { return indexFileName; },
  };
}

/** Type for the file I/O helper returned by createFileIO. */
export type FileIO = ReturnType<typeof createFileIO>;
