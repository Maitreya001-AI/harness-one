/**
 * In-process AdmissionController — per-tenant token-bucket backpressure.
 *
 * Provides the global/tenant concurrency budget that keeps an upstream 429
 * storm from flooding retries and amplifying load downstream. The controller
 * caps inflight work per tenant using a classic token bucket; callers
 * `acquire()` before issuing a request and `release()` afterwards (or use
 * `withPermit` for the happy path).
 *
 * Design notes:
 * - **In-process only.** Cross-process coordination (Redis-backed
 *   TokenBucket) is explicitly out of scope for this initial pass to
 *   avoid a hard runtime dependency on `@harness-one/redis`. A future
 *   `AdmissionController` implementation MAY wrap a Redis backend; the
 *   interface is the same.
 * - **Fail-closed on acquire timeout.** `acquire({ timeoutMs })` rejects
 *   with `POOL_TIMEOUT` rather than queue indefinitely so callers
 *   observe backpressure instead of starving on hidden queues.
 * - **Abort-aware.** Passing an `AbortSignal` cancels the pending wait
 *   and frees the waiter slot immediately.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode } from './errors-base.js';
import { requirePositiveInt } from './validate.js';

export interface AdmissionControllerConfig {
  /** Maximum simultaneously-inflight requests per tenant. Default 128. */
  readonly maxInflight?: number;
  /** Default acquire-timeout in ms when the caller doesn't pass one. Default 5000. */
  readonly defaultTimeoutMs?: number;
}

export interface AcquireOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AdmissionPermit {
  readonly tenantId: string;
  release(): void;
}

export interface AdmissionController {
  acquire(tenantId: string, options?: AcquireOptions): Promise<AdmissionPermit>;
  withPermit<T>(
    tenantId: string,
    fn: (permit: AdmissionPermit) => Promise<T>,
    options?: AcquireOptions,
  ): Promise<T>;
  /** Current inflight count for a tenant. Zero for unknown tenants. */
  inflight(tenantId: string): number;
  /** Current waiter count for a tenant. Zero for unknown tenants. */
  waiting(tenantId: string): number;
}

export function createAdmissionController(
  config?: AdmissionControllerConfig,
): AdmissionController {
  const maxInflight = config?.maxInflight ?? 128;
  const defaultTimeoutMs = config?.defaultTimeoutMs ?? 5000;
  requirePositiveInt(maxInflight, 'AdmissionController.maxInflight');

  interface TenantState {
    inflight: number;
    readonly queue: Array<() => void>;
  }
  const tenants = new Map<string, TenantState>();

  function getTenant(tenantId: string): TenantState {
    let s = tenants.get(tenantId);
    if (!s) {
      s = { inflight: 0, queue: [] };
      tenants.set(tenantId, s);
    }
    return s;
  }

  function makePermit(tenantId: string, state: TenantState): AdmissionPermit {
    let released = false;
    return {
      tenantId,
      release: () => {
        if (released) return;
        released = true;
        state.inflight--;
        const next = state.queue.shift();
        if (next) next();
      },
    };
  }

  return {
    inflight: (tenantId) => tenants.get(tenantId)?.inflight ?? 0,
    waiting: (tenantId) => tenants.get(tenantId)?.queue.length ?? 0,
    async acquire(tenantId, options) {
      const state = getTenant(tenantId);
      if (state.inflight < maxInflight) {
        state.inflight++;
        return makePermit(tenantId, state);
      }
      return new Promise<AdmissionPermit>((resolve, reject) => {
        const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        /** Prevents double-removal when abort and timeout fire concurrently. */
        let removedFromQueue = false;

        function removeFromQueue(): void {
          if (removedFromQueue) return;
          removedFromQueue = true;
          const idx = state.queue.indexOf(grant);
          if (idx >= 0) state.queue.splice(idx, 1);
        }

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          options?.signal?.removeEventListener('abort', onAbort);
          fn();
        };

        const onAbort = (): void => {
          removeFromQueue();
          settle(() =>
            reject(
              new HarnessError(
                `AdmissionController.acquire aborted for tenant "${tenantId}"`,
                HarnessErrorCode.CORE_ABORTED,
                'Caller aborted before a permit became available',
              ),
            ),
          );
        };

        const grant = (): void => {
          state.inflight++;
          settle(() => resolve(makePermit(tenantId, state)));
        };

        if (options?.signal?.aborted) {
          onAbort();
          return;
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true });

        if (timeoutMs !== undefined && timeoutMs >= 0) {
          timer = setTimeout(() => {
            removeFromQueue();
            settle(() =>
              reject(
                new HarnessError(
                  `AdmissionController.acquire timed out after ${timeoutMs}ms for tenant "${tenantId}" (inflight=${state.inflight}/${maxInflight}, waiting=${state.queue.length})`,
                  HarnessErrorCode.POOL_TIMEOUT,
                  'Reduce concurrency, raise maxInflight, or back off the upstream caller',
                ),
              ),
            );
          }, timeoutMs);
          timer.unref?.();
        }

        state.queue.push(grant);
      });
    },
    async withPermit(tenantId, fn, options) {
      const permit = await this.acquire(tenantId, options);
      try {
        return await fn(permit);
      } finally {
        permit.release();
      }
    },
  };
}
