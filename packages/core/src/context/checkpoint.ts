/**
 * Checkpoint Manager — save and restore conversation state.
 *
 * @module
 */

import type { Message } from '../core/types.js';
import type {
  Checkpoint,
  CheckpointManager,
  CheckpointManagerConfig,
  CheckpointStorage,
} from './types.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { prefixedSecureId } from '../infra/ids.js';

/** Default token heuristic: ~4 characters per token. */
function defaultCountTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

/** Create an in-memory checkpoint storage backed by a Map. */
function createInMemoryStorage(): CheckpointStorage {
  const store = new Map<string, Checkpoint>();
  const order: string[] = [];
  return {
    save(cp) {
      store.set(cp.id, cp);
      order.push(cp.id);
    },
    load(id) {
      return store.get(id);
    },
    list() {
      return order.filter((id) => store.has(id)).map((id) => store.get(id) as Checkpoint);
    },
    delete(id) {
      const had = store.delete(id);
      if (had) {
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);
      }
      return had;
    },
  };
}

/**
 * Create a CheckpointManager instance.
 *
 * @param config - Optional configuration for max checkpoints, token counting, and storage.
 * @returns A new CheckpointManager.
 */
export function createCheckpointManager(
  config?: CheckpointManagerConfig,
): CheckpointManager {
  // use crypto-backed IDs so checkpoint handles cannot be
  // guessed by an attacker who can see timestamps. `prefixedSecureId` uses
  // `crypto.randomBytes` and returns a URL-safe suffix.
  function generateId(): string {
    return prefixedSecureId('cp');
  }
  const maxCheckpoints = config?.maxCheckpoints ?? 5;
  if (maxCheckpoints < 1) {
    throw new HarnessError('maxCheckpoints must be >= 1', HarnessErrorCode.CORE_INVALID_CONFIG, 'Provide a positive integer for maxCheckpoints');
  }
  const countTokens = config?.countTokens ?? defaultCountTokens;
  const storage = config?.storage ?? createInMemoryStorage();

  function autoPrune(): void {
    const list = storage.list();
    if (list.length >= maxCheckpoints) {
      storage.delete(list[0].id);
    }
  }

  return {
    save(
      messages: readonly Message[],
      label?: string,
      metadata?: Record<string, unknown>,
    ): Checkpoint {
      autoPrune();

      const cp: Checkpoint = Object.freeze({
        id: generateId(),
        ...(label !== undefined ? { label } : {}),
        messages: [...messages],
        tokenCount: countTokens(messages),
        timestamp: Date.now(),
        ...(metadata !== undefined
          ? { metadata: Object.freeze({ ...metadata }) }
          : {}),
      });

      storage.save(cp);
      return cp;
    },

    restore(checkpointId: string): readonly Message[] {
      const cp = storage.load(checkpointId);
      if (!cp) {
        throw new HarnessError(
          `Checkpoint not found: ${checkpointId}`,
          HarnessErrorCode.CONTEXT_CHECKPOINT_NOT_FOUND,
          'Check the checkpoint ID and try again.',
        );
      }
      return [...cp.messages];
    },

    list(): readonly Checkpoint[] {
      return storage.list();
    },

    prune(options?: { maxCheckpoints?: number; maxAge?: number }): number {
      let pruned = 0;
      const list = storage.list();

      if (options?.maxAge != null) {
        const cutoff = Date.now() - options.maxAge;
        for (const cp of list) {
          if (cp.timestamp < cutoff) {
            storage.delete(cp.id);
            pruned++;
          }
        }
      }

      if (options?.maxCheckpoints != null) {
        const current = storage.list();
        const excess = current.length - options.maxCheckpoints;
        for (let i = 0; i < excess; i++) {
          storage.delete(current[i].id);
          pruned++;
        }
      }

      return pruned;
    },

    dispose(): void {
      const list = storage.list();
      for (const cp of list) {
        storage.delete(cp.id);
      }
    },
  };
}
