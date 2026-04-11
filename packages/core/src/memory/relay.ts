/**
 * Cross-context relay for session handoff between agent contexts.
 *
 * @module
 */

import type { RelayState } from './types.js';
import type { MemoryStore } from './store.js';
import { HarnessError } from '../core/errors.js';

/** Interface for cross-context relay operations. */
export interface ContextRelay {
  save(state: RelayState): Promise<void>;
  load(): Promise<RelayState | null>;
  checkpoint(progress: Record<string, unknown>): Promise<void>;
  addArtifact(path: string): Promise<void>;
  /**
   * Save relay state with automatic retry on version conflict errors.
   *
   * Uses exponential backoff between retries.
   *
   * @param state - The relay state to save.
   * @param options - Retry configuration. Defaults: maxRetries=3, backoffMs=100.
   */
  saveWithRetry(state: RelayState, options?: { maxRetries?: number; backoffMs?: number }): Promise<void>;
}

/** Relay state with optimistic concurrency version. */
interface VersionedRelayState extends RelayState {
  _version: number;
}

/**
 * Create a cross-context relay backed by a MemoryStore.
 *
 * **Single-Writer Pattern (Fix 22):** The relay is designed for single-writer
 * scenarios. The currentId cache is invalidated on detected conflicts, but
 * external modifications bypassing the relay may cause stale reads. For
 * multi-writer scenarios, disable caching or use version-aware reads.
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
  /** Fix 23: Optional callback invoked when corrupt data is detected during load. */
  onCorruption?: (id: string, error: Error) => void;
}): ContextRelay {
  const store = config.store;
  const relayKey = config.relayKey ?? '__relay__';
  const onCorruption = config.onCorruption;
  let currentId: string | null = null;
  let lastKnownVersion: number = 0;

  async function findRelay(): Promise<{ id: string; state: RelayState; version: number } | null> {
    if (currentId) {
      const entry = await store.read(currentId);
      if (entry) {
        try {
          const parsed = JSON.parse(entry.content) as VersionedRelayState;
          const version = parsed._version ?? 0;
          const { _version: _v, ...state } = parsed;
          void _v;
          lastKnownVersion = version;
          return { id: entry.id, state: state as RelayState, version };
        } catch (err) {
          if (onCorruption) {
            onCorruption(entry.id, err instanceof Error ? err : new Error(String(err)));
          }
          currentId = null;
          return null;
        }
      }
      // Cache miss: entry was deleted externally. Clear stale cached ID and re-query.
      currentId = null;
    }
    const results = await store.query({ tags: [relayKey], limit: 10 });
    // Look for an entry with our relay key
    for (const entry of results) {
      if (entry.key === relayKey) {
        try {
          const parsed = JSON.parse(entry.content) as VersionedRelayState;
          const version = parsed._version ?? 0;
          const { _version: _v, ...state } = parsed;
          void _v;
          currentId = entry.id;
          lastKnownVersion = version;
          return { id: entry.id, state: state as RelayState, version };
        } catch (err) {
          if (onCorruption) {
            onCorruption(entry.id, err instanceof Error ? err : new Error(String(err)));
          }
          continue;
        }
      }
    }
    return null;
  }

  return {
    async save(state) {
      // Capture the version we last knew about before reading fresh data
      const expectedVersion = lastKnownVersion;
      const existing = await findRelay();
      if (existing) {
        // Optimistic concurrency: if the stored version has changed since our
        // last read, another writer intervened — throw a conflict error.
        if (expectedVersion > 0 && existing.version !== expectedVersion) {
          throw new HarnessError(
            `Relay state conflict: expected version ${expectedVersion} but found ${existing.version}`,
            'RELAY_CONFLICT',
            'Retry the save operation — another write occurred concurrently',
          );
        }
        const newVersion = existing.version + 1;
        const versioned: VersionedRelayState = { ...state, _version: newVersion };
        await store.update(existing.id, { content: JSON.stringify(versioned) });
        lastKnownVersion = newVersion;
      } else {
        const versioned: VersionedRelayState = { ...state, _version: 1 };
        const entry = await store.write({
          key: relayKey,
          content: JSON.stringify(versioned),
          grade: 'critical',
          tags: [relayKey],
        });
        currentId = entry.id;
        lastKnownVersion = 1;
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
        const newVersion = existing.version + 1;
        const versioned: VersionedRelayState = { ...updated, _version: newVersion };
        await store.update(existing.id, { content: JSON.stringify(versioned) });
      } else {
        const state: RelayState = {
          progress,
          artifacts: [],
          checkpoint: `checkpoint_${Date.now()}`,
          timestamp: Date.now(),
        };
        const versioned: VersionedRelayState = { ...state, _version: 1 };
        const entry = await store.write({
          key: relayKey,
          content: JSON.stringify(versioned),
          grade: 'critical',
          tags: [relayKey],
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
        const newVersion = existing.version + 1;
        const versioned: VersionedRelayState = { ...updated, _version: newVersion };
        await store.update(existing.id, { content: JSON.stringify(versioned) });
      } else {
        const state: RelayState = {
          progress: {},
          artifacts: [path],
          checkpoint: `artifact_${Date.now()}`,
          timestamp: Date.now(),
        };
        const versioned: VersionedRelayState = { ...state, _version: 1 };
        const entry = await store.write({
          key: relayKey,
          content: JSON.stringify(versioned),
          grade: 'critical',
          tags: [relayKey],
        });
        currentId = entry.id;
      }
    },

    /**
     * Fix 21: Save relay state with automatic retry on version conflict errors.
     * Uses exponential backoff between retries.
     */
    async saveWithRetry(state, options) {
      const maxRetries = options?.maxRetries ?? 3;
      const backoffMs = options?.backoffMs ?? 100;

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Re-load to get fresh version before each attempt
          if (attempt > 0) {
            await findRelay();
          }
          await this.save(state);
          return;
        } catch (err) {
          lastError = err;
          if (
            err instanceof HarnessError &&
            err.code === 'RELAY_CONFLICT' &&
            attempt < maxRetries
          ) {
            // Exponential backoff: backoffMs * 2^attempt
            const delay = backoffMs * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    },
  };
}
