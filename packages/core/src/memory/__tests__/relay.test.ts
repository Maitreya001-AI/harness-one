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
});
