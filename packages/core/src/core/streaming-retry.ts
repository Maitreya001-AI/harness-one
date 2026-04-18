/**
 * Streaming-attempt pump-and-decide helper.
 *
 * Drives one streaming adapter attempt: forwards `text_delta` /
 * `tool_call_delta` / `warning` events from {@link StreamHandler}, buffers
 * the single terminal `{type:'error'}` event, and decides whether the
 * attempt should retry, terminate, or succeed based on the retry policy.
 *
 * The outer retry loop in `adapter-caller.ts` keeps ownership of:
 *
 *   - per-attempt counter + cumulative timing,
 *   - backoff sleep and abort handling,
 *   - circuit-breaker probing,
 *   - building the {@link AdapterCallResult} envelope.
 *
 * Extracted in Wave-21 so the streaming branch stops sharing a 192-LOC body
 * with the chat-path retry — the two only share retry policy and timing.
 *
 * @module
 */

import type { Message } from './types.js';
import type { AgentEvent } from './events.js';
import type { HarnessError, HarnessErrorCode } from './errors.js';
import type { StreamHandler } from './stream-handler.js';
import type { RetryPolicy } from './retry-policy.js';

/** Outcome reported by {@link runStreamingAttempt}. */
export type StreamingAttemptOutcome =
  | {
      readonly kind: 'success';
      readonly message: Message;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly bytesRead: number;
    }
  | {
      readonly kind: 'terminal-failure';
      readonly error: HarnessError | Error;
      readonly errorCategory: HarnessErrorCode;
    }
  | {
      readonly kind: 'retry';
      readonly errorCategory: HarnessErrorCode;
    };

export interface StreamingAttemptArgs {
  readonly streamHandler: StreamHandler;
  readonly policy: Pick<RetryPolicy, 'isRetryableCategory' | 'maxRetries' | 'recordSuccess' | 'recordFailure'>;
  readonly conversation: readonly Message[];
  readonly cumulativeStreamBytesSoFar: number;
  /** Zero-based attempt counter from the outer retry loop. */
  readonly attempt: number;
}

/**
 * Run one streaming adapter attempt.
 *
 * On success: yields all delta/warning events; returns the message + usage.
 * On terminal failure: yields all delta/warning events, then yields the
 *   buffered `{type:'error'}` event verbatim, then returns the terminal
 *   outcome. `policy.recordFailure()` is called.
 * On retry: yields all delta/warning events EXCEPT the buffered error
 *   (swallowed); returns the retry outcome. The outer loop sleeps and
 *   re-enters.
 *
 * The helper guarantees iterator-close propagation: if the consumer calls
 * `.return()` on the outer generator mid-stream, the underlying
 * {@link StreamHandler} generator's `for await` is cancelled via
 * `streamGen.return?.()` in the finally block.
 */
export async function* runStreamingAttempt(
  args: StreamingAttemptArgs,
): AsyncGenerator<AgentEvent, StreamingAttemptOutcome> {
  const { streamHandler, policy, conversation, cumulativeStreamBytesSoFar, attempt } = args;
  const streamGen = streamHandler.handle(conversation, cumulativeStreamBytesSoFar);
  let pendingError: Extract<AgentEvent, { type: 'error' }> | undefined;

  try {
    // Pump: pass through text_delta / tool_call_delta / warning unchanged;
    // buffer the single terminal error event so the outer caller decides
    // whether to forward it (terminal) or drop it (retry).
    while (true) {
      const step = await streamGen.next();
      if (step.done) {
        const streamResult = step.value;
        if (streamResult.ok) {
          policy.recordSuccess();
          return {
            kind: 'success',
            message: streamResult.message,
            usage: streamResult.usage,
            bytesRead: streamResult.bytesRead,
          };
        }
        const errorCategory = streamResult.errorCategory;
        if (
          policy.isRetryableCategory(errorCategory)
          && attempt < policy.maxRetries
        ) {
          // Retry: swallow the buffered error event so the consumer sees
          // only the FINAL terminal error, not one per failed attempt.
          return { kind: 'retry', errorCategory };
        }
        // Terminal failure: forward the buffered error event verbatim so
        // the observer-visible stream preserves "yield then return" order.
        policy.recordFailure();
        if (pendingError) yield pendingError;
        return {
          kind: 'terminal-failure',
          error: streamResult.error,
          errorCategory,
        };
      }
      const evt = step.value;
      if (evt.type === 'error') {
        pendingError = evt;
        continue;
      }
      yield evt;
    }
  } finally {
    // Forward iterator-close into StreamHandler when the consumer called
    // `.return()` on the outer generator mid-stream. Calling `.return()`
    // on an already-finished generator is a no-op or can throw — either
    // way is fine; we just need close-propagation into the `for await`
    // inside StreamHandler, which in turn propagates into
    // `adapter.stream()`. Typed-view as the loose AsyncIterator interface
    // so `.return()` accepts `undefined`.
    const closable: AsyncIterator<AgentEvent> = streamGen;
    await closable.return?.(undefined)?.catch(() => {
      /* generator already done — fine */
    });
  }
}
