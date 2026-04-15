/**
 * Cross-context relay for session handoff between agent contexts.
 *
 * @module
 */

import type { RelayState } from './types.js';
import type { MemoryStore } from './store.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { validateRelayState, parseJsonSafe } from './_schemas.js';

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

  /**
   * Parse + validate a relay state blob. Returns null on corruption (either
   * invalid JSON or schema mismatch). Corruption is forwarded to onCorruption
   * if provided — the caller decides whether to log, re-issue, or raise.
   */
  function parseRelayContent(entryId: string, content: string): VersionedRelayState | null {
    const parsed = parseJsonSafe(content);
    if (!parsed.ok) {
      if (onCorruption) onCorruption(entryId, parsed.error);
      return null;
    }
    try {
      const validated = validateRelayState(parsed.value);
      return validated as VersionedRelayState;
    } catch (err) {
      if (onCorruption) onCorruption(entryId, err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  async function findRelay(): Promise<{ id: string; state: RelayState; version: number } | null> {
    if (currentId) {
      const entry = await store.read(currentId);
      if (entry) {
        const parsed = parseRelayContent(entry.id, entry.content);
        if (parsed) {
          const version = parsed._version ?? 0;
          const { _version: _v, ...state } = parsed;
          void _v;
          lastKnownVersion = version;
          return { id: entry.id, state: state as RelayState, version };
        }
        currentId = null;
        return null;
      }
      // Cache miss: entry was deleted externally. Clear stale cached ID and re-query.
      currentId = null;
    }
    const results = await store.query({ tags: [relayKey], limit: 10 });
    // Look for an entry with our relay key
    for (const entry of results) {
      if (entry.key === relayKey) {
        const parsed = parseRelayContent(entry.id, entry.content);
        if (parsed) {
          const version = parsed._version ?? 0;
          const { _version: _v, ...state } = parsed;
          void _v;
          currentId = entry.id;
          lastKnownVersion = version;
          return { id: entry.id, state: state as RelayState, version };
        }
      }
    }
    return null;
  }

  /**
   * CQ-005: Shared optimistic concurrency guard used by all three writers
   * (`save`, `checkpoint`, `addArtifact`). Captures the version we last knew
   * about, reloads the current state, compares versions, and either delegates
   * the full update (update/write) to the caller-provided updater or throws
   * RELAY_CONFLICT. After a successful write `lastKnownVersion` is advanced
   * so subsequent calls also benefit from the guard.
   *
   * The updater receives the current state (or null on first write) and
   * returns the new `RelayState` to persist.
   */
  async function updateWithGuard(
    buildNextState: (current: RelayState | null) => RelayState,
  ): Promise<void> {
    const expectedVersion = lastKnownVersion;
    const existing = await findRelay();
    if (existing) {
      if (expectedVersion > 0 && existing.version !== expectedVersion) {
        throw new HarnessError(
          `Relay state conflict: expected version ${expectedVersion} but found ${existing.version}`,
          HarnessErrorCode.MEMORY_RELAY_CONFLICT,
          'Retry the save operation — another write occurred concurrently',
        );
      }
      const newState = buildNextState(existing.state);
      const newVersion = existing.version + 1;
      const versioned: VersionedRelayState = { ...newState, _version: newVersion };
      await store.update(existing.id, { content: JSON.stringify(versioned) });
      lastKnownVersion = newVersion;
    } else {
      const newState = buildNextState(null);
      const versioned: VersionedRelayState = { ...newState, _version: 1 };
      const entry = await store.write({
        key: relayKey,
        content: JSON.stringify(versioned),
        grade: 'critical',
        tags: [relayKey],
      });
      currentId = entry.id;
      lastKnownVersion = 1;
    }
  }

  return {
    async save(state) {
      await updateWithGuard(() => state);
    },

    async load() {
      const existing = await findRelay();
      return existing?.state ?? null;
    },

    async checkpoint(progress) {
      // CQ-005: routes through updateWithGuard so version conflicts are
      // detected the same way as save(). Previously this path skipped the
      // version check and could silently clobber concurrent writes.
      await updateWithGuard((current) => {
        if (current) {
          return {
            ...current,
            progress: { ...current.progress, ...progress },
            checkpoint: `checkpoint_${Date.now()}`,
            timestamp: Date.now(),
          };
        }
        return {
          progress,
          artifacts: [],
          checkpoint: `checkpoint_${Date.now()}`,
          timestamp: Date.now(),
        };
      });
    },

    async addArtifact(path) {
      // CQ-005: same version-checked path as save() — prevents silent
      // overwrite when multiple writers race on artifact lists.
      await updateWithGuard((current) => {
        if (current) {
          return {
            ...current,
            artifacts: [...current.artifacts, path],
            timestamp: Date.now(),
          };
        }
        return {
          progress: {},
          artifacts: [path],
          checkpoint: `artifact_${Date.now()}`,
          timestamp: Date.now(),
        };
      });
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
            err.code === HarnessErrorCode.MEMORY_RELAY_CONFLICT &&
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
