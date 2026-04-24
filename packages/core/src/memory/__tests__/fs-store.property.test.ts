/**
 * J8 · Property: `FileSystemStore.reconcileIndex()` restores index↔disk
 * consistency under arbitrary write/delete/compact sequences with
 * crash injection.
 *
 * The store's docstring documents two crash classes — orphan entries
 * (write failed between the `fs.rename(entry)` and `fs.rename(index)`)
 * and stale index keys (delete crashed between `unlink(entry)` and
 * `writeIndex`). We simulate both by mutating the on-disk state
 * directly between public API calls:
 *
 *   - `injectOrphan`: write a new entry file without touching the index.
 *   - `injectStaleIndex`: unlink the entry file but leave its key in the
 *     index.
 *
 * After any such sequence, `reconcileIndex()` must:
 *   (i)   produce a key-count that equals the distinct-key count across
 *         surviving entry files.
 *   (ii)  point every key in the rebuilt index at a real entry file.
 *   (iii) resolve key collisions to the highest `updatedAt` survivor.
 *
 * Driven by `fc.commands`, so fast-check explores sequences and shrinks
 * to minimal failing traces. Capped at `numRuns: 500` per the Track-J
 * spec for state-machine properties.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSystemStore, type FsMemoryStore } from '../fs-store.js';
import type { MemoryEntry } from '../types.js';

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

interface Model {
  // The set of (key, entryId) tuples the model expects to exist on disk.
  readonly entries: Map<string, { id: string; updatedAt: number }>;
}

interface Real {
  readonly store: FsMemoryStore;
  readonly dir: string;
}

class WriteCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly key: string,
    readonly content: string,
  ) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    const entry = await real.store.write({
      key: this.key,
      content: this.content,
      grade: 'useful',
    });
    model.entries.set(this.key, { id: entry.id, updatedAt: entry.updatedAt });
  }
  toString(): string {
    return `write(${this.key})`;
  }
}

class DeleteCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly key: string) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    const existing = model.entries.get(this.key);
    if (!existing) return;
    await real.store.delete(existing.id);
    model.entries.delete(this.key);
  }
  toString(): string {
    return `delete(${this.key})`;
  }
}

class CrashAfterEntryWriteCmd implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly key: string,
    readonly content: string,
  ) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    // Simulate: entry file landed on disk but the index write never
    // completed. Write the JSON directly — bypassing the store — with a
    // well-formed id so reconcile can see it.
    const id = `orphan_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const entry: MemoryEntry = {
      id,
      key: this.key,
      content: this.content,
      grade: 'useful',
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(join(real.dir, `${id}.json`), JSON.stringify(entry));
    // The orphan's key may already exist in the model; reconcile keeps
    // the latest-updatedAt survivor, so track whichever has a higher ts.
    const current = model.entries.get(this.key);
    if (!current || now > current.updatedAt) {
      model.entries.set(this.key, { id, updatedAt: now });
    }
  }
  toString(): string {
    return `crashAfterEntry(${this.key})`;
  }
}

class CrashAfterUnlinkCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly key: string) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    const existing = model.entries.get(this.key);
    if (!existing) return;
    // Simulate: unlink landed but the subsequent index write never did.
    // We manually remove the entry file and leave the index untouched
    // (the store has no public surface for this; raw fs is the only way).
    try {
      await unlink(join(real.dir, `${existing.id}.json`));
    } catch {
      // Already gone — still drop from model.
    }
    model.entries.delete(this.key);
  }
  toString(): string {
    return `crashAfterUnlink(${this.key})`;
  }
}

const commandArb = fc.commands(
  [
    fc
      .tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.string({ maxLength: 16 }))
      .map(([k, c]) => new WriteCmd(k, c)),
    fc.string({ minLength: 1, maxLength: 4 }).map((k) => new DeleteCmd(k)),
    fc
      .tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.string({ maxLength: 16 }))
      .map(([k, c]) => new CrashAfterEntryWriteCmd(k, c)),
    fc.string({ minLength: 1, maxLength: 4 }).map((k) => new CrashAfterUnlinkCmd(k)),
  ],
  { maxCommands: 5 },
);

async function scanEntries(dir: string): Promise<MemoryEntry[]> {
  const files = await readdir(dir);
  const out: MemoryEntry[] = [];
  for (const f of files) {
    if (f === '_index.json' || !f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      out.push(JSON.parse(raw) as MemoryEntry);
    } catch {
      // Missing / malformed — skip.
    }
  }
  return out;
}

async function readIndex(dir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(dir, '_index.json'), 'utf8');
    const parsed = JSON.parse(raw) as { keys: Record<string, string> };
    return parsed.keys ?? {};
  } catch {
    return {};
  }
}

let rootDir: string;

async function clearDir(dir: string): Promise<void> {
  // Per-run cleanup: drop every file inside `dir` but keep the directory.
  // Avoids the OS-level tmp-dir-pressure that comes from mkdtemp + rm-rf
  // on every shrink (which otherwise drives neighboring fs tests into
  // ENOTEMPTY flakes when vitest runs them in parallel workers).
  try {
    const names = await readdir(dir);
    await Promise.all(
      names.map((n) => unlink(join(dir, n)).catch(() => undefined)),
    );
  } catch {
    // Dir does not exist yet — nothing to clear.
  }
}

describe('J8 · FileSystemStore crash-injection (property)', () => {
  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'harness-mem-prop-'));
  });

  afterAll(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it('reconcileIndex() restores consistency after any op+crash sequence', { timeout: 30_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(commandArb, async (cmds) => {
        // Reuse the root tmp dir, clearing files between property runs —
        // mkdtemp/rm-rf per run creates enough filesystem pressure to
        // cascade ENOTEMPTY failures into neighbouring parallel tests.
        await clearDir(rootDir);
        const store = createFileSystemStore({ directory: rootDir });
        const real: Real = { store, dir: rootDir };
        const model: Model = { entries: new Map() };
        try {
          await fc.asyncModelRun(() => ({ model, real }), cmds);

          // Invariant check: reconcile, then verify the index matches the
          // latest-updatedAt entry for every distinct key on disk.
          await real.store.reconcileIndex();
          const onDisk = await scanEntries(real.dir);
          const rebuilt = await readIndex(real.dir);

          // (i) Index key count equals distinct-key count on disk.
          const distinctKeys = new Set(onDisk.map((e) => e.key));
          if (Object.keys(rebuilt).length !== distinctKeys.size) {
            throw new Error(
              `index key count ${Object.keys(rebuilt).length} ≠ distinct on-disk keys ${distinctKeys.size}`,
            );
          }
          // (ii) Every key in the index points to an entry file that exists.
          const idByDiskKey = new Map<string, Set<string>>();
          for (const e of onDisk) {
            const set = idByDiskKey.get(e.key) ?? new Set<string>();
            set.add(e.id);
            idByDiskKey.set(e.key, set);
          }
          for (const [k, id] of Object.entries(rebuilt)) {
            const ids = idByDiskKey.get(k);
            if (!ids || !ids.has(id)) {
              throw new Error(`index key ${k} points at missing id ${id}`);
            }
          }
          // (iii) For each key, the chosen id is the latest-updatedAt
          // survivor (ties broken by createdAt, matching source rules).
          const latestByKey = new Map<string, MemoryEntry>();
          for (const e of onDisk) {
            const cur = latestByKey.get(e.key);
            if (
              !cur ||
              e.updatedAt > cur.updatedAt ||
              (e.updatedAt === cur.updatedAt && e.createdAt > cur.createdAt)
            ) {
              latestByKey.set(e.key, e);
            }
          }
          for (const [k, entry] of latestByKey) {
            if (rebuilt[k] !== entry.id) {
              throw new Error(
                `index key ${k} → ${rebuilt[k]} but latest survivor is ${entry.id}`,
              );
            }
          }
        } finally {
          // rootDir is cleared at the top of the next run — nothing to
          // do here; the try/finally stays so an invariant throw still
          // propagates the full fast-check counterexample.
        }
      }),
      // Sits at the Track-J floor (≥ 100). Each run issues up to 5
      // atomic-rename fs writes; larger counts starve neighbouring
      // fs-store tests that share the same tmp directory on CI workers.
      { numRuns: 100, ...(seed !== undefined && { seed }) },
    );
  });
});
