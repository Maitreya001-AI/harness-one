/**
 * Pending-acquire queue choreography for the agent pool.
 *
 * The queue is a shared FIFO on `agent-pool.ts`; when `acquireSync()` fails
 * with `POOL_EXHAUSTED` and there is room under `maxPendingQueueSize`, the
 * acquire request is parked via {@link buildEnqueuePendingAcquire}.
 *
 * The builder wires up:
 *   - a one-shot timeout timer that rejects with `POOL_TIMEOUT`,
 *   - an optional `AbortSignal` listener that rejects with `POOL_ABORTED`,
 *   - a single idempotent `cleanup()` closure that tears down both on
 *     whichever path settles first (timer / abort / release fulfilment /
 *     dispose rejection),
 *   - an optional `pool_acquire_timeout` trace-span event attached just
 *     before the timeout rejection.
 *
 * Extracted from `agent-pool.ts` in Wave-23 so the pool module owns pool
 * lifecycle and the pending-queue module owns request choreography.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from '../core/errors.js';
import type { InstrumentationPort } from '../core/instrumentation-port.js';
import type { Logger } from '../infra/logger.js';
import type { MetricGauge } from '../core/metrics-port.js';
import type { PooledAgent, PoolStats } from './types.js';

/**
 * Pending async-acquire request — identical shape to the private struct
 * in `agent-pool.ts`. Re-declared here so the builder can construct and
 * push onto the shared queue without a cyclic import.
 */
export interface PendingAcquire {
  resolve: (agent: PooledAgent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Idempotent cleanup — detaches timer + abort listener on any settle path. */
  cleanup: () => void;
  role?: string;
}

/** Arguments accepted by the enqueuer returned from {@link buildEnqueuePendingAcquire}. */
export interface EnqueueArgs {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly spanId?: string;
  readonly role?: string;
}

/** Dependencies wired by the owning pool. */
export interface PendingAcquireDeps {
  /** Shared FIFO queue; enqueuer pushes, other call sites read/shift. */
  readonly pendingQueue: PendingAcquire[];
  /** Snapshot accessor for pool activity — used when emitting observability. */
  readonly getStats: () => PoolStats;
  readonly poolId: string;
  readonly logger?: Logger;
  readonly traceManager?: InstrumentationPort;
  /** Gauge updated on every enqueue — `undefined` when no metrics wired. */
  readonly queueDepthGauge?: MetricGauge;
}

/**
 * Build the `enqueuePendingAcquire(args)` function. Callers use the
 * returned function from inside an `acquireAsync()` flow whenever the
 * synchronous acquire path failed with `POOL_EXHAUSTED`.
 */
export function buildEnqueuePendingAcquire(
  deps: PendingAcquireDeps,
): (args: EnqueueArgs) => Promise<PooledAgent> {
  const { pendingQueue, getStats, poolId, logger, traceManager, queueDepthGauge } = deps;

  return function enqueuePendingAcquire(args: EnqueueArgs): Promise<PooledAgent> {
    const { timeoutMs, signal, spanId, role } = args;
    return new Promise<PooledAgent>((resolve, reject) => {
      const pending: PendingAcquire = {
        resolve,
        reject,
        timer: null,
        cleanup: () => { /* overridden below */ },
        ...(role !== undefined && { role }),
      };

      const timer = setTimeout(() => {
        const idx = pendingQueue.indexOf(pending);
        if (idx < 0) return;
        pendingQueue.splice(idx, 1);
        pending.cleanup();
        if (traceManager && spanId) {
          try {
            const snapshotTimeout = getStats();
            traceManager.addSpanEvent(spanId, {
              name: 'pool_acquire_timeout',
              attributes: {
                pool_id: poolId,
                timeout_ms: timeoutMs,
                queue_depth: pendingQueue.length,
                active_agents: snapshotTimeout.active,
              },
            });
          } catch {
            // Trace manager threw — timeout path must not be blocked by
            // observability failures.
          }
        }
        reject(new HarnessError(
          `Timed out waiting for agent (${timeoutMs}ms)`,
          HarnessErrorCode.POOL_TIMEOUT,
          'Release agents or increase pool max',
        ));
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
      pending.timer = timer;

      const onAbort = (): void => {
        const idx = pendingQueue.indexOf(pending);
        if (idx < 0) return;
        pendingQueue.splice(idx, 1);
        pending.cleanup();
        reject(new HarnessError(
          'Acquire aborted',
          HarnessErrorCode.POOL_ABORTED,
          'The AbortSignal fired before an agent became available',
        ));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

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
          // Logger threw — observability must not block settle paths.
        }
      }
      queueDepthGauge?.record(pendingQueue.length, { pool_id: poolId });
    });
  };
}
