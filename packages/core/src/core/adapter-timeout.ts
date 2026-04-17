/**
 * AbortController-chained timeout wrapper for `adapter.chat()`.
 *
 * Extracted from `adapter-caller.ts` so the caller can focus on retry
 * orchestration + circuit-breaker dispatch. Behaviour preserved exactly:
 *
 * - External abort forwards into an internal `AbortController` so the
 *   adapter sees a cancellation.
 * - A `setTimeout` race rejects with `HarnessError(CORE_TIMEOUT)` after
 *   `timeoutMs`. The timer is unref'd when available.
 * - On timeout the orphaned adapter promise is caught and surfaced to the
 *   debug logger (so ops can detect adapters that don't honour abort).
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolSchema } from './types.js';
import { HarnessError, HarnessErrorCode } from './errors.js';

/**
 * Minimal metric counter subset used by this module. Mirrors
 * `MetricCounter` from `observe/metrics-port.ts` without the full
 * import — keeps adapter-timeout dependency-light (no observe import).
 */
export interface AdapterTimeoutMetrics {
  readonly counter: (name: string) => { readonly inc: (n?: number, attrs?: Record<string, unknown>) => void };
}

/** Config for a single timed adapter.chat invocation. */
export interface AdapterTimeoutConfig {
  readonly adapter: AgentAdapter;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly externalSignal: AbortSignal;
  readonly timeoutMs: number;
  readonly logger?: {
    readonly debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Optional metrics port. When set, a counter is incremented each time
   * the orphan-catch fires (i.e. the adapter rejected after the timeout
   * deadline had already resolved the outer promise). The counter name
   * is `harness.adapter.orphan_after_timeout`; the adapter name is an
   * attribute so operators can correlate hangs to a specific provider.
   */
  readonly metrics?: AdapterTimeoutMetrics;
}

/** Result of a successful timed adapter.chat invocation. */
export interface AdapterTimeoutOk {
  readonly message: Message;
  readonly usage: TokenUsage;
}

/**
 * Run `adapter.chat` with a hard wall-clock timeout.
 *
 * - Rejects with `HarnessError(CORE_TIMEOUT)` if the adapter does not
 *   resolve within `timeoutMs`.
 * - Rejects/resolves normally otherwise (the adapter's own error, e.g.
 *   `AbortedError`, is propagated unchanged).
 *
 * The caller is responsible for classifying the rejection into a retry
 * decision; this helper only owns the timeout + abort-chaining bookkeeping.
 *
 * Preserves the orphan-catch-and-log behaviour: when the timeout fires
 * while the adapter's own promise is still in flight, the late rejection
 * would print an UnhandledPromiseRejection in Node. We attach a `.catch`
 * that forwards to `logger.debug` so ops visibility is preserved without
 * crashing the process.
 */
export async function withAdapterTimeout(
  config: AdapterTimeoutConfig,
): Promise<AdapterTimeoutOk> {
  const { adapter, messages, tools, externalSignal, timeoutMs, logger, metrics } = config;

  const internalAbort = new AbortController();
  const forwardAbort = (): void => {
    try {
      internalAbort.abort();
    } catch {
      /* noop: already aborted — second abort is idempotent */
    }
  };
  if (externalSignal.aborted) {
    internalAbort.abort();
  } else {
    externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const chatPromise = adapter.chat({
    messages: messages as Message[],
    signal: internalAbort.signal,
    ...(tools !== undefined && { tools: tools as ToolSchema[] }),
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        internalAbort.abort();
      } catch {
        /* noop: already aborted */
      }
      reject(
        new HarnessError(
          `Adapter chat timed out after ${timeoutMs}ms`,
          HarnessErrorCode.CORE_TIMEOUT,
          'Increase adapterTimeoutMs or investigate provider latency',
        ),
      );
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
  });

  try {
    const response = await Promise.race([chatPromise, timeoutPromise]);
    return { message: response.message, usage: response.usage };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      externalSignal.removeEventListener('abort', forwardAbort);
    } catch {
      /* noop: removeEventListener contract never throws but be defensive */
    }
    // Swallow any rejection from the now-orphaned chatPromise on timeout;
    // without this the Node process prints an UnhandledPromiseRejection
    // when the adapter finally throws its own AbortError after we've
    // already resolved/rejected. Emit a debug log so ops can detect
    // abnormal upstream behaviour (e.g. adapter not honouring abort).
    if (timedOut) {
      chatPromise.catch((err: unknown) => {
        logger?.debug?.('adapter orphan after timeout', {
          error: String(err).slice(0, 200),
          adapter: adapter.name ?? 'unknown',
          timeoutMs,
        });
        try {
          metrics?.counter('harness.adapter.orphan_after_timeout').inc(1, {
            adapter: adapter.name ?? 'unknown',
          });
        } catch {
          /* noop: a metrics backend that throws must never break the orphan-swallow contract */
        }
      });
    }
  }
}
