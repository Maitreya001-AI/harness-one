/**
 * Factory for the delegation-cycle detector and per-source lock pool.
 *
 * Extracted from `orchestrator.ts`. The tracker owns:
 *
 * - `delegationChain`: `Map<sourceAgentId, Set<targetAgentId>>` that
 *   records every edge so a subsequent delegation from `target` back to
 *   `source` can be rejected as a cycle.
 * - A per-source `AsyncLock` pool. The delegate flow does
 *   "inspect chain → await strategy.select → mutate chain"; without a
 *   lock, two concurrent delegations from the same source would both
 *   pass the cycle check and both mutate the chain.
 * - A cumulative size cap: total entries across all inner Sets must
 *   stay below `maxEntries`, otherwise new edges throw
 *   `HarnessErrorCode.ORCH_DELEGATION_LIMIT`.
 *
 * The tracker is state-only; the orchestrator still owns the
 * `strategy.select()` call and event emission.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import { createAsyncLock, type AsyncLock } from '../infra/async-lock.js';

/** Config for {@link createDelegationTracker}. */
export interface DelegationTrackerConfig {
  /**
   * Cap on cumulative entries across every inner Set. When exceeded,
   * `recordEdge` throws `ORCH_DELEGATION_LIMIT`.
   */
  readonly maxEntries: number;
}

/** Return shape of {@link createDelegationTracker}. */
export interface DelegationTracker {
  /**
   * Check whether delegating from `sourceId` to `targetId` would
   * introduce a cycle. Walks the chain from `targetId` looking for
   * `sourceId`. Throws `ORCH_DELEGATION_CYCLE` when a cycle is found.
   */
  readonly assertNoCycle: (sourceId: string, targetId: string) => void;
  /**
   * Record the edge `sourceId → targetId`. Enforces the cumulative
   * size cap; throws `ORCH_DELEGATION_LIMIT` if the cap would be
   * exceeded by this insertion.
   */
  readonly recordEdge: (sourceId: string, targetId: string) => void;
  /** Acquire the per-source lock; callers use `.withLock()` to serialise. */
  readonly getLock: (sourceId: string) => AsyncLock;
  /** Purge every chain and lock associated with `agentId`. */
  readonly removeAgent: (agentId: string) => void;
  /** Wipe all tracked chains + locks. */
  readonly clear: () => void;
}

export function createDelegationTracker(
  config: DelegationTrackerConfig,
): DelegationTracker {
  const { maxEntries } = config;

  const chain = new Map<string, Set<string>>();
  const locks = new Map<string, AsyncLock>();

  function assertNoCycle(sourceId: string, targetId: string): void {
    // BFS from targetId: if it can reach sourceId via previously-recorded
    // edges, adding source→target would close a cycle.
    const visited = new Set<string>();
    const queue = [targetId];
    let queueIdx = 0;
    while (queueIdx < queue.length) {
      const current = queue[queueIdx++] as string;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === sourceId) {
        throw new HarnessError(
          `Delegation cycle detected: ${targetId} is already in the delegation chain of ${sourceId}`,
          HarnessErrorCode.ORCH_DELEGATION_CYCLE,
          'Avoid delegating tasks back to agents that originated the delegation',
        );
      }
      const delegates = chain.get(current);
      if (delegates) {
        for (const d of delegates) {
          if (!visited.has(d)) queue.push(d);
        }
      }
    }
  }

  function recordEdge(sourceId: string, targetId: string): void {
    const existing = chain.get(sourceId);
    const wouldBeNew = existing === undefined || !existing.has(targetId);
    if (wouldBeNew) {
      let totalEntries = 0;
      for (const s of chain.values()) totalEntries += s.size;
      if (totalEntries >= maxEntries) {
        throw new HarnessError(
          `Orchestrator delegation-chain reached the configured cap of ${maxEntries} entries`,
          HarnessErrorCode.ORCH_DELEGATION_LIMIT,
          'Unregister completed agents or raise maxDelegationChainEntries.',
        );
      }
    }
    if (existing === undefined) {
      chain.set(sourceId, new Set([targetId]));
    } else {
      existing.add(targetId);
    }
  }

  function getLock(sourceId: string): AsyncLock {
    let lock = locks.get(sourceId);
    if (!lock) {
      lock = createAsyncLock();
      locks.set(sourceId, lock);
    }
    return lock;
  }

  function removeAgent(agentId: string): void {
    chain.delete(agentId);
    for (const set of chain.values()) set.delete(agentId);
    // Drop the delegation lock for this source agent. Waiters (if any)
    // are implausible since the caller would need to still hold a
    // reference, and the lock is empty once the final critical section
    // returns.
    locks.delete(agentId);
  }

  function clear(): void {
    chain.clear();
    locks.clear();
  }

  return { assertNoCycle, recordEdge, getLock, removeAgent, clear };
}
