import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRelay } from '../relay.js';
import { createInMemoryStore } from '../store.js';
import type { ContextRelay } from '../relay.js';
import type { MemoryStore } from '../store.js';
import { HarnessError } from '../../core/errors.js';

describe('createRelay', () => {
  let store: MemoryStore;
  let relay: ContextRelay;

  beforeEach(() => {
    store = createInMemoryStore();
    relay = createRelay({ store });
  });

  describe('save and load', () => {
    it('saves and loads relay state', async () => {
      const state = {
        progress: { step: 1 },
        artifacts: ['file.txt'],
        checkpoint: 'cp1',
        timestamp: Date.now(),
      };
      await relay.save(state);
      const loaded = await relay.load();
      expect(loaded).toEqual(state);
    });

    it('returns null when no state saved', async () => {
      expect(await relay.load()).toBeNull();
    });

    it('overwrites previous state on save', async () => {
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });
      await relay.save({
        progress: { step: 2 },
        artifacts: ['a.txt'],
        checkpoint: 'cp2',
        timestamp: 2000,
      });
      const loaded = await relay.load();
      expect(loaded!.progress).toEqual({ step: 2 });
      expect(loaded!.checkpoint).toBe('cp2');
    });
  });

  describe('checkpoint', () => {
    it('creates state if none exists', async () => {
      await relay.checkpoint({ step: 1 });
      const loaded = await relay.load();
      expect(loaded!.progress).toEqual({ step: 1 });
    });

    it('merges progress into existing state', async () => {
      await relay.save({
        progress: { step: 1, total: 5 },
        artifacts: ['a.txt'],
        checkpoint: 'cp1',
        timestamp: 1000,
      });
      await relay.checkpoint({ step: 2 });
      const loaded = await relay.load();
      expect(loaded!.progress).toEqual({ step: 2, total: 5 });
      expect(loaded!.artifacts).toEqual(['a.txt']);
    });
  });

  describe('addArtifact', () => {
    it('creates state if none exists', async () => {
      await relay.addArtifact('output.json');
      const loaded = await relay.load();
      expect(loaded!.artifacts).toEqual(['output.json']);
    });

    it('appends to existing artifacts', async () => {
      await relay.save({
        progress: {},
        artifacts: ['a.txt'],
        checkpoint: 'cp1',
        timestamp: 1000,
      });
      await relay.addArtifact('b.txt');
      const loaded = await relay.load();
      expect(loaded!.artifacts).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('custom relayKey', () => {
    it('uses custom key', async () => {
      const customRelay = createRelay({ store, relayKey: '__custom__' });
      await customRelay.save({
        progress: { x: 1 },
        artifacts: [],
        checkpoint: 'c1',
        timestamp: 1000,
      });
      const loaded = await customRelay.load();
      expect(loaded!.progress).toEqual({ x: 1 });

      // Default relay should not see this
      expect(await relay.load()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('stale cache invalidation — entry deleted, relay re-queries', async () => {
      // Save initial state
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });
      let loaded = await relay.load();
      expect(loaded).not.toBeNull();

      // Delete the relay entry directly from the store
      const entries = await store.query({});
      for (const entry of entries) {
        if (entry.key === '__relay__') {
          await store.delete(entry.id);
        }
      }

      // Load should return null after external deletion
      loaded = await relay.load();
      expect(loaded).toBeNull();

      // Save again — should create new entry
      await relay.save({
        progress: { step: 99 },
        artifacts: [],
        checkpoint: 'cp99',
        timestamp: 9999,
      });
      loaded = await relay.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.progress.step).toBe(99);
    });

    it('multiple checkpoints accumulate progress', async () => {
      await relay.checkpoint({ step: 1, taskA: 'done' });
      await relay.checkpoint({ step: 2, taskB: 'done' });
      await relay.checkpoint({ step: 3, taskC: 'done' });

      const loaded = await relay.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.progress).toEqual({
        step: 3,
        taskA: 'done',
        taskB: 'done',
        taskC: 'done',
      });
    });

    it('add multiple artifacts accumulates all paths', async () => {
      await relay.addArtifact('file1.txt');
      await relay.addArtifact('file2.txt');
      await relay.addArtifact('file3.txt');

      const loaded = await relay.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.artifacts).toEqual(['file1.txt', 'file2.txt', 'file3.txt']);
    });

    it('checkpoint after addArtifact preserves artifacts', async () => {
      await relay.addArtifact('output.json');
      await relay.checkpoint({ phase: 'complete' });

      const loaded = await relay.load();
      expect(loaded!.artifacts).toEqual(['output.json']);
      expect(loaded!.progress.phase).toBe('complete');
    });
  });

  describe('findRelay query path — relay entry exists but current instance has no cached ID', () => {
    it('finds existing relay entry via store query when no cached ID exists', async () => {
      // Write a relay entry directly to the store with content containing the relayKey
      // so the search filter in findRelay can find it.
      // findRelay does: store.query({ search: relayKey, limit: 1 })
      // then checks entry.key === relayKey in the for loop (lines 48-52).
      const relayKey = '__relay__';
      const state = {
        progress: { written: true },
        artifacts: ['x.txt'],
        checkpoint: 'cp1',
        timestamp: 5000,
      };
      const content = JSON.stringify({ ...state });
      await store.write({
        key: relayKey,
        content,
        grade: 'critical',
        tags: [relayKey],
      });

      // Create a FRESH relay instance with currentId === null.
      // findRelay must fall through to the query path (lines 45-52).
      const freshRelay = createRelay({ store, relayKey });
      const loaded = await freshRelay.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.progress).toEqual({ written: true });
      expect(loaded!.artifacts).toEqual(['x.txt']);
    });

    it('checkpoint via query path when fresh instance finds existing relay', async () => {
      const relayKey = '__relay__';
      const state = {
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      };
      await store.write({
        key: relayKey,
        content: JSON.stringify({ ...state }),
        grade: 'critical',
        tags: [relayKey],
      });

      // Fresh instance checkpoints on top of existing state found via query
      const freshRelay = createRelay({ store, relayKey });
      await freshRelay.checkpoint({ step: 2, extra: 'data' });

      const loaded = await freshRelay.load();
      expect(loaded!.progress).toEqual({ step: 2, extra: 'data' });
    });

    it('addArtifact via query path when fresh instance finds existing relay', async () => {
      const relayKey = '__relay__';
      const state = {
        progress: {},
        artifacts: ['a.txt'],
        checkpoint: 'cp1',
        timestamp: 1000,
      };
      await store.write({
        key: relayKey,
        content: JSON.stringify({ ...state }),
        grade: 'critical',
        tags: [relayKey],
      });

      const freshRelay = createRelay({ store, relayKey });
      await freshRelay.addArtifact('b.txt');

      const loaded = await freshRelay.load();
      expect(loaded!.artifacts).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('corrupted relay data', () => {
    it('returns null when cached relay entry has corrupted JSON', async () => {
      // Write valid state first so the relay caches the ID
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });
      const loaded = await relay.load();
      expect(loaded).not.toBeNull();

      // Corrupt the entry directly in the store
      const entries = await store.query({});
      const relayEntry = entries.find((e) => e.key === '__relay__');
      expect(relayEntry).toBeDefined();
      await store.update(relayEntry!.id, { content: '{invalid json!!!' });

      // Load should return null instead of throwing SyntaxError
      const result = await relay.load();
      expect(result).toBeNull();
    });

    it('returns null when query-path relay entry has corrupted JSON', async () => {
      // Write corrupted content directly to the store
      await store.write({
        key: '__relay__',
        content: 'NOT_VALID_JSON{{{',
        grade: 'critical',
        tags: ['__relay__'],
      });

      // Fresh relay instance — no cached ID, must use query path
      const freshRelay = createRelay({ store, relayKey: '__relay__' });
      const result = await freshRelay.load();
      expect(result).toBeNull();
    });
  });

  describe('H3: stale cache invalidation', () => {
    it('clears cached ID when entry is deleted externally and re-created', async () => {
      // Save state to populate the cache
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });

      // Load to confirm it works
      let loaded = await relay.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.progress.step).toBe(1);

      // Delete the relay entry directly from the store (simulating external deletion)
      const entries = await store.query({});
      for (const entry of entries) {
        if (entry.key === '__relay__') {
          await store.delete(entry.id);
        }
      }

      // Now load should return null since the entry was deleted
      // If cache is stale, it will try to read the old ID, get null,
      // but without the fix, it won't re-query and will return null forever
      // even after new data is saved
      loaded = await relay.load();
      expect(loaded).toBeNull();

      // Save new state - this should work despite the old cached ID being gone
      await relay.save({
        progress: { step: 2 },
        artifacts: [],
        checkpoint: 'cp2',
        timestamp: 2000,
      });

      // Load should find the new state
      loaded = await relay.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.progress.step).toBe(2);
    });
  });

  describe('Fix 4: version-based conflict detection', () => {
    it('save increments version on each update', async () => {
      const state1 = {
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      };
      await relay.save(state1);

      // Read the raw stored content to verify version
      const entries = await store.query({});
      const relayEntry = entries.find(e => e.key === '__relay__');
      expect(relayEntry).toBeDefined();
      const parsed1 = JSON.parse(relayEntry!.content);
      expect(parsed1._version).toBe(1);

      // Save again
      const state2 = { ...state1, progress: { step: 2 }, timestamp: 2000 };
      await relay.save(state2);

      const entries2 = await store.query({});
      const relayEntry2 = entries2.find(e => e.key === '__relay__');
      const parsed2 = JSON.parse(relayEntry2!.content);
      expect(parsed2._version).toBe(2);
    });

    it('load returns state without _version field', async () => {
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });

      const loaded = await relay.load();
      expect(loaded).not.toBeNull();
      // _version should be stripped from the returned state
      expect((loaded as Record<string, unknown>)['_version']).toBeUndefined();
      expect(loaded!.progress).toEqual({ step: 1 });
    });

    it('detects conflict when version has changed between read and write', async () => {
      // Save initial state
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });

      // Create a second relay instance pointing to the same store
      const relay2 = createRelay({ store });

      // Both relays load the current state (both see version 1)
      await relay.load();
      await relay2.load();

      // relay2 saves, bumping version to 2
      await relay2.save({
        progress: { step: 2 },
        artifacts: [],
        checkpoint: 'cp2',
        timestamp: 2000,
      });

      // relay1 tries to save with stale version (expects 1, finds 2)
      await expect(
        relay.save({
          progress: { step: 3 },
          artifacts: [],
          checkpoint: 'cp3',
          timestamp: 3000,
        }),
      ).rejects.toThrow(HarnessError);
    });

    it('conflict error has RELAY_CONFLICT code', async () => {
      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });

      const relay2 = createRelay({ store });
      await relay.load();
      await relay2.load();

      await relay2.save({
        progress: { step: 2 },
        artifacts: [],
        checkpoint: 'cp2',
        timestamp: 2000,
      });

      try {
        await relay.save({
          progress: { step: 3 },
          artifacts: [],
          checkpoint: 'cp3',
          timestamp: 3000,
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HarnessError);
        expect((err as HarnessError).code).toBe('RELAY_CONFLICT');
      }
    });

    it('checkpoint increments version', async () => {
      await relay.checkpoint({ step: 1 });

      const entries = await store.query({});
      const relayEntry = entries.find(e => e.key === '__relay__');
      const parsed = JSON.parse(relayEntry!.content);
      expect(parsed._version).toBe(1);

      await relay.checkpoint({ step: 2 });

      const entries2 = await store.query({});
      const relayEntry2 = entries2.find(e => e.key === '__relay__');
      const parsed2 = JSON.parse(relayEntry2!.content);
      expect(parsed2._version).toBe(2);
    });

    it('addArtifact increments version', async () => {
      await relay.addArtifact('file1.txt');

      const entries = await store.query({});
      const relayEntry = entries.find(e => e.key === '__relay__');
      const parsed = JSON.parse(relayEntry!.content);
      expect(parsed._version).toBe(1);

      await relay.addArtifact('file2.txt');

      const entries2 = await store.query({});
      const relayEntry2 = entries2.find(e => e.key === '__relay__');
      const parsed2 = JSON.parse(relayEntry2!.content);
      expect(parsed2._version).toBe(2);
    });
  });

  describe('Fix 5: corrupted relay entry logging', () => {
    it('logs warning when cached relay entry has corrupted JSON', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await relay.save({
        progress: { step: 1 },
        artifacts: [],
        checkpoint: 'cp1',
        timestamp: 1000,
      });

      // Corrupt the entry
      const entries = await store.query({});
      const relayEntry = entries.find(e => e.key === '__relay__');
      await store.update(relayEntry!.id, { content: '{invalid json!!!' });

      await relay.load();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[harness-one] Corrupted relay entry skipped:'),
      );

      warnSpy.mockRestore();
    });

    it('logs warning when query-path relay entry has corrupted JSON', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Write corrupted content with relay tag so query finds it
      await store.write({
        key: '__relay__',
        content: 'NOT_VALID_JSON{{{',
        grade: 'critical',
        tags: ['__relay__'],
      });

      // Fresh relay instance to force query path (no cached ID)
      const freshRelay = createRelay({ store, relayKey: '__relay__' });
      await freshRelay.load();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[harness-one] Corrupted relay entry skipped:'),
      );

      warnSpy.mockRestore();
    });
  });
});
