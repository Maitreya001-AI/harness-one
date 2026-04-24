/**
 * `createChaosAdapter` — wraps an inner `AgentAdapter` and injects
 * probabilistic faults for **chaos testing**.
 *
 * Every fault kind is independent and composable: you can mix a 30% 429
 * rate with a 20% mid-stream break and a 5% hang and exercise the loop's
 * resilience primitives (retry + fallback + one-way breaker +
 * `maxStreamBytes` + timeout) under a realistic adversarial sequence.
 *
 * **Determinism is load-bearing.** Every decision branches on a single
 * seeded PRNG ({@link createSeededRng}), so a given `seed` + inner
 * adapter + call sequence produces the exact same injection record. Chaos
 * scenarios feed the seed from `CHAOS_SEED` in CI so a flake on seed 42
 * can be reproduced locally with `CHAOS_SEED=42 pnpm test`.
 *
 * **Non-goals.** This wrapper is not a middleware stack replacement and
 * does not emit observability events — it is test-only infrastructure that
 * lives next to the mock adapter factories.
 *
 * @module
 */

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  ToolCallRequest,
} from '../../core/types.js';
import { createSeededRng, type SeededRng } from './prng.js';

/** Probability table for HTTP-like error injection. */
export interface ErrorRateConfig {
  /** Probability (0..1) of throwing a 429 rate-limit error. */
  readonly 429?: number;
  /** Probability (0..1) of throwing a 503 service-unavailable error. */
  readonly 503?: number;
  /** Probability (0..1) of throwing a generic network error. */
  readonly network?: number;
}

/** Configuration for the chaos adapter. Every rate is 0..1, independent. */
export interface ChaosConfig {
  /** Probability-keyed HTTP-like errors injected BEFORE the inner call. */
  readonly errorRate?: ErrorRateConfig;
  /**
   * Probability (0..1) that a streaming response breaks after emitting at
   * least one chunk but before 'done'. Simulates TCP reset / connection
   * drop mid-stream.
   */
  readonly streamBreakRate?: number;
  /**
   * Probability (0..1) that a tool_use chunk's arguments get padded past
   * {@link bloatBytes}. The padding is a single oversized payload the
   * aggregator must reject with `ADAPTER_PAYLOAD_OVERSIZED`.
   */
  readonly toolArgBloatRate?: number;
  /**
   * Byte count used when `toolArgBloatRate` fires. Default 6 MB (above the
   * 5 MB default `maxToolArgBytes`).
   */
  readonly bloatBytes?: number;
  /**
   * Probability (0..1) that the call hangs forever. Callers pair this with
   * an outer timeout (`adapterTimeoutMs`, `maxDurationMs`, or `signal`) to
   * prove abort semantics.
   */
  readonly hangRate?: number;
  /**
   * Probability (0..1) that the FIRST returned tool call carries
   * non-parsable JSON arguments. Simulates a provider round-tripping
   * garbage.
   */
  readonly invalidJsonRate?: number;
  /**
   * Seeded PRNG seed — MANDATORY for reproducibility. Zero and negative
   * seeds are coerced to 1 by the PRNG.
   */
  readonly seed: number;
}

/** Kinds of injection the chaos adapter can record. */
export type InjectionKind =
  | 'error-429'
  | 'error-503'
  | 'error-network'
  | 'stream-break'
  | 'tool-arg-bloat'
  | 'hang'
  | 'invalid-json'
  | 'clean';

/** Single recorded injection event for post-run assertions. */
export interface InjectionRecord {
  /** 1-based call number across all chat+stream invocations. */
  readonly callNumber: number;
  /** Injection kind; `'clean'` means no fault was injected. */
  readonly kind: InjectionKind;
  /** Path that invoked the adapter. */
  readonly path: 'chat' | 'stream';
  /** Wall-clock millisecond timestamp the injection fired at. */
  readonly at: number;
}

/** Public surface of the in-memory injection recorder. */
export interface ChaosRecorder {
  /** Every recorded injection in call order. */
  readonly records: readonly InjectionRecord[];
  /** Count of injections of a given kind (including 'clean'). */
  count(kind: InjectionKind): number;
  /** Total number of inner-adapter calls observed. */
  readonly totalCalls: number;
  /** Reset all recorded state. Useful between suite runs with a shared recorder. */
  reset(): void;
}

/**
 * Create a chaos-wrapped adapter.
 *
 * The returned adapter also exposes `.recorder` and `.config` so scenarios
 * can assert on what was actually injected and reproduce a run verbatim.
 */
export function createChaosAdapter(
  inner: AgentAdapter,
  config: ChaosConfig,
): AgentAdapter & { readonly recorder: ChaosRecorder; readonly config: ChaosConfig } {
  const rng: SeededRng = createSeededRng(config.seed);
  const records: InjectionRecord[] = [];
  let callCounter = 0;
  const bloatBytes = config.bloatBytes ?? 6 * 1024 * 1024;

  const recorder: ChaosRecorder = {
    get records() {
      return records;
    },
    count(kind: InjectionKind): number {
      let n = 0;
      for (const r of records) if (r.kind === kind) n++;
      return n;
    },
    get totalCalls() {
      return records.length;
    },
    reset() {
      records.length = 0;
      callCounter = 0;
    },
  };

  function record(kind: InjectionKind, path: 'chat' | 'stream'): InjectionRecord {
    const entry: InjectionRecord = {
      callNumber: callCounter,
      kind,
      path,
      at: Date.now(),
    };
    records.push(entry);
    return entry;
  }

  /**
   * Pick the first fault (in a stable order) whose probability hits. Order is
   * deliberate: synchronous error-before-call faults first (fastest to surface
   * in the retry loop), then hang (needs to reach the adapter boundary to show
   * up), then stream-only faults (stream-break / tool-arg-bloat / invalid-json
   * are evaluated later in the stream path). We consume one `rng.next()` per
   * probability slot regardless of whether it fires, so adding a new fault
   * kind never silently reorders the rest of the sequence.
   */
  function pickPreCallFault(): InjectionKind | null {
    const e = config.errorRate;
    if (e?.[429] !== undefined) {
      if (rng.chance(e[429])) return 'error-429';
    }
    if (e?.[503] !== undefined) {
      if (rng.chance(e[503])) return 'error-503';
    }
    if (e?.network !== undefined) {
      if (rng.chance(e.network)) return 'error-network';
    }
    if (config.hangRate !== undefined && rng.chance(config.hangRate)) {
      return 'hang';
    }
    return null;
  }

  async function maybePreCallInjection(path: 'chat' | 'stream', signal?: AbortSignal): Promise<'proceed'> {
    const fault = pickPreCallFault();
    if (fault === 'error-429') {
      record('error-429', path);
      throw new Error('429 Too Many Requests');
    }
    if (fault === 'error-503') {
      record('error-503', path);
      throw new Error('503 Service Unavailable');
    }
    if (fault === 'error-network') {
      record('error-network', path);
      throw new Error('ECONNREFUSED network error');
    }
    if (fault === 'hang') {
      record('hang', path);
      // Block until signal fires — the outer timeout / abort must rescue us.
      // The chaos adapter NEVER self-resolves a hang, so a caller without a
      // timeout will deadlock (intentional — it surfaces a missing timeout).
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
      // Unreachable under normal operation, but keeps type flow simple.
      throw new Error('Aborted');
    }
    return 'proceed';
  }

  return {
    recorder,
    config,
    name: inner.name !== undefined ? `chaos(${inner.name})` : 'chaos',

    async chat(params: ChatParams): Promise<ChatResponse> {
      callCounter++;
      await maybePreCallInjection('chat', params.signal);

      // Chat-only fault: invalid-json rewrites the first tool call's
      // arguments. Stream-break / tool-arg-bloat don't apply to the chat
      // path (they require a chunked transport).
      const response = await inner.chat(params);
      if (
        config.invalidJsonRate !== undefined &&
        rng.chance(config.invalidJsonRate) &&
        response.message.role === 'assistant' &&
        response.message.toolCalls !== undefined &&
        response.message.toolCalls.length > 0
      ) {
        record('invalid-json', 'chat');
        const mutated = response.message.toolCalls.map((tc: ToolCallRequest, i: number) =>
          i === 0 ? { ...tc, arguments: '{not valid json]' } : tc,
        );
        return {
          ...response,
          message: { ...response.message, toolCalls: mutated },
        };
      }

      record('clean', 'chat');
      return response;
    },

    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      if (typeof inner.stream !== 'function') {
        throw new Error('chaos-adapter: inner adapter has no stream() method');
      }
      callCounter++;
      await maybePreCallInjection('stream', params.signal);

      // Roll stream-only injection dice ONCE up front so the PRNG sequence is
      // deterministic regardless of how many chunks the inner stream emits.
      const breakThisStream =
        config.streamBreakRate !== undefined && rng.chance(config.streamBreakRate);
      const bloatThisStream =
        config.toolArgBloatRate !== undefined && rng.chance(config.toolArgBloatRate);
      const invalidJsonThisStream =
        config.invalidJsonRate !== undefined && rng.chance(config.invalidJsonRate);

      let injected: InjectionKind | null = null;
      let chunkIndex = 0;
      let toolArgsMutated = false;
      let firstToolCallSeen = false;

      try {
        for await (const chunk of inner.stream(params)) {
          // Mid-stream break fires after at least one chunk has flowed
          // downstream, so the aggregator has "real" state to tear down.
          if (breakThisStream && chunkIndex === 1) {
            injected = 'stream-break';
            record('stream-break', 'stream');
            throw new Error('stream connection reset by peer (network)');
          }

          // Rewrite the first tool_call_delta that actually carries
          // `arguments` with a bloated payload. Waiting for a delta with
          // arguments means we target the path StreamAggregator uses to
          // GROW an existing tool call — which is where `maxToolArgBytes`
          // is enforced. Bloat injected on a fresh-tool-call delta would
          // only trip `maxStreamBytes`, which is a different guard.
          if (
            bloatThisStream &&
            !toolArgsMutated &&
            chunk.type === 'tool_call_delta' &&
            chunk.toolCall !== undefined &&
            chunk.toolCall.arguments !== undefined
          ) {
            const payload = 'x'.repeat(bloatBytes);
            toolArgsMutated = true;
            injected = 'tool-arg-bloat';
            record('tool-arg-bloat', 'stream');
            yield {
              type: 'tool_call_delta',
              toolCall: { ...chunk.toolCall, arguments: payload },
            };
            chunkIndex++;
            continue;
          }

          // Rewrite the FIRST complete tool_call's arguments with invalid
          // JSON. For the streaming path we detect "first" by emitting a
          // mutated tool_call_delta with a closed-looking bad payload.
          if (
            invalidJsonThisStream &&
            !firstToolCallSeen &&
            chunk.type === 'tool_call_delta' &&
            chunk.toolCall?.id !== undefined
          ) {
            firstToolCallSeen = true;
            injected = 'invalid-json';
            record('invalid-json', 'stream');
            yield {
              type: 'tool_call_delta',
              toolCall: { ...chunk.toolCall, arguments: '{not valid json]' },
            };
            chunkIndex++;
            continue;
          }

          yield chunk;
          chunkIndex++;
        }
      } finally {
        if (injected === null) {
          record('clean', 'stream');
        }
      }
    },
  };
}
