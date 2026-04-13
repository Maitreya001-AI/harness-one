/**
 * Verifies the fs-store readIndex / readEntry paths throw
 * `STORE_CORRUPTION` when the on-disk file is malformed or shape-invalid.
 * Previously these paths cast the parsed JSON directly, silently admitting
 * bad shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileIO } from '../fs-io.js';
import { HarnessError } from '../../core/errors.js';

describe('fs-io corruption detection', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-fs-io-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readIndex: throws STORE_CORRUPTION on invalid JSON', async () => {
    const io = createFileIO({ directory: dir });
    writeFileSync(join(dir, '_index.json'), '{not json');
    await expect(io.readIndex()).rejects.toMatchObject({
      code: 'STORE_CORRUPTION',
    });
  });

  it('readIndex: throws STORE_CORRUPTION when shape is wrong (missing keys)', async () => {
    const io = createFileIO({ directory: dir });
    writeFileSync(join(dir, '_index.json'), JSON.stringify({ other: 'stuff' }));
    await expect(io.readIndex()).rejects.toBeInstanceOf(HarnessError);
  });

  it('readIndex: throws MEMORY_CORRUPT when keys contains non-string id', async () => {
    // CQ-045: shape-validation path now emits `MEMORY_CORRUPT` to
    // distinguish persisted-shape corruption from other store-level errors.
    const io = createFileIO({ directory: dir });
    writeFileSync(join(dir, '_index.json'), JSON.stringify({ keys: { a: 42 } }));
    await expect(io.readIndex()).rejects.toMatchObject({ code: 'MEMORY_CORRUPT' });
  });

  it('readIndex: returns empty on ENOENT (first run)', async () => {
    const io = createFileIO({ directory: dir });
    expect(await io.readIndex()).toEqual({ keys: {} });
  });

  it('readEntry: throws STORE_CORRUPTION on invalid JSON', async () => {
    const io = createFileIO({ directory: dir });
    writeFileSync(join(dir, 'id1.json'), '{corrupt');
    await expect(io.readEntry('id1')).rejects.toMatchObject({ code: 'STORE_CORRUPTION' });
  });

  it('readEntry: throws MEMORY_CORRUPT on shape mismatch (bad grade)', async () => {
    // CQ-045: shape mismatches now emit `MEMORY_CORRUPT` from the
    // `_schemas.ts` validator.
    const io = createFileIO({ directory: dir });
    writeFileSync(
      join(dir, 'id2.json'),
      JSON.stringify({
        id: 'id2',
        key: 'k',
        content: 'hi',
        grade: 'nonsense',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await expect(io.readEntry('id2')).rejects.toMatchObject({ code: 'MEMORY_CORRUPT' });
  });

  it('readEntry: returns null on ENOENT', async () => {
    const io = createFileIO({ directory: dir });
    expect(await io.readEntry('missing')).toBeNull();
  });

  it('readEntry: round-trips a valid entry written via writeEntry', async () => {
    const io = createFileIO({ directory: dir });
    const entry = {
      id: 'ok',
      key: 'k',
      content: 'hello',
      grade: 'useful' as const,
      createdAt: 10,
      updatedAt: 20,
    };
    await io.writeEntry(entry);
    const read = await io.readEntry('ok');
    expect(read).toEqual(entry);
  });
});
