/**
 * Agent pool — manages a reusable pool of AgentLoop instances.
 *
 * @module
 */

import type { AgentLoop } from '../core/agent-loop.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { prefixedSecureId } from '../infra/ids.js';
import { computeJitterMs } from '../infra/backoff.js';
import type { AgentPool, PoolConfig, PooledAgent, PoolStats } from './types.js';

interface PoolEntry {
  agent: PooledAgent;
  state: 'idle' | 'active';
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Fix 25: Monotonic timestamp (performance.now()) for creation time. */
  monotonicCreatedAt: number;
}

/** Pending async acquire request (Fix 24 + CQ-017). */
interface PendingAcquire {
  resolve: (agent: PooledAgent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * CQ-017: Cleanup function invoked when the request is settled (resolved,
   * rejected, timed out, or aborted). Used to detach the AbortSignal listener.
   */
  cleanup: () => void;
  role?: string;
}

/**
 * CQ-017: Options for `acquireAsync`. Accepts a number for backwards
 * compatibility (previous signature was `acquireAsync(timeoutMs)`).
 */
export interface AcquireAsyncOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly role?: string;
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
  /**
   * Async acquire with optional timeout and AbortSignal. Queues the request
   * when the pool is exhausted. On abort (CQ-017), the pending entry is
   * removed from the queue and the promise rejects with `POOL_ABORTED`.
   *
   * Backwards compatible: accepts a plain number (legacy `timeoutMs`).
   */
  acquireAsync(optsOrTimeout?: number | AcquireAsyncOptions): Promise<PooledAgent>;
} {
  const factory = config.factory;
  const min = config.min ?? 0;
  const max = config.max ?? 10;
  const idleTimeout = config.idleTimeout ?? 60_000;
  const maxAge = config.maxAge;

  const entries = new Map<string, PoolEntry>();
  let disposed = false;
  /**
   * LM-014: Idempotent-dispose latch. Serializes concurrent `dispose()` calls
   * onto the same promise so callers all observe the same completion and
   * teardown never runs twice.
   */
  let disposePromise: Promise<void> | null = null;
  let warmedUp = false;
  let totalCreated = 0;
  let totalRecycled = 0;
  /** OBS-010: Counter for dispose errors silently dropped during teardown. */
  let totalDisposeErrors = 0;

  // Fix 24: Queue for pending async acquire requests
  const pendingQueue: PendingAcquire[] = [];

  // Fix 25: Use monotonic timing (performance.now()) for internal expiry
  // calculations. Date.now() is only used for the public-facing createdAt
  // field. performance.now() is monotonic and immune to clock skew.
  function now(): number {
    return performance.now();
  }

  function isExpired(entry: PoolEntry): boolean {
    if (!maxAge) return false;
    return now() - entry.monotonicCreatedAt >= maxAge;
  }

  function createEntry(role?: string): PoolEntry {
    const loop: AgentLoop = factory(role);
    // SEC-002: Use cryptographically secure IDs for pool agents to prevent
    // enumeration in multi-tenant deployments.
    const id = prefixedSecureId('pa');
    const agent: PooledAgent = Object.freeze({
      id,
      loop,
      createdAt: Date.now(),
      ...(role !== undefined && { role }),
    });
    totalCreated++;
    return { agent, state: 'idle', idleTimer: null, monotonicCreatedAt: performance.now() };
  }

  /**
   * LM-014: Await the underlying loop's dispose so pending file/socket
   * handles close before we walk away. `AgentLoop.dispose()` is
   * synchronous today; awaiting `Promise.resolve(result)` keeps the call
   * site future-proof for adapters that may return a promise.
   */
  async function disposeEntry(entry: PoolEntry): Promise<void> {
    clearIdleTimer(entry);
    try {
      const result = entry.agent.loop.dispose?.();
      if (result !== undefined) {
        await Promise.resolve(result as unknown as Promise<void>);
      }
    } catch {
      // Individual agent dispose errors should not abort the pool teardown —
      // tracked via totalDisposeErrors for observability (OBS-010).
      totalDisposeErrors++;
    }
    entries.delete(entry.agent.id);
  }

  /**
   * Fire-and-forget variant for call sites that cannot easily go async
   * (idle-timer expiry, resize(), release()). Errors are tracked via
   * totalDisposeErrors for observability (OBS-010).
   */
  function disposeEntrySync(entry: PoolEntry): void {
    clearIdleTimer(entry);
    try {
      const result = entry.agent.loop.dispose?.() as unknown;
      if (result && typeof (result as { catch?: unknown }).catch === 'function') {
        (result as Promise<void>).catch(() => { totalDisposeErrors++; });
      }
    } catch {
      totalDisposeErrors++;
    }
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
    // Fix 25: Add jitter (0–10% of timeout) to prevent thundering herd.
    // Delegates to the shared jitter utility for consistency and testability.
    const jitter = computeJitterMs(idleTimeout, 0.1);
    const timer = setTimeout(() => {
      // Recycle: dispose idle agent if above min
      if (entry.state === 'idle') {
        disposeEntrySync(entry);
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
    return { idle, active, total: entries.size, created: totalCreated, recycled: totalRecycled, disposeErrors: totalDisposeErrors };
  }

  // Fix 24: Try to fulfill pending async acquire requests
  function fulfillPending(): void {
    while (pendingQueue.length > 0) {
      // Find an idle agent
      let found = false;
      for (const entry of entries.values()) {
        if (entry.state === 'idle') {
          if (isExpired(entry)) {
            disposeEntrySync(entry);
            totalRecycled++;
            continue;
          }
          clearIdleTimer(entry);
          entry.state = 'active';
          const pending = pendingQueue.shift() as PendingAcquire;
          pending.cleanup();
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
      throw new HarnessError('Agent pool is disposed', HarnessErrorCode.POOL_DISPOSED);
    }
    warmUp(role);
    for (const entry of entries.values()) {
      if (entry.state === 'idle') {
        if (isExpired(entry)) {
          disposeEntrySync(entry);
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
        HarnessErrorCode.POOL_EXHAUSTED,
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

    // Fix 24 + CQ-017: Async acquire with queuing, timeout, and abort support
    async acquireAsync(optsOrTimeout?: number | AcquireAsyncOptions): Promise<PooledAgent> {
      if (disposed) {
        throw new HarnessError('Agent pool is disposed', HarnessErrorCode.POOL_DISPOSED);
      }
      const opts: AcquireAsyncOptions =
        typeof optsOrTimeout === 'number'
          ? { timeoutMs: optsOrTimeout }
          : (optsOrTimeout ?? {});
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const signal = opts.signal;
      warmUp(opts.role);

      // CQ-017: If the signal is already aborted, fail fast without queuing.
      if (signal?.aborted) {
        throw new HarnessError('Acquire aborted', HarnessErrorCode.POOL_ABORTED, 'The AbortSignal was already aborted when acquireAsync was called');
      }

      // Try synchronous acquire first
      try {
        return acquireSync(opts.role);
      } catch (err: unknown) {
        if (err instanceof HarnessError && err.code === HarnessErrorCode.POOL_EXHAUSTED) {
          // Queue the request
          return new Promise<PooledAgent>((resolve, reject) => {
            // Declared first so `cleanup` can safely reference it before assignment.
            const pending: PendingAcquire = {
              resolve,
              reject,
              timer: null,
              cleanup: () => { /* overridden below */ },
              ...(opts.role !== undefined && { role: opts.role }),
            };

            const timer = setTimeout(() => {
              const idx = pendingQueue.indexOf(pending);
              if (idx >= 0) {
                pendingQueue.splice(idx, 1);
                pending.cleanup();
                reject(new HarnessError(
                  `Timed out waiting for agent (${timeoutMs}ms)`,
                  HarnessErrorCode.POOL_TIMEOUT,
                  'Release agents or increase pool max',
                ));
              }
            }, timeoutMs);
            if (typeof timer === 'object' && 'unref' in timer) {
              (timer as NodeJS.Timeout).unref();
            }
            pending.timer = timer;

            // CQ-017: Abort listener — remove from queue and reject.
            const onAbort = (): void => {
              const idx = pendingQueue.indexOf(pending);
              if (idx >= 0) {
                pendingQueue.splice(idx, 1);
                pending.cleanup();
                reject(new HarnessError(
                  'Acquire aborted',
                  HarnessErrorCode.POOL_ABORTED,
                  'The AbortSignal fired before an agent became available',
                ));
              }
            };
            if (signal) {
              signal.addEventListener('abort', onAbort, { once: true });
            }

            // Single cleanup covers both timer and abort listener — invoked
            // by resolve/reject/timeout/abort paths, whichever happens first.
            pending.cleanup = (): void => {
              if (pending.timer) {
                clearTimeout(pending.timer);
                pending.timer = null;
              }
              if (signal) {
                signal.removeEventListener('abort', onAbort);
              }
            };

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
        disposeEntrySync(entry);
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
        pending.cleanup();
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
            disposeEntrySync(entry);
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
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
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

      // Force-dispose all (including any still active after timeout). The
      // shared `dispose()` latch handles pending-queue rejection and the
      // idempotent `disposed` flag, so drain's responsibilities collapse to
      // awaiting a settle window + delegating.
      await pool.dispose();
    },

    get stats(): PoolStats {
      return getStats();
    },

    async dispose(): Promise<void> {
      // LM-014: Cache the latch so concurrent dispose() callers share one
      // teardown. `disposed` flips synchronously so subsequent sync paths
      // (acquire/release) see the pool as torn down immediately.
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        // Reject all pending acquire requests — do this synchronously before
        // awaiting any loop.dispose() so queued callers unblock immediately.
        while (pendingQueue.length > 0) {
          const pending = pendingQueue.shift() as PendingAcquire;
          pending.cleanup();
          pending.reject(new HarnessError('Pool disposed while waiting', HarnessErrorCode.POOL_DISPOSED));
        }
        // Sequentially await each entry's dispose so file/socket handles on
        // the underlying loop settle before we claim the pool is torn down.
        for (const entry of [...entries.values()]) {
          await disposeEntry(entry);
        }
      })();
      return disposePromise;
    },
  };

  return pool;
}
