/**
 * Checkpoint Manager — save and restore conversation state.
 *
 * **Async since 0.3**: see HARNESS_LOG showcase 03
 * (`CheckpointManager doesn't natively compose with FsMemoryStore`).
 * The interface is now `Promise<...>` everywhere so fs-backed and
 * remote backends compose naturally; the in-memory default still
 * resolves synchronously under the hood.
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
    async save(cp) {
      store.set(cp.id, cp);
      order.push(cp.id);
    },
    async load(id) {
      return store.get(id);
    },
    async list() {
      return order.filter((id) => store.has(id)).map((id) => store.get(id) as Checkpoint);
    },
    async delete(id) {
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
  function generateId(): string {
    return prefixedSecureId('cp');
  }
  const maxCheckpoints = config?.maxCheckpoints ?? 5;
  if (maxCheckpoints < 1) {
    throw new HarnessError(
      'maxCheckpoints must be >= 1',
      HarnessErrorCode.CORE_INVALID_CONFIG,
      'Provide a positive integer for maxCheckpoints',
    );
  }
  const countTokens = config?.countTokens ?? defaultCountTokens;
  const storage = config?.storage ?? createInMemoryStorage();

  async function autoPrune(): Promise<void> {
    const list = await storage.list();
    if (list.length >= maxCheckpoints) {
      await storage.delete(list[0].id);
    }
  }

  return {
    async save(
      messages: readonly Message[],
      label?: string,
      metadata?: Record<string, unknown>,
    ): Promise<Checkpoint> {
      await autoPrune();

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

      await storage.save(cp);
      return cp;
    },

    async restore(checkpointId: string): Promise<readonly Message[]> {
      const cp = await storage.load(checkpointId);
      if (!cp) {
        throw new HarnessError(
          `Checkpoint not found: ${checkpointId}`,
          HarnessErrorCode.CONTEXT_CHECKPOINT_NOT_FOUND,
          'Check the checkpoint ID and try again.',
        );
      }
      return [...cp.messages];
    },

    async list(): Promise<readonly Checkpoint[]> {
      return storage.list();
    },

    async prune(options?: { maxCheckpoints?: number; maxAge?: number }): Promise<number> {
      let pruned = 0;
      const list = await storage.list();

      if (options?.maxAge != null) {
        const cutoff = Date.now() - options.maxAge;
        for (const cp of list) {
          if (cp.timestamp < cutoff) {
            await storage.delete(cp.id);
            pruned++;
          }
        }
      }

      if (options?.maxCheckpoints != null) {
        const current = await storage.list();
        const excess = current.length - options.maxCheckpoints;
        for (let i = 0; i < excess; i++) {
          await storage.delete(current[i].id);
          pruned++;
        }
      }

      return pruned;
    },

    async dispose(): Promise<void> {
      const list = await storage.list();
      for (const cp of list) {
        await storage.delete(cp.id);
      }
    },
  };
}
