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
import { join, basename, resolve, sep } from 'node:path';
import type { MemoryEntry } from './types.js';
import { validateIndex, validateMemoryEntry, parseJsonSafe } from './_schemas.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';

/** Index mapping keys to entry IDs. */
export interface Index {
  keys: Record<string, string>; // key -> id
}

/**
 * Allowed characters for memory entry IDs. Limits to ASCII alphanumerics,
 * underscore, and hyphen; length 1-128. Deliberately excludes path separators
 * (`/`, `\`), `.`, `..`, NUL, and any filesystem-significant punctuation to
 * prevent path-traversal attacks (SEC-003) before any `path.join` / `readFile`
 * call touches disk.
 */
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validate an entry ID against {@link ENTRY_ID_PATTERN}.
 *
 * Throws `HarnessError(HarnessErrorCode.CORE_INVALID_ID)` when the id contains anything that could
 * escape the store directory (e.g., `../etc/passwd`, `foo/bar`, backslashes,
 * nuls, or just an over-long string). The helper is invoked at the top of
 * every function that turns an id into a filesystem path, so the invariant is
 * enforced at the API boundary — defence in depth against any caller (user
 * input, orchestration layer, legacy data) that might carry a tainted id.
 */
export function validateEntryId(id: string): void {
  if (typeof id !== 'string' || !ENTRY_ID_PATTERN.test(id)) {
    throw new HarnessError(
      'memory entry id format',
      HarnessErrorCode.CORE_INVALID_ID,
      'Entry ids must match /^[A-Za-z0-9_-]{1,128}$/ — no path separators or dots allowed.',
    );
  }
}

/** Result of a batch unlink operation. */
export interface BatchUnlinkResult {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Create a file I/O helper bound to a specific directory.
 */
export function createFileIO(config: { directory: string; indexFile?: string }): {
  ensureDir: () => Promise<void>;
  entryPath: (id: string) => string;
  readIndex: () => Promise<Index>;
  writeIndex: (index: Index) => Promise<void>;
  readEntry: (id: string) => Promise<MemoryEntry | null>;
  writeEntry: (entry: MemoryEntry) => Promise<void>;
  batchRead: (files: string[], batchSize?: number) => Promise<MemoryEntry[]>;
  batchUnlink: (paths: string[], batchSize?: number) => Promise<BatchUnlinkResult>;
  listEntryFiles: () => Promise<string[]>;
  readonly indexFileName: string;
} {
  const dir = config.directory;
  const indexFileName = config.indexFile ?? '_index.json';
  const indexPath = join(dir, indexFileName);
  // Pre-compute the resolved directory + separator so the containment check
  // below is a cheap string prefix test instead of an allocation per call.
  const resolvedDirPrefix = resolve(dir) + sep;

  /**
   * Post-join containment check. Even though `validateEntryId` already rejects
   * anything suspicious, we still verify the *resolved* path stays inside the
   * configured directory — a belt-and-braces guard in case the regex or
   * normalisation rules ever drift (e.g., future Unicode support).
   */
  function assertWithinDir(candidate: string): void {
    const absolute = resolve(candidate);
    if (!absolute.startsWith(resolvedDirPrefix)) {
      throw new HarnessError(
        'memory entry path escapes store directory',
        HarnessErrorCode.CORE_INVALID_ID,
        'Refusing to operate on a path outside the configured directory — refuse and report.',
      );
    }
  }

  /** Ensure the storage directory exists. */
  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /** Get the file path for an entry by ID. Throws on invalid or escaping ids. */
  function entryPath(id: string): string {
    validateEntryId(id);
    const path = join(dir, `${id}.json`);
    assertWithinDir(path);
    return path;
  }

  /** Read the index file. Returns empty index for ENOENT (first run). */
  async function readIndex(): Promise<Index> {
    try {
      const raw = await readFile(indexPath, 'utf-8');
      const parsed = parseJsonSafe(raw);
      if (!parsed.ok) {
        throw new HarnessError(
          `Corrupted memory index at ${indexPath}: ${parsed.error.message}`,
          HarnessErrorCode.MEMORY_CORRUPT,
          'The index file is not valid JSON. Delete it to rebuild from entry files, ' +
            'or restore from backup.',
          parsed.error,
        );
      }
      return validateIndex(parsed.value);
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
    // Validate upstream of the join so invalid ids never reach the filesystem.
    validateEntryId(id);
    try {
      const raw = await readFile(entryPath(id), 'utf-8');
      const parsed = parseJsonSafe(raw);
      if (!parsed.ok) {
        throw new HarnessError(
          `Corrupted memory entry at ${entryPath(id)}: ${parsed.error.message}`,
          HarnessErrorCode.MEMORY_CORRUPT,
          'The entry file is not valid JSON. Delete the file to drop the entry, ' +
            'or restore from backup.',
          parsed.error,
        );
      }
      return validateMemoryEntry(parsed.value, `memory entry ${id}`);
    } catch (err: unknown) {
      // ENOENT means the entry file doesn't exist -- return null
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Re-throw permission errors, disk errors, JSON parse errors, etc.
      throw err;
    }
  }

  /** Write a single entry atomically (write-then-rename). */
  async function writeEntry(entry: MemoryEntry): Promise<void> {
    // Validate before touching disk so tmp files are never created for bad ids.
    validateEntryId(entry.id);
    const path = entryPath(entry.id);
    const tmpPath = path + '.tmp';
    await writeFile(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    await rename(tmpPath, path);
  }

  /**
   * Read entry files in parallel batches to avoid fd exhaustion.
   *
   * Filenames that fail {@link validateEntryId} after stripping the `.json`
   * suffix are silently skipped — the directory could contain stray files
   * dropped out of band, and throwing would poison the whole batch for a
   * single bad filename. Legitimate entries always pass because `writeEntry`
   * rejects bad ids at write time.
   */
  async function batchRead(files: string[], batchSize = 50): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const entries = await Promise.all(
        batch.map(async (file) => {
          const id = basename(file, '.json');
          try {
            validateEntryId(id);
          } catch {
            return null;
          }
          return readEntry(id);
        }),
      );
      results.push(...entries.filter((e): e is MemoryEntry => e !== null));
    }
    return results;
  }

  // BatchUnlinkResult is exported at module level

  /**
   * Delete files in parallel batches to avoid fd exhaustion.
   *
   * Fix 19: Returns a result object with deleted paths and any failures,
   * instead of silently swallowing all errors. Callers can inspect failures
   * and decide how to handle partial deletions.
   */
  async function batchUnlink(paths: string[], batchSize = 50): Promise<BatchUnlinkResult> {
    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(p => unlink(p)));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          deleted.push(batch[j]);
        } else {
          const err = (results[j] as PromiseRejectedResult).reason;
          // ENOENT is expected (file already deleted) -- treat as success
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            deleted.push(batch[j]);
          } else {
            failed.push({ path: batch[j], error: String(err) });
          }
        }
      }
    }
    return { deleted, failed };
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
