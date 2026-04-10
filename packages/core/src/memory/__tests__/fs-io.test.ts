import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createFileIO } from '../fs-io.js';
import type { MemoryEntry } from '../types.js';

describe('createFileIO', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-fsio-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('ensureDir', () => {
    it('creates directory if it does not exist', async () => {
      const nested = join(dir, 'deep', 'nested');
      const io = createFileIO({ directory: nested });
      await io.ensureDir();
      expect(existsSync(nested)).toBe(true);
    });

    it('does not throw if directory already exists', async () => {
      const io = createFileIO({ directory: dir });
      await io.ensureDir();
      await io.ensureDir(); // should not throw
    });
  });

  describe('entryPath', () => {
    it('returns the correct path for an entry ID', () => {
      const io = createFileIO({ directory: '/tmp/test' });
      expect(io.entryPath('mem_123')).toBe('/tmp/test/mem_123.json');
    });
  });

  describe('readIndex / writeIndex', () => {
    it('returns empty index when no index file exists', async () => {
      const io = createFileIO({ directory: dir });
      const index = await io.readIndex();
      expect(index).toEqual({ keys: {} });
    });

    it('writes and reads index atomically', async () => {
      const io = createFileIO({ directory: dir });
      await io.writeIndex({ keys: { k1: 'id1', k2: 'id2' } });
      const index = await io.readIndex();
      expect(index.keys.k1).toBe('id1');
      expect(index.keys.k2).toBe('id2');
    });

    it('does not leave tmp files after write', async () => {
      const io = createFileIO({ directory: dir });
      await io.writeIndex({ keys: { k1: 'id1' } });
      expect(existsSync(join(dir, '_index.json.tmp'))).toBe(false);
      expect(existsSync(join(dir, '_index.json'))).toBe(true);
    });

    it('throws on corrupted JSON index (non-ENOENT error)', async () => {
      const io = createFileIO({ directory: dir });
      await writeFile(join(dir, '_index.json'), 'NOT VALID JSON{{{', 'utf-8');
      await expect(io.readIndex()).rejects.toThrow();
    });

    it('uses custom index file name', async () => {
      const io = createFileIO({ directory: dir, indexFile: 'custom-index.json' });
      await io.writeIndex({ keys: { k1: 'id1' } });
      expect(existsSync(join(dir, 'custom-index.json'))).toBe(true);
      const index = await io.readIndex();
      expect(index.keys.k1).toBe('id1');
    });
  });

  describe('readEntry / writeEntry', () => {
    it('returns null for missing entry (ENOENT)', async () => {
      const io = createFileIO({ directory: dir });
      const entry = await io.readEntry('nonexistent');
      expect(entry).toBeNull();
    });

    it('writes and reads an entry atomically', async () => {
      const io = createFileIO({ directory: dir });
      const entry: MemoryEntry = {
        id: 'test-id',
        key: 'k1',
        content: 'hello world',
        grade: 'useful',
        createdAt: 1000,
        updatedAt: 1000,
      };
      await io.writeEntry(entry);
      const read = await io.readEntry('test-id');
      expect(read).toEqual(entry);
    });

    it('does not leave tmp files after writing entry', async () => {
      const io = createFileIO({ directory: dir });
      const entry: MemoryEntry = {
        id: 'test-id',
        key: 'k1',
        content: 'test',
        grade: 'useful',
        createdAt: 1000,
        updatedAt: 1000,
      };
      await io.writeEntry(entry);
      expect(existsSync(join(dir, 'test-id.json.tmp'))).toBe(false);
      expect(existsSync(join(dir, 'test-id.json'))).toBe(true);
    });

    it('throws on corrupted entry JSON (non-ENOENT error)', async () => {
      const io = createFileIO({ directory: dir });
      await writeFile(join(dir, 'corrupt.json'), 'INVALID{{{', 'utf-8');
      await expect(io.readEntry('corrupt')).rejects.toThrow();
    });
  });

  describe('batchRead — extension stripping safety', () => {
    it('correctly reads files whose IDs contain ".json" substring', async () => {
      // Regression test: old code used .replace('.json', '') which would
      // mangle IDs containing ".json" (e.g., "config.json.backup" -> "config.backup")
      // The fix uses path.basename(file, '.json') which only strips the trailing .json extension.
      const io = createFileIO({ directory: dir });
      const entry: MemoryEntry = {
        id: 'normal-id',
        key: 'k1',
        content: 'test content',
        grade: 'useful',
        createdAt: 1000,
        updatedAt: 1000,
      };
      await io.writeEntry(entry);
      const entries = await io.batchRead(['normal-id.json']);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('normal-id');
    });
  });

  describe('batchRead', () => {
    it('reads multiple entries in batches', async () => {
      const io = createFileIO({ directory: dir });
      for (let i = 0; i < 5; i++) {
        const entry: MemoryEntry = {
          id: `entry-${i}`,
          key: `k${i}`,
          content: `content-${i}`,
          grade: 'useful',
          createdAt: 1000 + i,
          updatedAt: 1000 + i,
        };
        await io.writeEntry(entry);
      }
      const files = Array.from({ length: 5 }, (_, i) => `entry-${i}.json`);
      const entries = await io.batchRead(files);
      expect(entries).toHaveLength(5);
    });

    it('skips missing files gracefully', async () => {
      const io = createFileIO({ directory: dir });
      const entry: MemoryEntry = {
        id: 'exists',
        key: 'k1',
        content: 'test',
        grade: 'useful',
        createdAt: 1000,
        updatedAt: 1000,
      };
      await io.writeEntry(entry);
      const entries = await io.batchRead(['exists.json', 'missing.json']);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('exists');
    });

    it('handles empty file list', async () => {
      const io = createFileIO({ directory: dir });
      const entries = await io.batchRead([]);
      expect(entries).toHaveLength(0);
    });
  });

  describe('batchUnlink', () => {
    it('deletes multiple files in batches', async () => {
      const io = createFileIO({ directory: dir });
      const paths: string[] = [];
      for (let i = 0; i < 3; i++) {
        const entry: MemoryEntry = {
          id: `del-${i}`,
          key: `k${i}`,
          content: `content-${i}`,
          grade: 'useful',
          createdAt: 1000,
          updatedAt: 1000,
        };
        await io.writeEntry(entry);
        paths.push(io.entryPath(`del-${i}`));
      }
      await io.batchUnlink(paths);
      for (const path of paths) {
        expect(existsSync(path)).toBe(false);
      }
    });

    it('ignores missing files (no throw)', async () => {
      const io = createFileIO({ directory: dir });
      await expect(io.batchUnlink(['/tmp/nonexistent-file.json'])).resolves.toBeUndefined();
    });
  });

  describe('listEntryFiles', () => {
    it('lists JSON files excluding index', async () => {
      const io = createFileIO({ directory: dir });
      await io.writeIndex({ keys: {} });
      const entry: MemoryEntry = {
        id: 'test-list',
        key: 'k1',
        content: 'test',
        grade: 'useful',
        createdAt: 1000,
        updatedAt: 1000,
      };
      await io.writeEntry(entry);
      const files = await io.listEntryFiles();
      expect(files).toContain('test-list.json');
      expect(files).not.toContain('_index.json');
    });

    it('returns empty array for non-existent directory', async () => {
      const io = createFileIO({ directory: join(dir, 'nonexistent') });
      const files = await io.listEntryFiles();
      expect(files).toEqual([]);
    });

    it('excludes custom index file name', async () => {
      const io = createFileIO({ directory: dir, indexFile: 'my-idx.json' });
      await writeFile(join(dir, 'my-idx.json'), '{"keys":{}}', 'utf-8');
      await writeFile(join(dir, 'entry.json'), '{}', 'utf-8');
      const files = await io.listEntryFiles();
      expect(files).toContain('entry.json');
      expect(files).not.toContain('my-idx.json');
    });
  });

  describe('indexFileName getter', () => {
    it('returns default index file name', () => {
      const io = createFileIO({ directory: dir });
      expect(io.indexFileName).toBe('_index.json');
    });

    it('returns custom index file name', () => {
      const io = createFileIO({ directory: dir, indexFile: 'custom.json' });
      expect(io.indexFileName).toBe('custom.json');
    });
  });
});
