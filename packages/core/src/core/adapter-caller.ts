/**
 * Adapter caller — executes one adapter turn (streaming or non-streaming)
 * with retry-with-backoff and returns a unified discriminated result.
 *
 * Owns the full retry-with-backoff loop and branches on the configured
 * `streaming` flag to delegate to either {@link StreamHandler} or
 * `adapter.chat`. `callOnce` is also exported as a thin helper folded into
 * the chat branch.
 *
 * **Error-yielding asymmetry**: StreamHandler yields the `{type:'error'}`
 * event itself on stream failure; AdapterCaller MUST NOT re-yield in that
 * case. On chat failure, AdapterCaller also does NOT yield — the caller
 * (IterationRunner's bailOut) is responsible for yielding the wrapped error
 * event. Net effect: exactly one `{type:'error'}` event per failed adapter
 * turn.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolSchema } from './types.js';
import type { AgentEvent } from './events.js';
import { AbortedError, HarnessError, HarnessErrorCode} from './errors.js';
import { categorizeAdapterError } from './error-classifier.js';
import { type CircuitBreaker, CircuitOpenError } from '../infra/circuit-breaker.js';
import type { StreamHandler } from './stream-handler.js';
import { createRetryPolicy } from './retry-policy.js';
import { withAdapterTimeout } from './adapter-timeout.js';
import { runStreamingAttempt } from './streaming-retry.js';

/** Successful single-attempt adapter call result. */
export interface AdapterCallOnceOk {
  readonly ok: true;
  readonly message: Message;
  readonly usage: TokenUsage;
}

/** Failed single-attempt adapter call result. */
export interface AdapterCallOnceFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: HarnessErrorCode;
  /** Set when the error was a chat-path timeout. */
  readonly timeoutMs?: number;
  /** adapter.name captured at failure time for span attribution. */
  readonly adapterName?: string;
}

/** Discriminated union returned by {@link AdapterCaller.callOnce}. */
export type AdapterCallOnceResult = AdapterCallOnceOk | AdapterCallOnceFail;

/** Successful adapter turn result, including streaming bytesRead + retry metrics. */
export interface AdapterCallOk {
  readonly ok: true;
  readonly message: Message;
  readonly usage: TokenUsage;
  /** 0 on the non-streaming path; aggregator.bytesRead on the streaming path. */
  readonly bytesRead: number;
  readonly path: 'chat' | 'stream';
  /** How many retries were burned (for observer attribution). */
  readonly attempts: number;
  /** Cumulative backoff time spent sleeping across all retries (ms). */
  readonly totalBackoffMs?: number;
  /** Total wall-clock time from first attempt to success (ms). */
  readonly totalDurationMs?: number;
}

/** Failed adapter turn result; `errorCategory` includes synthetic `HarnessErrorCode.CORE_ABORTED`. */
export interface AdapterCallFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: HarnessErrorCode;
  readonly path: 'chat' | 'stream';
  readonly attempts: number;
  /** Cumulative backoff time spent sleeping across all retries (ms). */
  readonly totalBackoffMs?: number;
  /** Total wall-clock time from first attempt to terminal failure (ms). */
  readonly totalDurationMs?: number;
  /** Set when the terminal error was a non-streaming chat timeout. */
  readonly timeoutMs?: number;
  /** adapter.name captured at failure time for span attribution. */
  readonly adapterName?: string;
}

/** Discriminated union returned by {@link AdapterCaller.call}. */
export type AdapterCallResult = AdapterCallOk | AdapterCallFail;

/**
 * Observer callback info for each retry decision. Invoked BEFORE the
 * backoff sleep, once per retry decision.
 *
 * `errorPreview` is REQUIRED on the chat path and UNDEFINED on the stream
 * path. The asymmetry is intentional: StreamResult carries only the
 * already-wrapped error, not the original throw, so a preview would be
 * duplicative.
 */
export interface AdapterRetryInfo {
  readonly attempt: number;
  readonly errorCategory: HarnessErrorCode;
  readonly path: 'chat' | 'stream';
  /** REQUIRED on chat path; UNDEFINED on stream path. Sliced to ≤500 chars. */
  readonly errorPreview?: string;
  /**
   * Computed backoff delay (ms) for this retry attempt. Callers emit this as
   * a span attribute (`backoff_ms`) and/or a histogram metric
   * (`harness.adapter.retry_backoff_ms`) with `error_category` label.
   */
  readonly backoffMs?: number;
  /**
   * 1-based retry counter (= attempt + 1) for human-facing telemetry where
   * "retry #1" / "retry #2" is clearer than the 0-based attempt index used
   * internally.
   */
  readonly retryNumber?: number;
}

/**
 * Configuration for the AdapterCaller.
 *
 * `signal` is the loop's internal `abortController.signal`; AdapterCaller
 * only holds the signal, not the controller.
 */
export interface AdapterCallerConfig {
  readonly adapter: AgentAdapter;
  readonly tools?: readonly ToolSchema[];
  readonly streaming: boolean;
  readonly signal: AbortSignal;
  readonly maxAdapterRetries: number;
  readonly baseRetryDelayMs: number;
  readonly retryableErrors: readonly string[];
  /**
   * Pre-built stream handler. Required when `streaming` is true; ignored
   * otherwise (but still typed as required to make the instantiation
   * path explicit — the caller always has one on hand).
   */
  readonly streamHandler: StreamHandler;
  /**
   * Optional circuit breaker for the adapter. When the circuit is OPEN,
   * calls fast-fail with `ADAPTER_CIRCUIT_OPEN` without reaching the LLM
   * provider, preventing cascade failures during sustained outages.
   */
  readonly circuitBreaker?: CircuitBreaker;
  /**
   * Optional per-adapter-invocation timeout in milliseconds applied to the
   * non-streaming `adapter.chat()` path.
   *
   * Default: `undefined` — **unlimited**. Callers that want the non-streaming
   * adapter promise to be bounded should set a positive value; when exceeded,
   * the chat is aborted via an internal `AbortController` chained with
   * `config.signal`, and the call resolves with `HarnessErrorCode.CORE_TIMEOUT`.
   *
   * Streaming has its own size-based safeguards in `StreamAggregator` and is
   * intentionally out of scope for this timeout.
   */
  readonly adapterTimeoutMs?: number;
  /**
   * Optional structured logger. When provided, AdapterCaller emits
   * debug-level diagnostics for ops-visible abnormal conditions that would
   * otherwise be silent (orphaned post-timeout adapter rejections, fallback
   * error-classification). Intentionally debug-level to avoid noise.
   */
  readonly logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Optional metrics port. Forwarded to {@link withAdapterTimeout}; the
   * timeout helper increments `harness.adapter.orphan_after_timeout`
   * each time the adapter rejects after the timeout deadline — signal of
   * a provider that does not honour abort signals promptly.
   */
  readonly metrics?: import('./adapter-timeout.js').AdapterTimeoutMetrics;
}

/** Public surface of the adapter caller. */
export interface AdapterCaller {
  /**
   * Execute one adapter turn with retry-with-backoff. On streaming
   * path, forwards `text_delta` / `tool_call_delta` / `warning` /
   * `error` events from {@link StreamHandler}; on chat path yields
   * NOTHING (return-only). Internal retry loop consumes abort during
   * backoff and surfaces it as `{ok:false, errorCategory:HarnessErrorCode.CORE_ABORTED}`.
   *
   * **Error-yielding asymmetry**: StreamHandler yields `{type:'error'}`
   * itself on stream failure; AdapterCaller does NOT re-yield. On chat
   * failure, AdapterCaller also does NOT yield — the caller wraps and
   * yields. Net: exactly one `{type:'error'}` event per failed turn.
   *
   * Per-call `onRetry` is supplied by `IterationRunner` so the active
   * iteration span id is captured at call time without leaking mutable state
   * onto AdapterCaller's closure.
   */
  call(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
    onRetry?: (info: AdapterRetryInfo) => void,
  ): AsyncGenerator<AgentEvent, AdapterCallResult>;

  /**
   * Execute a single non-streaming adapter turn without retry. Thin wrapper
   * around `adapter.chat`; for callers that want to own the retry policy
   * externally. Never throws: errors are caught, categorized, and returned
   * as `{ok:false}`.
   */
  callOnce(conversation: readonly Message[]): Promise<AdapterCallOnceResult>;
}

/**
 * Build an {@link AdapterCaller} from a {@link AdapterCallerConfig}.
 *
 * The returned object captures the config; the caller owns the abort
 * signal lifecycle (the signal passed in must stay valid for every
 * `call()` invocation).
 */
export function createAdapterCaller(config: Readonly<AdapterCallerConfig>): AdapterCaller {
  // Resilience primitives (backoff sleep, circuit-breaker gate, retryable
  // classifier) live on a dedicated policy so this caller only dispatches.
  const policy = createRetryPolicy({
    maxAdapterRetries: config.maxAdapterRetries,
    baseRetryDelayMs: config.baseRetryDelayMs,
    retryableErrors: config.retryableErrors,
    signal: config.signal,
    ...(config.circuitBreaker !== undefined && { circuitBreaker: config.circuitBreaker }),
  });

  async function callOnce(
    conversation: readonly Message[],
  ): Promise<AdapterCallOnceResult> {
    const chatFn = async (): Promise<AdapterCallOnceResult> => {
      // When `adapterTimeoutMs` is set, delegate to the timeout helper which
      // owns the AbortController chaining + orphan-catch bookkeeping. Unset
      // = unlimited (delegate straight to adapter.chat).
      if (config.adapterTimeoutMs !== undefined && config.adapterTimeoutMs > 0) {
        const response = await withAdapterTimeout({
          adapter: config.adapter,
          messages: conversation,
          ...(config.tools !== undefined && { tools: config.tools }),
          externalSignal: config.signal,
          timeoutMs: config.adapterTimeoutMs,
          ...(config.logger !== undefined && { logger: config.logger }),
          ...(config.metrics !== undefined && { metrics: config.metrics }),
        });
        return { ok: true, message: response.message, usage: response.usage };
      }

      const response = await config.adapter.chat({
        messages: conversation as Message[],
        signal: config.signal,
        ...(config.tools !== undefined && { tools: config.tools as ToolSchema[] }),
      });
      return { ok: true, message: response.message, usage: response.usage };
    };

    try {
      if (config.circuitBreaker) {
        return await config.circuitBreaker.execute(chatFn);
      }
      return await chatFn();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        return {
          ok: false,
          error: err,
          errorCategory: HarnessErrorCode.ADAPTER_CIRCUIT_OPEN,
        };
      }
      // Preserve CORE_TIMEOUT classification when the timeout path rejected —
      // `categorizeAdapterError` would otherwise coerce it back to
      // ADAPTER_UNKNOWN.
      if (err instanceof HarnessError && err.code === HarnessErrorCode.CORE_TIMEOUT) {
        // Carry the timeout budget and adapter name so the calling span can
        // attribute the timeout without parsing the message.
        return {
          ok: false,
          error: err,
          errorCategory: HarnessErrorCode.CORE_TIMEOUT,
          ...(config.adapterTimeoutMs !== undefined && { timeoutMs: config.adapterTimeoutMs }),
          adapterName: config.adapter.name ?? 'unknown',
        };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        ok: false,
        error,
        errorCategory: categorizeAdapterError(err, config.logger),
      };
    }
  }

  return {
    callOnce,

    async *call(
      conversation: readonly Message[],
      cumulativeStreamBytesSoFar: number,
      onRetry?: (info: AdapterRetryInfo) => void,
    ): AsyncGenerator<AgentEvent, AdapterCallResult> {
      const path: 'chat' | 'stream' = config.streaming ? 'stream' : 'chat';
      // Per-call onRetry supplied by IterationRunner so the active iteration
      // span id is captured at call time without a side-channel.
      const fireRetry = onRetry;
      // Accumulate across all retry attempts so the final result (success,
      // terminal failure, or abort) can carry the cumulative breakdown as
      // span attributes. Measured from the START of call() so
      // `totalDurationMs` includes both adapter wall-clock and backoff sleeps.
      const callStartedAt = Date.now();
      let totalBackoffMs = 0;

      for (let attempt = 0; attempt <= config.maxAdapterRetries; attempt++) {
        // Check abort before each retry attempt. On attempt 0 the top-of-loop
        // check in run() already fired; skip here to avoid double-check.
        if (attempt > 0 && config.signal.aborted) {
          return {
            ok: false,
            error: new AbortedError(),
            errorCategory: HarnessErrorCode.CORE_ABORTED,
            path,
            attempts: attempt,
            totalBackoffMs,
            totalDurationMs: Date.now() - callStartedAt,
          };
        }

        // Circuit breaker check — applies to BOTH streaming and chat paths.
        // Fast-fail before reaching the adapter when the circuit is OPEN.
        const circuitOpen = policy.checkCircuitOpen();
        if (circuitOpen) {
          return {
            ...circuitOpen,
            ok: false,
            path,
            attempts: attempt,
            totalBackoffMs,
            totalDurationMs: Date.now() - callStartedAt,
          };
        }

        if (config.streaming) {
          // Streaming branch — pump-and-decide lives in `streaming-retry.ts`
          // so this loop only owns retry policy, attempt counters, and
          // cumulative timing. The helper guarantees the consumer sees
          // EXACTLY ONE `{type:'error'}` per failed adapter turn (buffered
          // on retry, forwarded on terminal) and propagates iterator-close
          // into StreamHandler so adapters that ignore `signal` don't leak
          // sockets when consumers `.return()` mid-stream.
          const outcome = yield* runStreamingAttempt({
            streamHandler: config.streamHandler,
            policy,
            conversation,
            cumulativeStreamBytesSoFar,
            attempt,
          });
          if (outcome.kind === 'success') {
            return {
              ok: true,
              message: outcome.message,
              usage: outcome.usage,
              bytesRead: outcome.bytesRead,
              path: 'stream',
              attempts: attempt,
              totalBackoffMs,
              totalDurationMs: Date.now() - callStartedAt,
            };
          }
          if (outcome.kind === 'terminal-failure') {
            return {
              ok: false,
              error: outcome.error,
              errorCategory: outcome.errorCategory,
              path: 'stream',
              attempts: attempt,
              totalBackoffMs,
              totalDurationMs: Date.now() - callStartedAt,
            };
          }
          // outcome.kind === 'retry' — schedule backoff and loop. Compute
          // backoff BEFORE firing the retry hook so the hook receives the
          // actual sleep duration for span attribution.
          const bo = policy.scheduleBackoff(attempt);
          fireRetry?.({
            attempt,
            errorCategory: outcome.errorCategory,
            path: 'stream',
            backoffMs: bo.delay,
            retryNumber: attempt + 1,
          });
          try {
            await bo.promise;
            totalBackoffMs += bo.delay;
          } catch {
            // Abort fired during backoff — loop to top; attempt>0 abort
            // check will convert to ABORTED on next iteration.
          }
          continue;
        }

        // Non-streaming branch — single-attempt chat via callOnce.
        const r = await callOnce(conversation);
        if (r.ok) {
          return {
            ok: true,
            message: r.message,
            usage: r.usage,
            bytesRead: 0,
            path: 'chat',
            attempts: attempt,
            totalBackoffMs,
            totalDurationMs: Date.now() - callStartedAt,
          };
        }
        const { error: err, errorCategory } = r;
        if (
          policy.isRetryableCategory(errorCategory)
          && attempt < policy.maxRetries
        ) {
          const errorPreview = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          // Compute backoff BEFORE firing the retry hook so the hook observer
          // sees the actual sleep duration and retry #.
          const bo = policy.scheduleBackoff(attempt);
          fireRetry?.({
            attempt,
            errorCategory,
            path: 'chat',
            errorPreview,
            backoffMs: bo.delay,
            retryNumber: attempt + 1,
          });
          try {
            await bo.promise;
            totalBackoffMs += bo.delay;
          } catch {
            // Abort fired during backoff — loop to top; next iteration
            // will surface ABORTED via the attempt>0 abort check.
          }
          continue;
        }
        // Not retryable or retries exhausted. AdapterCaller does NOT yield
        // on chat failure — the caller wraps and yields. Propagate timeout
        // metadata (if any) and cumulative retry metrics so the caller's
        // span can carry `timeout_ms` / `adapter` / `total_backoff_ms` /
        // `total_duration_ms`.
        return {
          ok: false,
          error: err,
          errorCategory,
          path: 'chat',
          attempts: attempt,
          totalBackoffMs,
          totalDurationMs: Date.now() - callStartedAt,
          ...(r.timeoutMs !== undefined && { timeoutMs: r.timeoutMs }),
          ...(r.adapterName !== undefined && { adapterName: r.adapterName }),
        };
      }

      // Unreachable: the for-loop always returns (success, retryable
      // exhaustion, or non-retryable). Defensive branch keeps the
      // "should not reach here" contract explicit for future maintainers.
      return {
        ok: false,
        error: new HarnessError(
          'AdapterCaller retry loop exited without a terminal branch',
          HarnessErrorCode.ADAPTER_UNKNOWN,
          'This indicates a logic error in AdapterCaller.call; please report',
        ),
        errorCategory: HarnessErrorCode.ADAPTER_UNKNOWN,
        path,
        attempts: config.maxAdapterRetries + 1,
        totalBackoffMs,
        totalDurationMs: Date.now() - callStartedAt,
      };
    },
  };
}
