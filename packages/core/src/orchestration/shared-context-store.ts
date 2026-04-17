/**
 * Factory for {@link SharedContext} — the key-value store used by
 * orchestrators to share state between agents.
 *
 * Extracted from `orchestrator.ts` so the facet is independently
 * testable and the orchestrator body reads as composition rather than
 * 90 lines of inline map bookkeeping. The factory owns:
 *
 * - Prototype-pollution rejection (`__proto__` / `constructor` /
 *   `prototype` forbidden as keys).
 * - Unicode-normalised keys (NFKC + casefold via
 *   `normalizeContextKey`) so `'ADMIN.tools'` and `'ＡＤＭＩＮ.tools'`
 *   collide intentionally.
 * - Size cap (`maxEntries`) enforced on *new* insertions only;
 *   overwrites never count against the cap.
 * - Prefix-batch delete + wholesale clear, so long-running consumers
 *   can reclaim a namespace (`'user:42:*'`) without walking the map.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import type { OrchestratorEvent, SharedContext } from './types.js';

/**
 * Keys that would bypass own-property checks via prototype pollution if
 * accidentally used as context keys.
 */
export const FORBIDDEN_CONTEXT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Normalize a key (or policy prefix) via NFKC + casefold so that Unicode
 * visual-variant attacks ("ＡＤＭＩＮ." vs "admin.") cannot bypass
 * prefix-based policies.
 *
 * Consumers relying on prefix semantics MUST include the literal
 * separator (e.g. `'admin.'`) — we do not silently add it.
 */
export function normalizeContextKey(key: string): string {
  return key.normalize('NFKC').toLowerCase();
}

/** Config accepted by {@link createSharedContext}. */
export interface SharedContextStoreConfig {
  /**
   * Cap on total entries. New insertions past the cap throw
   * `HarnessErrorCode.ORCH_CONTEXT_LIMIT`. Overwrites never count
   * against the cap.
   */
  readonly maxEntries: number;
  /**
   * Callback invoked after every successful `set()` with a
   * `context_updated` event. Wired by the orchestrator so handlers
   * registered via `onEvent()` see context mutations.
   */
  readonly emit: (event: OrchestratorEvent) => void;
}

/** Shape returned by {@link createSharedContext}. */
export interface SharedContextStore {
  /** The public `SharedContext` view used by orchestrator clients. */
  readonly context: SharedContext;
  /**
   * Clear the underlying store in-place. Used by
   * `orchestrator.dispose()` — `context.clear()` would also work but
   * this form avoids re-emitting `context_updated` events during
   * teardown.
   */
  readonly dispose: () => void;
}

/**
 * Build a {@link SharedContext} + its underlying `Map`. Pure factory:
 * the caller owns event dispatch and only sees the public `context`
 * facet for attaching to the orchestrator surface.
 */
export function createSharedContext(
  config: SharedContextStoreConfig,
): SharedContextStore {
  const { maxEntries, emit } = config;
  const contextStore = new Map<string, unknown>();

  const context: SharedContext = {
    get<T = unknown>(key: string): T | undefined {
      // Normalize key for consistent lookup — ensures 'ADMIN' and 'admin'
      // resolve to the same entry, matching boundary policy normalization.
      return contextStore.get(normalizeContextKey(key)) as T | undefined;
    },

    set(key: string, value: unknown): void {
      if (typeof key !== 'string' || key.length === 0) {
        throw new HarnessError(
          'Invalid context key: keys must be non-empty strings',
          HarnessErrorCode.CORE_INVALID_KEY,
          'Provide a non-empty string key',
        );
      }
      // Normalize before forbidden-key check to catch Unicode variants.
      const normalized = normalizeContextKey(key);
      if (FORBIDDEN_CONTEXT_KEYS.has(normalized)) {
        throw new HarnessError(
          `Invalid context key "${key}": reserved prototype-polluting identifier`,
          HarnessErrorCode.CORE_INVALID_KEY,
          `Avoid keys in {${Array.from(FORBIDDEN_CONTEXT_KEYS).join(', ')}}`,
        );
      }
      // Bound the contextStore size so `sharedContext.set()` cannot grow the
      // map indefinitely in a long-running orchestrator. Overwriting an
      // existing key never counts against the cap.
      if (!contextStore.has(normalized) && contextStore.size >= maxEntries) {
        throw new HarnessError(
          `Orchestrator shared-context reached the configured cap of ${maxEntries} entries`,
          HarnessErrorCode.ORCH_CONTEXT_LIMIT,
          'Call sharedContext.delete() to evict stale keys, or raise maxSharedContextEntries.',
        );
      }
      contextStore.set(normalized, value);
      emit({ type: 'context_updated', key: normalized });
    },

    delete(key: string): boolean {
      return contextStore.delete(normalizeContextKey(key));
    },

    deleteByPrefix(prefix: string): number {
      if (typeof prefix !== 'string' || prefix.length === 0) return 0;
      const normalizedPrefix = normalizeContextKey(prefix);
      // Collect first so we can mutate without invalidating the iterator.
      const toDelete: string[] = [];
      for (const key of contextStore.keys()) {
        if (key.startsWith(normalizedPrefix)) toDelete.push(key);
      }
      let removed = 0;
      for (const key of toDelete) {
        if (contextStore.delete(key)) removed++;
      }
      return removed;
    },

    clear(): number {
      const removed = contextStore.size;
      contextStore.clear();
      return removed;
    },

    entries(): ReadonlyMap<string, unknown> {
      return new Map(contextStore);
    },
  };

  return {
    context,
    dispose(): void {
      contextStore.clear();
    },
  };
}
