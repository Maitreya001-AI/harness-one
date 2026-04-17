/**
 * Agent pool — manages a reusable pool of AgentLoop instances.
 *
 * @module
 */

import type { AgentLoop } from '../core/agent-loop.js';
import { HarnessError, HarnessErrorCode} from '../core/errors.js';
import { prefixedSecureId } from '../infra/ids.js';
import { computeJitterMs } from '../infra/backoff.js';
import type { Logger } from '../infra/logger.js';
import type { MetricsPort } from '../observe/metrics-port.js';
import type { TraceManager } from '../observe/trace-manager.js';
import type { AgentPool, PoolConfig, PooledAgent, PoolStats } from './types.js';

/**
 * Optional observability wiring for the agent pool. These fields are additive
 * to {@link PoolConfig} — when absent, the pool behaves exactly as before
 * (no-op logger/metrics calls). The fields live on the factory config
 * parameter (widened via intersection type on {@link createAgentPool}) so we
 * don't need to modify the closed {@link PoolConfig} surface in `types.ts`.
 */
export interface AgentPoolObservabilityConfig {
  /**
   * Structured logger for queue-depth / resize / dispose signals. When
   * omitted, corresponding log lines are skipped entirely (no allocation).
   */
  readonly logger?: Logger;
  /**
   * MetricsPort for pool gauges and counters:
   *  - `harness.pool.queue_depth` (gauge) — emitted on every `acquireAsync()`.
   *  - `harness.pool.queue_full` (counter) — incremented per
   *    POOL_QUEUE_FULL throw.
   *  - `harness.pool.size` (gauge) — emitted on every `resize()`.
   *  - `harness.pool.dispose_errors` (counter) — incremented per underlying
   *    `loop.dispose()` rejection.
   */
  readonly metrics?: MetricsPort;
  /**
   * Optional trace manager. When provided together with
   * `acquireAsync({ spanId })`, a `pool_acquire_timeout` span event is
   * attached before the POOL_TIMEOUT rejection, carrying queue depth and
   * active-agent counts for observability.
   */
  readonly traceManager?: TraceManager;
  /**
   * Pool identifier surfaced as the `pool_id` log attribute and metric label.
   * Helpful when multiple pools share a single logger/metrics backend.
   * Defaults to `'default'`.
   */
  readonly poolId?: string;
}

interface PoolEntry {
  agent: PooledAgent;
  state: 'idle' | 'active';
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Monotonic timestamp (performance.now()) for creation time. */
  monotonicCreatedAt: number;
}

/** Pending async acquire request. */
interface PendingAcquire {
  resolve: (agent: PooledAgent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Cleanup function invoked when the request is settled (resolved, rejected,
   * timed out, or aborted). Used to detach the AbortSignal listener.
   */
  cleanup: () => void;
  role?: string;
}

/**
 * Options for `acquireAsync`. Accepts a number for backwards compatibility
 * (previous signature was `acquireAsync(timeoutMs)`).
 */
export interface AcquireAsyncOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly role?: string;
  /**
   * Optional span id to attach a `pool_acquire_timeout` event to before
   * rejecting with POOL_TIMEOUT. Only consulted when the pool was configured
   * with a `traceManager`; otherwise silently ignored.
   */
  readonly spanId?: string;
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
export function createAgentPool(
  config: PoolConfig & AgentPoolObservabilityConfig,
): AgentPool & {
  /**
   * Async acquire with optional timeout and AbortSignal. Queues the request
   * when the pool is exhausted. On abort, the pending entry is removed from
   * the queue and the promise rejects with `POOL_ABORTED`.
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
  // Cap pending-queue depth to prevent unbounded memory growth under
  // sustained acquire bursts. Default 1000; `<= 0` disables queuing entirely.
  const maxPendingQueueSize = config.maxPendingQueueSize ?? 1000;

  // Optional observability wiring.
  const logger: Logger | undefined = config.logger;
  const metrics: MetricsPort | undefined = config.metrics;
  const traceManager: TraceManager | undefined = config.traceManager;
  const poolId: string = config.poolId ?? 'default';

  // Lazy instrument handles — only materialised when a MetricsPort is wired.
  // We cache the returned instrument references in case backends reuse them.
  const queueDepthGauge = metrics?.gauge('harness.pool.queue_depth', {
    description: 'Current pending-queue depth of an agent pool',
    unit: '1',
  });
  const queueFullCounter = metrics?.counter('harness.pool.queue_full', {
    description: 'Count of POOL_QUEUE_FULL rejections',
  });
  const sizeGauge = metrics?.gauge('harness.pool.size', {
    description: 'Current total agent count after resize',
    unit: '1',
  });
  const disposeErrorCounter = metrics?.counter('harness.pool.dispose_errors', {
    description: 'Count of underlying AgentLoop.dispose() rejections',
  });

  const entries = new Map<string, PoolEntry>();
  let disposed = false;
  /**
   * Idempotent-dispose latch. Serializes concurrent `dispose()` calls onto
   * the same promise so callers all observe the same completion and teardown
   * never runs twice.
   */
  let disposePromise: Promise<void> | null = null;
  let warmedUp = false;
  let totalCreated = 0;
  let totalRecycled = 0;
  /** Counter for dispose errors silently dropped during teardown. */
  let totalDisposeErrors = 0;

  // Queue for pending async acquire requests
  const pendingQueue: PendingAcquire[] = [];

  // Use monotonic timing (performance.now()) for internal expiry
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
    // Use cryptographically secure IDs for pool agents to prevent enumeration
    // in multi-tenant deployments.
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
   * Await the underlying loop's dispose so pending file/socket handles close
   * before we walk away. `AgentLoop.dispose()` is synchronous today; awaiting
   * `Promise.resolve(result)` keeps the call site future-proof for adapters
   * that may return a promise.
   */
  /**
   * Best-effort redaction of a thrown dispose error for logging. Avoids
   * leaking full stack traces through the logger boundary while still
   * surfacing enough for operators to correlate with traces.
   */
  function sanitizeDisposeError(err: unknown): Readonly<Record<string, unknown>> {
    if (err instanceof Error) {
      return { name: err.name, message: err.message };
    }
    return { value: String(err) };
  }

  function reportDisposeError(err: unknown): void {
    totalDisposeErrors++;
    // Log + counter on every dispose failure.
    if (logger) {
      try {
        logger.warn('agent dispose failed', {
          pool_id: poolId,
          error: sanitizeDisposeError(err),
          total_errors: totalDisposeErrors,
        });
      } catch {
        // Logger itself threw — nothing more we can do.
      }
    }
    disposeErrorCounter?.add(1, { pool_id: poolId });
  }

  async function disposeEntry(entry: PoolEntry): Promise<void> {
    clearIdleTimer(entry);
    try {
      const result = entry.agent.loop.dispose?.();
      if (result !== undefined) {
        await Promise.resolve(result as unknown as Promise<void>);
      }
    } catch (err) {
      // Individual agent dispose errors should not abort the pool teardown —
      // tracked via totalDisposeErrors for observability.
      reportDisposeError(err);
    }
    entries.delete(entry.agent.id);
  }

  /**
   * Fire-and-forget variant for call sites that cannot easily go async
   * (idle-timer expiry, resize(), release()). Errors are tracked via
   * totalDisposeErrors for observability.
   */
  function disposeEntrySync(entry: PoolEntry): void {
    clearIdleTimer(entry);
    try {
      const result = entry.agent.loop.dispose?.() as unknown;
      if (result && typeof (result as { catch?: unknown }).catch === 'function') {
        (result as Promise<void>).catch((err) => { reportDisposeError(err); });
      }
    } catch (err) {
      reportDisposeError(err);
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
    // Add jitter (0–10% of timeout) to prevent thundering herd. Delegates to
    // the shared jitter utility for consistency and testability. Clamp jitter
    // to `idleTimeout * 0.1` — defensive against a custom random source
    // returning >=1 or rounding oddities that could push a jittered timer
    // well past the intended 10% ceiling.
    const jitter = Math.min(computeJitterMs(idleTimeout, 0.1), Math.floor(idleTimeout * 0.1));
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

  // Try to fulfill pending async acquire requests
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

    // Async acquire with queuing, timeout, and abort support
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

      // If the signal is already aborted, fail fast without queuing.
      if (signal?.aborted) {
        throw new HarnessError('Acquire aborted', HarnessErrorCode.POOL_ABORTED, 'The AbortSignal was already aborted when acquireAsync was called');
      }

      // Try synchronous acquire first
      try {
        return acquireSync(opts.role);
      } catch (err: unknown) {
        if (err instanceof HarnessError && err.code === HarnessErrorCode.POOL_EXHAUSTED) {
          // Reject fast when the pending queue is at capacity instead of
          // growing the queue unboundedly. Includes current/max in the error
          // context bag so ops can tune `maxPendingQueueSize`.
          if (pendingQueue.length >= maxPendingQueueSize) {
            // Warn + counter BEFORE throwing so operators see the saturation
            // event even if the caller doesn't surface the thrown
            // HarnessError. Emits structured context keys aligned with the
            // other pool log lines (pool_id, pending_queue_depth, active,
            // idle) so downstream alerts can filter cleanly.
            const snapshotFull = getStats();
            if (logger) {
              try {
                logger.warn('pool acquire queue full', {
                  pool_id: poolId,
                  pending_queue_depth: pendingQueue.length,
                  max_pending_queue_size: maxPendingQueueSize,
                  active: snapshotFull.active,
                  idle: snapshotFull.idle,
                });
              } catch {
                // Logger threw — fall through to the HarnessError path.
              }
            }
            queueFullCounter?.add(1, { pool_id: poolId });
            throw new HarnessError(
              `Agent pool pending-queue full (${pendingQueue.length}/${maxPendingQueueSize})`,
              HarnessErrorCode.POOL_QUEUE_FULL,
              'Increase maxPendingQueueSize, raise pool max, or shed load upstream',
              undefined,
              { current: pendingQueue.length, max: maxPendingQueueSize },
            );
          }
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
                // Attach a span event with queue-depth and active-agent
                // counts BEFORE the rejection so tracing backends can tie
                // the timeout to the pool saturation state at the moment of
                // failure. Skipped silently when either the trace manager or
                // span id is absent.
                if (traceManager && opts.spanId) {
                  try {
                    const snapshotTimeout = getStats();
                    traceManager.addSpanEvent(opts.spanId, {
                      name: 'pool_acquire_timeout',
                      attributes: {
                        pool_id: poolId,
                        timeout_ms: timeoutMs,
                        queue_depth: pendingQueue.length,
                        active_agents: snapshotTimeout.active,
                      },
                    });
                  } catch {
                    // Trace manager threw (e.g. dead span) — timeout path
                    // must not be blocked by observability failures.
                  }
                }
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

            // Abort listener — remove from queue and reject.
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

            // Surface queue depth + active/idle snapshot for observability.
            // Debug level keeps noise low for healthy pools while still
            // making saturation traceable in debug builds. Gauge is always
            // emitted because metrics backends filter/aggregate themselves.
            const snapshotQueued = getStats();
            if (logger) {
              try {
                logger.debug('pool acquire queued', {
                  pool_id: poolId,
                  pending_queue_depth: pendingQueue.length,
                  active: snapshotQueued.active,
                  idle: snapshotQueued.idle,
                });
              } catch {
                // Logger threw — swallow; the resolve/reject path must not
                // be blocked by observability failures.
              }
            }
            queueDepthGauge?.record(pendingQueue.length, { pool_id: poolId });
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
        // Try to fulfill pending requests with a new agent
        fulfillPending();
        return;
      }

      entry.state = 'idle';

      // Check if there are pending async acquire requests
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

      // Structured log + gauge on entry to make autoscaling visible. The log
      // carries the from/to values and a snapshot of active/idle so operators
      // can diagnose why a resize succeeded or was bounded by `max`. The
      // gauge records the final total once the resize settles (emitted after
      // mutation below).
      if (logger) {
        try {
          logger.info('pool resize', {
            pool_id: poolId,
            from: stats.total,
            to: target,
            active: stats.active,
            idle: stats.idle,
          });
        } catch {
          // Logger threw — resize must proceed regardless.
        }
      }

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

      // Emit the final pool size as a gauge observation so the metrics
      // backend sees both pre- and post-resize values (the pre-value is
      // carried in the `from` log field).
      sizeGauge?.record(entries.size, { pool_id: poolId });
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
      // Cache the latch so concurrent dispose() callers share one teardown.
      // `disposed` flips synchronously so subsequent sync paths
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
