import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCheckpointStore,
  defaultCheckpointDir,
} from '../../src/memory/store.js';
import { compactTaskCheckpoints } from '../../src/memory/compaction.js';

describe('defaultCheckpointDir', () => {
  it('points under the user home', () => {
    const dir = defaultCheckpointDir();
    expect(dir).toContain('.harness-coding');
    expect(dir).toContain('checkpoints');
  });
});

describe('createCheckpointStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-cs-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns a working FsMemoryStore', async () => {
    const store = createCheckpointStore({ directory: dir });
    const written = await store.write({ key: 'k1', content: 'x', grade: 'useful' });
    expect((await store.read(written.id))?.content).toBe('x');
  });
});

describe('compactTaskCheckpoints', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cagent-comp-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('drops entries past maxEntries', async () => {
    const store = createCheckpointStore({ directory: dir });
    for (let i = 0; i < 5; i++) {
      await store.write({
        key: `k${i}`,
        content: 'x',
        // Eviction skips `critical` — use `useful` so the compactor actually
        // trims.
        grade: 'useful',
      });
    }
    const result = await compactTaskCheckpoints(store, { maxEntries: 2 });
    expect(result.remaining).toBeLessThanOrEqual(2);
    expect(result.removed).toBeGreaterThanOrEqual(3);
  });
});
