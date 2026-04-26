/**
 * `createFsCheckpointStorage` — file-system-backed
 * {@link CheckpointStorage} that uses atomic-rename writes for
 * crash-safety, mirrors the index pattern from {@link FsMemoryStore},
 * and composes naturally with {@link createCheckpointManager} now
 * that the storage interface is async.
 *
 * Layout under `dir/`:
 *
 *   - `<id>.json`      — one file per checkpoint (atomic-rename writes)
 *   - `_index.json`    — ordered list of `{ id, timestamp }` entries used
 *                        by `list()` to preserve insertion order without
 *                        scanning every file
 *
 * Crash-recovery contract: a half-written `<id>.json` (process killed
 * mid-write) is invisible because `rename` is atomic. A torn
 * `_index.json` falls back to a directory scan that reconstructs the
 * order from file mtimes — slow, but correct.
 *
 * Closes HARNESS_LOG showcase 03.
 *
 * @module
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Checkpoint, CheckpointStorage } from './types.js';
import { HarnessError, HarnessErrorCode } from '../core/errors.js';

const INDEX_FILENAME = '_index.json';
const FILE_EXT = '.json';

interface IndexEntry {
  readonly id: string;
  readonly timestamp: number;
}

interface IndexFile {
  readonly version: 1;
  readonly entries: readonly IndexEntry[];
}

export interface FsCheckpointStorageConfig {
  /** Directory where checkpoint files are stored. Created if missing. */
  readonly dir: string;
}

/**
 * Build a {@link CheckpointStorage} backed by `config.dir`. Creates the
 * directory eagerly on first write; reads do not require existence.
 */
export function createFsCheckpointStorage(config: FsCheckpointStorageConfig): CheckpointStorage {
  if (typeof config?.dir !== 'string' || config.dir.length === 0) {
    throw new HarnessError(
      'createFsCheckpointStorage: dir must be a non-empty string',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Pass an absolute or cwd-relative path to the checkpoint directory.',
    );
  }
  const dir = path.resolve(config.dir);
  const indexPath = path.join(dir, INDEX_FILENAME);

  // In-process serialisation — concurrent saves on the same storage
  // object never race, so the index file stays consistent. Cross-process
  // safety is provided by the atomic-rename pattern on each individual
  // file but NOT for the shared index — a future iteration could add
  // file-locking; left out today because checkpoints are typically
  // single-writer.
  let writeChain: Promise<void> = Promise.resolve();
  function serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = writeChain.then(work, work);
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async function readIndex(): Promise<IndexEntry[]> {
    try {
      const buf = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(buf) as IndexFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        return parsed.entries.filter(
          (e) => typeof e?.id === 'string' && typeof e?.timestamp === 'number',
        );
      }
      // Torn / unrecognised index — fall back to directory scan.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt index — recover via directory scan.
      }
    }
    return scanDirectory();
  }

  async function scanDirectory(): Promise<IndexEntry[]> {
    try {
      const names = await fs.readdir(dir);
      const out: IndexEntry[] = [];
      for (const n of names) {
        if (n === INDEX_FILENAME || !n.endsWith(FILE_EXT)) continue;
        const full = path.join(dir, n);
        try {
          const stat = await fs.stat(full);
          if (!stat.isFile()) continue;
          out.push({ id: n.slice(0, -FILE_EXT.length), timestamp: stat.mtimeMs });
        } catch {
          /* skip unreadable entries */
        }
      }
      // Order by timestamp ascending so semantics match the in-memory
      // store (insertion order, oldest first).
      out.sort((a, b) => a.timestamp - b.timestamp);
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async function writeIndex(entries: readonly IndexEntry[]): Promise<void> {
    const tmp = path.join(dir, `${INDEX_FILENAME}.${randomUUID()}.tmp`);
    const body = JSON.stringify({ version: 1, entries } satisfies IndexFile);
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, indexPath);
  }

  async function writeCheckpoint(cp: Checkpoint): Promise<void> {
    const tmp = path.join(dir, `${cp.id}.${randomUUID()}.tmp`);
    const final = path.join(dir, `${cp.id}${FILE_EXT}`);
    await fs.writeFile(tmp, JSON.stringify(cp), 'utf8');
    await fs.rename(tmp, final);
  }

  async function readCheckpoint(id: string): Promise<Checkpoint | undefined> {
    try {
      const buf = await fs.readFile(path.join(dir, `${id}${FILE_EXT}`), 'utf8');
      return JSON.parse(buf) as Checkpoint;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  return {
    async save(checkpoint: Checkpoint): Promise<void> {
      await serialise(async () => {
        await ensureDir();
        await writeCheckpoint(checkpoint);
        const entries = await readIndex();
        const next = entries.filter((e) => e.id !== checkpoint.id);
        next.push({ id: checkpoint.id, timestamp: checkpoint.timestamp });
        await writeIndex(next);
      });
    },
    async load(id: string): Promise<Checkpoint | undefined> {
      return readCheckpoint(id);
    },
    async list(): Promise<readonly Checkpoint[]> {
      const entries = await readIndex();
      const out: Checkpoint[] = [];
      for (const e of entries) {
        const cp = await readCheckpoint(e.id);
        if (cp !== undefined) out.push(cp);
      }
      return out;
    },
    async delete(id: string): Promise<boolean> {
      return serialise(async () => {
        const final = path.join(dir, `${id}${FILE_EXT}`);
        try {
          await fs.unlink(final);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw err;
        }
        const entries = await readIndex();
        const next = entries.filter((e) => e.id !== id);
        if (next.length !== entries.length) {
          await writeIndex(next);
        }
        return true;
      });
    },
  };
}
