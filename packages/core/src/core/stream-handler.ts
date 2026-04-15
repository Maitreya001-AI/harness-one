/**
 * StreamHandler — translate one `adapter.stream()` call into an AgentEvent
 * sequence and return a {@link StreamResult} discriminated union.
 *
 * Wave-5B Step 2 extraction: body of the previous
 * `AgentLoop.handleStream` (L1106-L1160) lives here. The side-channel
 * `_lastStreamErrorCategory` it used to set on `AgentLoop` is gone —
 * the error category travels with the result instead.
 *
 * Observer-visible behaviour is identical to today: on failure the
 * `{type:'error', error}` event is yielded JUST BEFORE returning
 * `{ok:false,...}`, matching today's L1138 / L1154 yield points.
 *
 * See `docs/forge-fix/wave-5/wave-5b-adr-v2.md` §2.2 and §7 Step 2.
 *
 * @module
 */

import type { AgentAdapter, Message, TokenUsage, ToolSchema } from './types.js';
import type { AgentEvent } from './events.js';
import { HarnessError } from './errors.js';
import { categorizeAdapterError } from './error-classifier.js';
import { StreamAggregator } from './stream-aggregator.js';

/**
 * Discriminated union returned by {@link StreamHandler.handle}. The
 * `ok:true` branch carries the accumulated message + bytesRead; the
 * `ok:false` branch carries the wrapped error + its category (the
 * category that used to live on `AgentLoop._lastStreamErrorCategory`).
 */
export type StreamResult =
  | {
      readonly ok: true;
      readonly message: Message;
      readonly usage: TokenUsage;
      readonly bytesRead: number;
    }
  | {
      readonly ok: false;
      readonly error: HarnessError | Error;
      readonly errorCategory: string;
    };

/**
 * Configuration for the stream handler. The caller is responsible for
 * ensuring `adapter.stream` is defined before invoking `handle()` —
 * StreamHandler does not branch on streaming capability.
 */
export interface StreamHandlerConfig {
  readonly adapter: AgentAdapter;
  readonly tools?: readonly ToolSchema[];
  readonly signal: AbortSignal;
  readonly maxStreamBytes: number;
  readonly maxToolArgBytes: number;
  /**
   * Cap on cumulative bytes across iterations. Today derived as
   * `maxIterations * maxStreamBytes` at `AgentLoop` constructor /
   * `run()` entry (§2.2). Passed in so StreamHandler stays stateless
   * across iterations.
   */
  readonly maxCumulativeStreamBytes: number;
}

/** Public surface of the stream handler. */
export interface StreamHandler {
  /**
   * Consume one `adapter.stream()` call.
   *
   * YIELDS: `text_delta` | `tool_call_delta` | `warning` | `error`.
   * RETURNS: {@link StreamResult}.
   *
   * On failure — both adapter throws and aggregator-detected size-limit
   * errors — the `{type:'error'}` event is yielded JUST BEFORE
   * returning `{ok:false,...}`. This preserves the observer-visible
   * event stream of today's `handleStream`.
   *
   * AdapterCaller (the sole caller) MUST NOT re-yield `{type:'error'}`
   * on the stream path (see ADR §9 R1 / §2.1 JSDoc).
   */
  handle(
    conversation: readonly Message[],
    cumulativeStreamBytesSoFar: number,
  ): AsyncGenerator<AgentEvent, StreamResult>;
}

/**
 * Build a {@link StreamHandler} from a {@link StreamHandlerConfig}.
 *
 * StreamHandler is stateless across `handle()` calls: a fresh
 * {@link StreamAggregator} is constructed per invocation so the
 * instance is safe to reuse. No cross-call state, no side-channels.
 */
export function createStreamHandler(config: Readonly<StreamHandlerConfig>): StreamHandler {
  return {
    async *handle(
      conversation: readonly Message[],
      cumulativeStreamBytesSoFar: number,
    ): AsyncGenerator<AgentEvent, StreamResult> {
      const aggregator = new StreamAggregator({
        maxStreamBytes: config.maxStreamBytes,
        maxToolArgBytes: config.maxToolArgBytes,
        cumulativeStreamBytesSoFar,
        maxCumulativeStreamBytes: config.maxCumulativeStreamBytes,
      });
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

      try {
        // Caller's contract: `adapter.stream` is defined. Narrow via
        // the same non-null assertion pattern used by the previous
        // inline handleStream (agent-loop.ts L1124).
        const streamFn = config.adapter.stream as NonNullable<typeof config.adapter.stream>;
        const stream = streamFn({
          messages: conversation as Message[],
          signal: config.signal,
          ...(config.tools !== undefined && { tools: config.tools as ToolSchema[] }),
        });

        for await (const chunk of stream) {
          // 'done' chunks carry usage but produce no consumer events.
          if (chunk.type === 'done') {
            if (chunk.usage) usage = chunk.usage;
            continue;
          }

          // Delegate accumulation to the aggregator. It yields exactly
          // the same {text_delta, tool_call_delta, warning, error}
          // sequence as the previous inline implementation.
          for (const evt of aggregator.handleChunk(chunk)) {
            if (evt.type === 'error') {
              // Aggregator-detected terminal failure (size limits, etc.)
              // Parity with today's agent-loop L1141-L1143: yield the raw
              // Error unchanged. Categorize for the AdapterCaller retry
              // decision — size-limit errors fall into the non-retryable
              // `ADAPTER_UNKNOWN` bucket so the retry check is a no-op.
              const errorCategory = categorizeAdapterError(evt.error);
              yield { type: 'error', error: evt.error };
              return { ok: false, error: evt.error, errorCategory };
            }
            // text_delta / tool_call_delta / warning passthrough.
            yield evt;
          }
        }
      } catch (err) {
        const errorCategory = categorizeAdapterError(err);
        const wrapped = err instanceof HarnessError
          ? err
          : new HarnessError(
              err instanceof Error ? err.message : String(err),
              errorCategory,
              'Check adapter configuration and API credentials',
              err instanceof Error ? err : undefined,
            );
        yield { type: 'error', error: wrapped };
        return { ok: false, error: wrapped, errorCategory };
      }

      const { message, bytesRead } = aggregator.getMessage(usage);
      return { ok: true, message, usage, bytesRead };
    },
  };
}
