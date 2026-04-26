/**
 * Tests for `createFsCheckpointStorage` — fs-backed CheckpointStorage
 * with atomic-rename writes + index file. Closes HARNESS_LOG showcase
 * 03 (`CheckpointManager doesn't natively compose with FsMemoryStore`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFsCheckpointStorage } from '../fs-checkpoint-storage.js';
import { createCheckpointManager } from '../checkpoint.js';
import { HarnessError, HarnessErrorCode } from '../../core/errors.js';
import type { Checkpoint } from '../types.js';
import type { Message } from '../../core/types.js';

const sampleMsg: readonly Message[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];

let dir: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-cp-fs-'));
  dir = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return Object.freeze({
    id: 'cp-1',
    messages: sampleMsg,
    tokenCount: 10,
    timestamp: Date.now(),
    ...overrides,
  });
}

describe('createFsCheckpointStorage — config validation', () => {
  it('throws on empty dir', () => {
    expect(() => createFsCheckpointStorage({ dir: '' })).toThrow(HarnessError);
    try {
      createFsCheckpointStorage({ dir: '' });
    } catch (e) {
      expect((e as HarnessError).code).toBe(HarnessErrorCode.CORE_INVALID_CONFIG);
    }
  });

  it('throws on non-string dir', () => {
    // @ts-expect-error — exercising the runtime input guard for non-string dir
    expect(() => createFsCheckpointStorage({ dir: 123 })).toThrow(HarnessError);
  });
});

describe('createFsCheckpointStorage — basic CRUD', () => {
  it('save then load round-trips a checkpoint', async () => {
    const storage = createFsCheckpointStorage({ dir });
    const cp = makeCheckpoint();
    await storage.save(cp);
    const loaded = await storage.load(cp.id);
    expect(loaded).toEqual(cp);
  });

  it('load returns undefined for missing id', async () => {
    const storage = createFsCheckpointStorage({ dir });
    expect(await storage.load('not-here')).toBeUndefined();
  });

  it('list returns insertion order (oldest first)', async () => {
    const storage = createFsCheckpointStorage({ dir });
    await storage.save(makeCheckpoint({ id: 'a', timestamp: 1 }));
    await storage.save(makeCheckpoint({ id: 'b', timestamp: 2 }));
    await storage.save(makeCheckpoint({ id: 'c', timestamp: 3 }));
    const list = await storage.list();
    expect(list.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('delete removes entry, returns true', async () => {
    const storage = createFsCheckpointStorage({ dir });
    const cp = makeCheckpoint();
    await storage.save(cp);
    expect(await storage.delete(cp.id)).toBe(true);
    expect(await storage.load(cp.id)).toBeUndefined();
  });

  it('delete returns false when entry does not exist', async () => {
    const storage = createFsCheckpointStorage({ dir });
    expect(await storage.delete('phantom')).toBe(false);
  });

  it('list returns [] for an empty / nonexistent dir', async () => {
    const ghost = path.join(dir, 'never-created');
    const storage = createFsCheckpointStorage({ dir: ghost });
    expect(await storage.list()).toEqual([]);
  });
});

describe('createFsCheckpointStorage — atomic-rename safety', () => {
  it('persists data across new storage instances (cold restart)', async () => {
    const storage1 = createFsCheckpointStorage({ dir });
    const cp = makeCheckpoint({ id: 'persistent', timestamp: 999 });
    await storage1.save(cp);

    // Simulate process restart: brand-new storage object on the same dir.
    const storage2 = createFsCheckpointStorage({ dir });
    const list = await storage2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('persistent');
  });

  it('recovers via directory scan when index file is missing', async () => {
    const storage = createFsCheckpointStorage({ dir });
    await storage.save(makeCheckpoint({ id: 'a', timestamp: 1 }));
    await storage.save(makeCheckpoint({ id: 'b', timestamp: 2 }));
    // Wipe the index file
    await fs.unlink(path.join(dir, '_index.json'));
    const fresh = createFsCheckpointStorage({ dir });
    const list = await fresh.list();
    const ids = list.map((c) => c.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('recovers via directory scan when index file is corrupt', async () => {
    const storage = createFsCheckpointStorage({ dir });
    await storage.save(makeCheckpoint({ id: 'a' }));
    await fs.writeFile(path.join(dir, '_index.json'), 'GARBAGE NOT JSON', 'utf8');
    const fresh = createFsCheckpointStorage({ dir });
    const list = await fresh.list();
    expect(list.map((c) => c.id)).toContain('a');
  });
});

describe('createFsCheckpointStorage + createCheckpointManager composition', () => {
  it('manager.save → storage.save → manager.list reflects the entry', async () => {
    const storage = createFsCheckpointStorage({ dir });
    const mgr = createCheckpointManager({ storage });
    const cp = await mgr.save(sampleMsg, 'first');
    const list = await mgr.list();
    expect(list.map((c) => c.id)).toContain(cp.id);
  });

  it('manager auto-prune evicts the oldest entry across processes', async () => {
    const storage1 = createFsCheckpointStorage({ dir });
    const mgr1 = createCheckpointManager({ storage: storage1, maxCheckpoints: 2 });
    const a = await mgr1.save(sampleMsg, 'a');
    await mgr1.save(sampleMsg, 'b');
    await mgr1.save(sampleMsg, 'c');

    // New process: read from same fs storage. `a` should be gone.
    const storage2 = createFsCheckpointStorage({ dir });
    const list = await storage2.list();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === a.id)).toBeUndefined();
    expect(list.map((c) => c.label)).toEqual(['b', 'c']);
  });

  it('manager.restore returns the persisted messages', async () => {
    const storage = createFsCheckpointStorage({ dir });
    const mgr = createCheckpointManager({ storage });
    const cp = await mgr.save(sampleMsg);
    const restored = await mgr.restore(cp.id);
    expect(restored).toEqual(sampleMsg);
  });
});

describe('createFsCheckpointStorage — non-ENOENT errors propagate', () => {
  // Windows ignores POSIX modes — chmod won't deny read on win32, so
  // these branches are only reachable on Linux + macOS CI runners.
  it.skipIf(process.platform === 'win32')(
    'list() rethrows when scanDirectory hits a non-ENOENT error (e.g. EACCES)',
    async () => {
      const storage = createFsCheckpointStorage({ dir });
      await storage.save(makeCheckpoint({ id: 'a' }));
      await fs.chmod(dir, 0o000);
      try {
        const fresh = createFsCheckpointStorage({ dir });
        await expect(fresh.list()).rejects.toBeDefined();
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'load() rethrows non-ENOENT errors (e.g. EACCES)',
    async () => {
      const storage = createFsCheckpointStorage({ dir });
      const cp = makeCheckpoint({ id: 'guarded' });
      await storage.save(cp);
      const file = path.join(dir, 'guarded.json');
      await fs.chmod(file, 0o000);
      try {
        await expect(storage.load(cp.id)).rejects.toBeDefined();
      } finally {
        await fs.chmod(file, 0o644).catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'delete() rethrows non-ENOENT errors from unlink (e.g. EPERM)',
    async () => {
      const storage = createFsCheckpointStorage({ dir });
      const cp = makeCheckpoint({ id: 'sticky' });
      await storage.save(cp);
      // Make the parent dir non-writable so unlink fails with EACCES.
      await fs.chmod(dir, 0o500); // r-x — listable but not writable
      try {
        await expect(storage.delete(cp.id)).rejects.toBeDefined();
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
      }
    },
  );
});

describe('createFsCheckpointStorage — concurrent writes serialised in-process', () => {
  it('parallel saves on the same instance produce a consistent index', async () => {
    const storage = createFsCheckpointStorage({ dir });
    const writes = Array.from({ length: 10 }, (_, i) =>
      storage.save(makeCheckpoint({ id: `cp-${i}`, timestamp: 1000 + i })),
    );
    await Promise.all(writes);
    const list = await storage.list();
    // All 10 must be present, ordered by timestamp.
    expect(list).toHaveLength(10);
    const ids = list.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
});
