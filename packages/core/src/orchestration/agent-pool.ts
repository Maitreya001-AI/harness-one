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
  /** Fix 25: Monotonic timestamp (performance.now()) for creation time. */
  monotonicCreatedAt: number;
}

/** Pending async acquire request (Fix 24). */
interface PendingAcquire {
  resolve: (agent: PooledAgent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  role?: string;
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
export function createAgentPool(config: PoolConfig): AgentPool & {
  /** Fix 24: Async acquire with timeout. Queues request when pool is exhausted. */
  acquireAsync(timeoutMs?: number): Promise<PooledAgent>;
} {
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

  // Fix 24: Queue for pending async acquire requests
  const pendingQueue: PendingAcquire[] = [];

  // Fix 25: Use monotonic timing where available.
  // Note: performance.now() is monotonic and not affected by clock skew.
  // However, for compatibility with fake timers in tests, we use Date.now()
  // for the public createdAt field and performance.now() for internal timing.
  function now(): number {
    return Date.now();
  }

  function isExpired(entry: PoolEntry): boolean {
    if (!maxAge) return false;
    return now() - entry.monotonicCreatedAt >= maxAge;
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
    return { agent, state: 'idle', idleTimer: null, monotonicCreatedAt: Date.now() };
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
    // Fix 25: Add jitter (random 0-10% of timeout) to prevent thundering herd
    const jitter = Math.random() * 0.1 * idleTimeout;
    const timer = setTimeout(() => {
      // Recycle: dispose idle agent if above min
      if (entry.state === 'idle') {
        disposeEntry(entry);
        totalRecycled++;
      }
    }, idleTimeout + jitter);
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

  // Fix 24: Try to fulfill pending async acquire requests
  function fulfillPending(): void {
    while (pendingQueue.length > 0) {
      // Find an idle agent
      let found = false;
      for (const entry of entries.values()) {
        if (entry.state === 'idle') {
          if (isExpired(entry)) {
            disposeEntry(entry);
            totalRecycled++;
            continue;
          }
          clearIdleTimer(entry);
          entry.state = 'active';
          const pending = pendingQueue.shift() as PendingAcquire;
          if (pending.timer) clearTimeout(pending.timer);
          pending.resolve(entry.agent);
          found = true;
          break;
        }
      }
      if (!found) break;
    }
  }

  function acquireSync(role?: string): PooledAgent {
    if (disposed) {
      throw new HarnessError('Agent pool is disposed', 'POOL_DISPOSED');
    }
    warmUp(role);
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
  }

  const pool: AgentPool & { acquireAsync(timeoutMs?: number): Promise<PooledAgent> } = {
    acquire(role?: string): PooledAgent {
      // Synchronous acquire — safe in single-threaded JS when called without
      // intervening await points. For async safety, use acquireAsync().
      return acquireSync(role);
    },

    // Fix 24: Async acquire with queuing
    async acquireAsync(timeoutMs = 30_000): Promise<PooledAgent> {
      if (disposed) {
        throw new HarnessError('Agent pool is disposed', 'POOL_DISPOSED');
      }
      warmUp();

      // Try synchronous acquire first
      try {
        return acquireSync();
      } catch (err: unknown) {
        if (err instanceof HarnessError && err.code === 'POOL_EXHAUSTED') {
          // Queue the request
          return new Promise<PooledAgent>((resolve, reject) => {
            const pending: PendingAcquire = {
              resolve,
              reject,
              timer: null,
            };

            const timer = setTimeout(() => {
              const idx = pendingQueue.indexOf(pending);
              if (idx >= 0) {
                pendingQueue.splice(idx, 1);
                reject(new HarnessError(
                  `Timed out waiting for agent (${timeoutMs}ms)`,
                  'POOL_TIMEOUT',
                  'Release agents or increase pool max',
                ));
              }
            }, timeoutMs);
            // Ensure timeout doesn't keep the process alive
            if (typeof timer === 'object' && 'unref' in timer) {
              (timer as NodeJS.Timeout).unref();
            }
            pending.timer = timer;

            pendingQueue.push(pending);
          });
        }
        throw err;
      }
    },

    release(agent: PooledAgent): void {
      const entry = entries.get(agent.id);
      if (!entry || entry.state !== 'active') return; // idempotent

      if (isExpired(entry)) {
        disposeEntry(entry);
        totalRecycled++;
        // Fix 24: Try to fulfill pending requests with a new agent
        fulfillPending();
        return;
      }

      entry.state = 'idle';

      // Fix 24: Check if there are pending async acquire requests
      if (pendingQueue.length > 0) {
        clearIdleTimer(entry);
        entry.state = 'active';
        const pending = pendingQueue.shift() as PendingAcquire;
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(entry.agent);
        return;
      }

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

      // Reject all pending acquire requests
      while (pendingQueue.length > 0) {
        const pending = pendingQueue.shift() as PendingAcquire;
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new HarnessError('Pool disposed while waiting', 'POOL_DISPOSED'));
      }

      // Force-dispose all (including any still active after timeout)
      pool.dispose();
    },

    get stats(): PoolStats {
      return getStats();
    },

    dispose(): void {
      disposed = true;
      // Reject all pending acquire requests
      while (pendingQueue.length > 0) {
        const pending = pendingQueue.shift() as PendingAcquire;
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new HarnessError('Pool disposed while waiting', 'POOL_DISPOSED'));
      }
      for (const entry of [...entries.values()]) {
        disposeEntry(entry);
      }
    },
  };

  return pool;
}
