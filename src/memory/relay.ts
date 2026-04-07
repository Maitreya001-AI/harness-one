/**
 * Cross-context relay for session handoff between agent contexts.
 *
 * @module
 */

import type { RelayState } from './types.js';
import type { MemoryStore } from './store.js';

/** Interface for cross-context relay operations. */
export interface ContextRelay {
  save(state: RelayState): Promise<void>;
  load(): Promise<RelayState | null>;
  checkpoint(progress: Record<string, unknown>): Promise<void>;
  addArtifact(path: string): Promise<void>;
}

/**
 * Create a cross-context relay backed by a MemoryStore.
 *
 * @example
 * ```ts
 * const relay = createRelay({ store: createInMemoryStore() });
 * await relay.save({ progress: { step: 1 }, artifacts: [], checkpoint: 'init', timestamp: Date.now() });
 * const state = await relay.load();
 * ```
 */
export function createRelay(config: {
  store: MemoryStore;
  relayKey?: string;
}): ContextRelay {
  const store = config.store;
  const relayKey = config.relayKey ?? '__relay__';
  let currentId: string | null = null;

  async function findRelay(): Promise<{ id: string; state: RelayState } | null> {
    if (currentId) {
      const entry = await store.read(currentId);
      if (entry) {
        return { id: entry.id, state: JSON.parse(entry.content) as RelayState };
      }
    }
    const results = await store.query({ search: relayKey, limit: 1 });
    // Look for an entry with our relay key
    for (const entry of results) {
      if (entry.key === relayKey) {
        currentId = entry.id;
        return { id: entry.id, state: JSON.parse(entry.content) as RelayState };
      }
    }
    return null;
  }

  return {
    async save(state) {
      const existing = await findRelay();
      if (existing) {
        await store.update(existing.id, { content: JSON.stringify(state) });
      } else {
        const entry = await store.write({
          key: relayKey,
          content: JSON.stringify(state),
          grade: 'critical',
        });
        currentId = entry.id;
      }
    },

    async load() {
      const existing = await findRelay();
      return existing?.state ?? null;
    },

    async checkpoint(progress) {
      const existing = await findRelay();
      if (existing) {
        const updated: RelayState = {
          ...existing.state,
          progress: { ...existing.state.progress, ...progress },
          checkpoint: `checkpoint_${Date.now()}`,
          timestamp: Date.now(),
        };
        await store.update(existing.id, { content: JSON.stringify(updated) });
      } else {
        const state: RelayState = {
          progress,
          artifacts: [],
          checkpoint: `checkpoint_${Date.now()}`,
          timestamp: Date.now(),
        };
        const entry = await store.write({
          key: relayKey,
          content: JSON.stringify(state),
          grade: 'critical',
        });
        currentId = entry.id;
      }
    },

    async addArtifact(path) {
      const existing = await findRelay();
      if (existing) {
        const updated: RelayState = {
          ...existing.state,
          artifacts: [...existing.state.artifacts, path],
          timestamp: Date.now(),
        };
        await store.update(existing.id, { content: JSON.stringify(updated) });
      } else {
        const state: RelayState = {
          progress: {},
          artifacts: [path],
          checkpoint: `artifact_${Date.now()}`,
          timestamp: Date.now(),
        };
        const entry = await store.write({
          key: relayKey,
          content: JSON.stringify(state),
          grade: 'critical',
        });
        currentId = entry.id;
      }
    },
  };
}
