/**
 * Agent pool — manages a reusable pool of AgentLoop instances.
 *
 * @module
 */

import type { AgentLoop } from '../core/agent-loop.js';
import { HarnessError } from '../core/errors.js';
import type { AgentPool, PoolConfig, PooledAgent, PoolStats } from './types.js';

interface PoolEntry {
  agent: PooledAgent;
  state: 'idle' | 'active';
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Create a new agent pool.
 *
 * @example
 * ```ts
 * const pool = createAgentPool({ factory: () => new AgentLoop({ adapter }) });
 * const agent = pool.acquire();
 * // ... use agent.loop ...
 * pool.release(agent);
 * ```
 */
export function createAgentPool(config: PoolConfig): AgentPool {
  const factory = config.factory;
  const min = config.min ?? 0;
  const max = config.max ?? 10;
  const idleTimeout = config.idleTimeout ?? 60_000;
  const maxAge = config.maxAge;

  const entries = new Map<string, PoolEntry>();
  let disposed = false;
  let warmedUp = false;
  let totalCreated = 0;
  let totalRecycled = 0;
  let poolAgentCounter = 0;

  function isExpired(entry: PoolEntry): boolean {
    if (!maxAge) return false;
    return Date.now() - entry.agent.createdAt >= maxAge;
  }

  function createEntry(role?: string): PoolEntry {
    const loop: AgentLoop = factory(role);
    const id = `pool-agent-${++poolAgentCounter}`;
    const agent: PooledAgent = Object.freeze({
      id,
      loop,
      createdAt: Date.now(),
      ...(role !== undefined && { role }),
    });
    totalCreated++;
    return { agent, state: 'idle', idleTimer: null };
  }

  function disposeEntry(entry: PoolEntry): void {
    clearIdleTimer(entry);
    entry.agent.loop.dispose();
    entries.delete(entry.agent.id);
  }

  function clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  function startIdleTimer(entry: PoolEntry): void {
    clearIdleTimer(entry);
    const timer = setTimeout(() => {
      // Recycle: dispose idle agent if above min
      if (entry.state === 'idle') {
        disposeEntry(entry);
        totalRecycled++;
      }
    }, idleTimeout);
    timer.unref();
    entry.idleTimer = timer;
  }

  function warmUp(role?: string): void {
    if (warmedUp) return;
    warmedUp = true;
    // Create min agents (one will be acquired by the caller, rest idle)
    while (entries.size < min) {
      const entry = createEntry(role);
      entries.set(entry.agent.id, entry);
      startIdleTimer(entry);
    }
  }

  function getStats(): PoolStats {
    let idle = 0;
    let active = 0;
    for (const entry of entries.values()) {
      if (entry.state === 'idle') idle++;
      else active++;
    }
    return { idle, active, total: entries.size, created: totalCreated, recycled: totalRecycled };
  }

  const pool: AgentPool = {
    acquire(role?: string): PooledAgent {
      if (disposed) {
        throw new HarnessError('Agent pool is disposed', 'POOL_DISPOSED');
      }

      // Lazy warm-up on first acquire
      warmUp(role);

      // Try to find an idle entry (skip expired)
      for (const entry of entries.values()) {
        if (entry.state === 'idle') {
          if (isExpired(entry)) {
            disposeEntry(entry);
            totalRecycled++;
            continue;
          }
          clearIdleTimer(entry);
          entry.state = 'active';
          return entry.agent;
        }
      }

      // No idle agents — create new if under max
      if (entries.size >= max) {
        throw new HarnessError(
          `Agent pool exhausted (max=${max})`,
          'POOL_EXHAUSTED',
          'Release agents or increase pool max',
        );
      }

      const entry = createEntry(role);
      entry.state = 'active';
      entries.set(entry.agent.id, entry);
      return entry.agent;
    },

    release(agent: PooledAgent): void {
      const entry = entries.get(agent.id);
      if (!entry || entry.state !== 'active') return; // idempotent

      if (isExpired(entry)) {
        disposeEntry(entry);
        totalRecycled++;
        return;
      }

      entry.state = 'idle';
      if (disposed) return;
      startIdleTimer(entry);
    },

    resize(target: number): void {
      if (disposed) return;

      // Trim idle agents if over target
      const stats = getStats();
      if (stats.total > target) {
        let toRemove = stats.total - target;
        for (const entry of entries.values()) {
          if (toRemove <= 0) break;
          if (entry.state === 'idle') {
            disposeEntry(entry);
            totalRecycled++;
            toRemove--;
          }
        }
      } else if (stats.total < target) {
        // Pre-warm up to target
        while (entries.size < target && entries.size < max) {
          const entry = createEntry();
          entries.set(entry.agent.id, entry);
          startIdleTimer(entry);
        }
      }
    },

    async drain(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let hasActive = false;
        for (const entry of entries.values()) {
          if (entry.state === 'active') {
            hasActive = true;
            break;
          }
        }
        if (!hasActive) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Force-dispose all (including any still active after timeout)
      pool.dispose();
    },

    get stats(): PoolStats {
      return getStats();
    },

    dispose(): void {
      disposed = true;
      for (const entry of [...entries.values()]) {
        disposeEntry(entry);
      }
    },
  };

  return pool;
}
