/**
 * Adapter caller — executes one adapter turn (streaming or non-streaming)
 * with retry-with-backoff and returns a unified discriminated result.
 *
 * Wave-5B Step 2 scope: the module now owns the full retry-with-backoff
 * loop (formerly in `AgentLoop.run()` L622-L739) and branches on the
 * configured `streaming` flag to delegate to either {@link StreamHandler}
 * or `adapter.chat`. The Step-1 `callOnce` surface remains exported as a
 * thin internal helper folded into the chat branch.
 *
 * Asymmetry note (ADR §9 R1): StreamHandler yields the `{type:'error'}`
 * event itself on stream failure; AdapterCaller MUST NOT re-yield in
 * that case. On chat failure, AdapterCaller also does NOT yield — the
 * caller (run()'s inline bail today, IterationRunner's bailOut in
 * Step 3) is responsible for yielding the wrapped error event. Net
 * effect: exactly one `{type:'error'}` event per failed adapter turn.
 *
 * See `docs/forge-fix/wave-5/wave-5b-adr-v2.md` §2.1, §5, §7 Step 2,
 * §9 R1, §9 R2.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolSchema } from './types.js';
import type { AgentEvent } from './events.js';
import { AbortedError, HarnessError, HarnessErrorCode} from './errors.js';
import { categorizeAdapterError } from './error-classifier.js';
import { computeBackoffMs } from '../infra/backoff.js';
import { type CircuitBreaker, CircuitOpenError } from '../infra/circuit-breaker.js';
import type { StreamHandler } from './stream-handler.js';

/** Successful single-attempt adapter call result (Step 1 shape; retained). */
export interface AdapterCallOnceOk {
  readonly ok: true;
  readonly message: Message;
  readonly usage: TokenUsage;
}

/** Failed single-attempt adapter call result (Step 1 shape; retained). */
export interface AdapterCallOnceFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: HarnessErrorCode;
  /** Wave-13 D-5: set when the error was a chat-path timeout. */
  readonly timeoutMs?: number;
  /** Wave-13 D-5: adapter.name captured at failure time for span attribution. */
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
  /** Wave-13 D-6: cumulative backoff time spent sleeping across all retries (ms). */
  readonly totalBackoffMs?: number;
  /** Wave-13 D-6: total wall-clock time from first attempt to success (ms). */
  readonly totalDurationMs?: number;
}

/** Failed adapter turn result; `errorCategory` includes synthetic `HarnessErrorCode.CORE_ABORTED`. */
export interface AdapterCallFail {
  readonly ok: false;
  readonly error: HarnessError | Error;
  readonly errorCategory: HarnessErrorCode;
  readonly path: 'chat' | 'stream';
  readonly attempts: number;
  /** Wave-13 D-6: cumulative backoff time spent sleeping across all retries (ms). */
  readonly totalBackoffMs?: number;
  /** Wave-13 D-6: total wall-clock time from first attempt to terminal failure (ms). */
  readonly totalDurationMs?: number;
  /** Wave-13 D-5: set when the terminal error was a non-streaming chat timeout. */
  readonly timeoutMs?: number;
  /** Wave-13 D-5: adapter.name captured at failure time for span attribution. */
  readonly adapterName?: string;
}

/** Discriminated union returned by {@link AdapterCaller.call}. */
export type AdapterCallResult = AdapterCallOk | AdapterCallFail;

/**
 * Observer callback info for each retry decision. Invoked BEFORE the
 * backoff sleep, once per retry decision.
 *
 * `errorPreview` is REQUIRED on the chat path and UNDEFINED on the
 * stream path — mirrors today's agent-loop.ts L702 (chat retry span
 * event) vs L658 (stream retry span event). The asymmetry is
 * intentional: StreamResult carries only the already-wrapped error,
 * not the original throw, so a preview would be duplicative.
 */
export interface AdapterRetryInfo {
  readonly attempt: number;
  readonly errorCategory: HarnessErrorCode;
  readonly path: 'chat' | 'stream';
  /** REQUIRED on chat path; UNDEFINED on stream path. Sliced to ≤500 chars. */
  readonly errorPreview?: string;
  /**
   * Wave-13 D-4: computed backoff delay (ms) for this retry attempt. Callers
   * emit this as a span attribute (`backoff_ms`) and/or a histogram metric
   * (`harness.adapter.retry_backoff_ms`) with `error_category` label.
   */
  readonly backoffMs?: number;
  /**
   * Wave-13 D-4: 1-based retry counter (= attempt + 1) for human-facing
   * telemetry where "retry #1" / "retry #2" is clearer than the 0-based
   * attempt index used internally.
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
   * Wave-12 P1-4: optional per-adapter-invocation timeout in milliseconds
   * applied to the non-streaming `adapter.chat()` path.
   *
   * Default: `undefined` — **unlimited** (matches pre-Wave-12 behaviour).
   * Callers that want the non-streaming adapter promise to be bounded
   * should set a positive value; when exceeded, the chat is aborted via
   * an internal `AbortController` chained with `config.signal`, and the
   * call resolves with `HarnessErrorCode.CORE_TIMEOUT`.
   *
   * Streaming has its own size-based safeguards in `StreamAggregator`
   * and is intentionally out of scope for this timeout.
   */
  readonly adapterTimeoutMs?: number;
  /**
   * Wave-13 D-3 / D-8: optional structured logger. When provided, AdapterCaller
   * emits debug-level diagnostics for ops-visible abnormal conditions that
   * were previously silent (orphaned post-timeout adapter rejections,
   * fallback error-classification). Intentionally debug-level to avoid noise.
   */
  readonly logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
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
   * Asymmetry (ADR §9 R1): StreamHandler yields `{type:'error'}` itself
   * on stream failure; AdapterCaller does NOT re-yield. On chat
   * failure, AdapterCaller also does NOT yield — the caller wraps and
   * yields. Net: exactly one `{type:'error'}` event per failed turn.
   *
   * Wave-5B Step 3: per-call `onRetry` is supplied by `IterationRunner`
   * so the active iteration span id is captured at call time without
   * leaking mutable state onto AdapterCaller's closure.
   */
  call(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
    onRetry?: (info: AdapterRetryInfo) => void,
  ): AsyncGenerator<AgentEvent, AdapterCallResult>;

  /**
   * Execute a single non-streaming adapter turn without retry. Thin
   * wrapper around `adapter.chat`; retained from Step 1 for callers
   * that want to own the retry policy externally. Never throws:
   * errors are caught, categorized, and returned as `{ok:false}`.
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
  /**
   * Wave-12 P1-17: precompute a `Set<string>` for O(1) `retryableErrors`
   * membership checks on the hot retry path. Replaces two `includes()`
   * linear scans per retry decision (one per call path — chat and stream).
   * The public API keeps accepting `readonly string[]` so callers remain
   * source-compatible.
   */
  const retryableErrorSet = new Set<string>(config.retryableErrors);

  /**
   * Sleep for exponential backoff with jitter. Rejects with AbortedError
   * if `config.signal` fires during the wait. Extracted from former
   * `AgentLoop.backoff` (L1216-L1253).
   *
   * Wave-13 D-4/D-6: returns the delay used so the caller can accumulate
   * a cumulative backoff total and publish per-retry observability.
   */
  function backoff(attempt: number): { delay: number; promise: Promise<void> } {
    const delay = computeBackoffMs(attempt, {
      baseMs: config.baseRetryDelayMs,
      jitterFraction: 0.25,
    });

    const promise = new Promise<void>((resolve, reject) => {
      if (config.signal.aborted) {
        reject(new AbortedError());
        return;
      }

      let settled = false;
      // Wave-12 P2-1: hoist the timer handle so the abort listener can
      // reference it BEFORE the timer is armed. Previously the listener
      // was registered AFTER `setTimeout` returned, leaving a micro-race
      // where a synchronously-fired abort between the two statements would
      // not cancel the timer; the abort listener is now installed first.
      // eslint-disable-next-line prefer-const -- late-bound; onAbort closes over it before assignment
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => {
        if (!settled) {
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          // Listener auto-removed by { once: true } — no removeEventListener needed
          reject(new AbortedError());
        }
      };

      // Register abort listener BEFORE arming the timer (P2-1).
      config.signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          config.signal.removeEventListener('abort', onAbort);
          resolve();
        }
      }, delay);

      // Ensure timer doesn't keep the process alive
      if (typeof timer === 'object' && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    });
    return { delay, promise };
  }

  async function callOnce(
    conversation: readonly Message[],
  ): Promise<AdapterCallOnceResult> {
    const chatFn = async (): Promise<AdapterCallOnceResult> => {
      // Wave-12 P1-4: when `adapterTimeoutMs` is set, chain an internal
      // AbortController with `config.signal` and race `adapter.chat` against
      // an abortable timeout. Unset = unlimited (pre-Wave-12 semantics).
      if (config.adapterTimeoutMs !== undefined && config.adapterTimeoutMs > 0) {
        const timeoutMs = config.adapterTimeoutMs;
        const internalAbort = new AbortController();
        // Chain: any external abort cancels the adapter request too.
        const forwardAbort = (): void => {
          try {
            internalAbort.abort();
          } catch {
            /* already aborted — fine */
          }
        };
        if (config.signal.aborted) {
          internalAbort.abort();
        } else {
          config.signal.addEventListener('abort', forwardAbort, { once: true });
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const chatPromise = config.adapter.chat({
          messages: conversation as Message[],
          signal: internalAbort.signal,
          ...(config.tools !== undefined && { tools: config.tools as ToolSchema[] }),
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              internalAbort.abort();
            } catch {
              /* */
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
          return { ok: true, message: response.message, usage: response.usage };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          try {
            config.signal.removeEventListener('abort', forwardAbort);
          } catch {
            /* */
          }
          // Swallow any rejection from the now-orphaned chatPromise on
          // timeout; without this the Node process prints an
          // UnhandledPromiseRejection when the adapter finally throws
          // its own AbortError after we've already resolved/rejected.
          //
          // Wave-13 D-3: emit a debug log so ops can detect abnormal upstream
          // behaviour (e.g. adapter not honouring the abort signal). Kept at
          // debug-level — not every orphan rejection is actionable.
          if (timedOut) {
            chatPromise.catch((err: unknown) => {
              config.logger?.debug?.('adapter orphan after timeout', {
                error: String(err).slice(0, 200),
                adapter: config.adapter.name ?? 'unknown',
                timeoutMs,
              });
            });
          }
        }
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
      // Wave-12 P1-4: preserve CORE_TIMEOUT classification when the timeout
      // path rejected — `categorizeAdapterError` would otherwise coerce it
      // back to ADAPTER_UNKNOWN.
      if (err instanceof HarnessError && err.code === HarnessErrorCode.CORE_TIMEOUT) {
        // Wave-13 D-5: carry the timeout budget and adapter name so the
        // calling span can attribute the timeout without parsing the message.
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
      // Wave-13 D-6: accumulate across all retry attempts so the final result
      // (success, terminal failure, or abort) can carry the cumulative
      // breakdown as span attributes. Measured from the START of call() so
      // `totalDurationMs` includes both adapter wall-clock and backoff sleeps.
      const callStartedAt = Date.now();
      let totalBackoffMs = 0;

      for (let attempt = 0; attempt <= config.maxAdapterRetries; attempt++) {
        // Check abort before each retry attempt. On attempt 0 the top-of-loop
        // check in run() already fired; skipping here matches today's L632.
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
        if (config.circuitBreaker) {
          const cbState = config.circuitBreaker.state();
          if (cbState === 'open') {
            return {
              ok: false,
              error: new CircuitOpenError(),
              errorCategory: HarnessErrorCode.ADAPTER_CIRCUIT_OPEN,
              path,
              attempts: attempt,
              totalBackoffMs,
              totalDurationMs: Date.now() - callStartedAt,
            };
          }
        }

        if (config.streaming) {
          // Streaming branch — delegate to StreamHandler. We iterate its
          // generator manually (rather than `yield*`) so we can SWALLOW
          // the terminal `{type:'error'}` event when a retry is going to
          // follow. The ADR §9 R1 invariant is: the consumer sees
          // EXACTLY ONE `{type:'error'}` per failed adapter turn, even
          // across retries. StreamHandler yields the error per-attempt
          // to preserve today's observer-visible stream semantics; the
          // caller (AdapterCaller) is responsible for coalescing.
          const streamGen = config.streamHandler.handle(
            conversation,
            cumulativeStreamBytesSoFar,
          );
          let pendingError: Extract<AgentEvent, { type: 'error' }> | undefined;

          // MF-1 (Wave-5B follow-up): wrap the manual pump in try/finally so
          // consumer `.return()` on the outer `run()` generator forwards
          // iterator-close into StreamHandler. Without this, the `for await`
          // inside StreamHandler stays suspended on the adapter's chunk until
          // the abort signal fires, leaking file handles/sockets/timers for
          // adapters that don't cooperate promptly with `config.signal`.
          // See wave-5b-review-redteam.md §M-1.
          try {
            // Pump: pass through text_delta / tool_call_delta / warning
            // unchanged; buffer the single terminal error event so we can
            // decide whether to forward it AFTER we know if retry applies.
            while (true) {
              const step = await streamGen.next();
              if (step.done) {
                const streamResult = step.value;
                if (streamResult.ok) {
                  // Success: drop any buffered error (there shouldn't be
                  // one — StreamHandler only yields error before ok:false).
                  config.circuitBreaker?.recordSuccess();
                  return {
                    ok: true,
                    message: streamResult.message,
                    usage: streamResult.usage,
                    bytesRead: streamResult.bytesRead,
                    path: 'stream',
                    attempts: attempt,
                    totalBackoffMs,
                    totalDurationMs: Date.now() - callStartedAt,
                  };
                }
                // Stream attempt failed — decide retry vs terminal.
                const errorCategory = streamResult.errorCategory;
                if (
                  retryableErrorSet.has(errorCategory)
                  && attempt < config.maxAdapterRetries
                ) {
                  // Retry. Swallow the buffered error event: the consumer
                  // should see only the FINAL terminal error, not one per
                  // failed attempt.
                  pendingError = undefined;
                  // Wave-13 D-4: compute backoff BEFORE firing the retry hook
                  // so the hook receives the actual sleep duration for span
                  // attribution. Capture delay via the { delay, promise } tuple.
                  const bo = backoff(attempt);
                  fireRetry?.({
                    attempt,
                    errorCategory,
                    path: 'stream',
                    backoffMs: bo.delay,
                    retryNumber: attempt + 1,
                  });
                  try {
                    await bo.promise;
                    totalBackoffMs += bo.delay;
                  } catch {
                    // Abort fired during backoff — loop to top; attempt>0
                    // abort check will convert to ABORTED on next iteration.
                  }
                  break; // exit pump-while; outer for-loop runs next attempt
                }
                // Terminal failure: forward the buffered error event
                // verbatim so the observer-visible stream matches today's
                // "yield then return" ordering (ADR §2.2 / §9 R1).
                config.circuitBreaker?.recordFailure();
                if (pendingError) yield pendingError;
                return {
                  ok: false,
                  error: streamResult.error,
                  errorCategory,
                  path: 'stream',
                  attempts: attempt,
                  totalBackoffMs,
                  totalDurationMs: Date.now() - callStartedAt,
                };
              }
              const evt = step.value;
              if (evt.type === 'error') {
                // Buffer: we forward or drop based on the terminal result.
                pendingError = evt;
                continue;
              }
              // text_delta / tool_call_delta / warning — pass through.
              yield evt;
            }
          } finally {
            // Forward iterator-close into StreamHandler when the consumer
            // called `.return()` on run() mid-stream. Calling `.return()`
            // on an already-finished generator is a no-op or can throw —
            // either way is fine; we just need close-propagation into the
            // `for await` inside StreamHandler, which in turn propagates
            // into `adapter.stream()`. The `StreamResult` we would pass
            // here is discarded (the `try { while(true) }` either already
            // returned the real result or we bailed early via consumer
            // `.return()`, in which case the return value is ignored by
            // the iterator-close protocol). Typed-view as the loose
            // AsyncIterator interface so `.return()` accepts `undefined`.
            const closable: AsyncIterator<AgentEvent> = streamGen;
            await closable.return?.(undefined)?.catch(() => {
              /* generator already done — fine */
            });
          }
          // fell out of pump-while via `break` for retry; continue for-loop
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
          retryableErrorSet.has(errorCategory)
          && attempt < config.maxAdapterRetries
        ) {
          const errorPreview = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          // Wave-13 D-4: compute backoff BEFORE firing the retry hook so the
          // hook observer sees the actual sleep duration and retry #.
          const bo = backoff(attempt);
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
        // on chat failure — the caller wraps and yields.
        //
        // Wave-13 D-5/D-6: propagate timeout metadata (if any) and cumulative
        // retry metrics so the caller's span can carry
        // `timeout_ms` / `adapter` / `total_backoff_ms` / `total_duration_ms`.
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
      // exhaustion, or non-retryable). Defensive branch preserves the
      // pre-Wave-5B "should not reach here" semantics from agent-loop.ts
      // L739-L746 (unreachable bail).
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
