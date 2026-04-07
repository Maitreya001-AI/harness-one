import { describe, it, expect, beforeEach } from 'vitest';
import { createRelay } from '../relay.js';
import { createInMemoryStore } from '../store.js';
import type { ContextRelay } from '../relay.js';
import type { MemoryStore } from '../store.js';

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
});
