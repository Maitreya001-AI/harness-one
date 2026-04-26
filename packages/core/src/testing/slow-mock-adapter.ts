/**
 * `createSlowMockAdapter` — a mock adapter that artificially delays
 * its `chat()` resolution and inter-chunk emission so abort / timeout
 * scenarios are observable in tests.
 *
 * Showcase 04 (orchestration cascade-abort) discovered that abort
 * scheduled at +1ms never landed because the mock chain completed in
 * <1ms — the abort was always too late to interrupt anything. This
 * helper is the canonical way to make abort/timeout scenarios
 * deterministic without touching real network.
 *
 * @module
 */

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
  TokenUsage,
} from '../core/types.js';

export interface SlowMockAdapterConfig {
  /** Static response to return from `chat()`. */
  readonly response: ChatResponse;
  /** Optional override for `stream()` chunks; defaults to `[response.message text, done]`. */
  readonly chunks?: readonly StreamChunk[];
  /** Delay (ms) before `chat()` resolves. Default: 0. */
  readonly chatDelayMs?: number;
  /** Delay (ms) inserted between successive `stream()` chunks. Default: 0. */
  readonly streamChunkDelayMs?: number;
  /**
   * If true (default), the delay is interruptible via the AbortSignal
   * passed to `chat()` / `stream()`. When the signal aborts, the mock
   * rejects/throws with an AbortError that adapters and AgentLoop
   * recognise as a normal cancellation. Set to false to model
   * "stuck adapter that ignores abort".
   */
  readonly respectAbort?: boolean;
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 5, outputTokens: 5 };

/**
 * Build a mock streaming-aware AgentAdapter that takes deterministic
 * time to respond. See {@link SlowMockAdapterConfig}.
 *
 * @example
 * ```ts
 * // Abort fires while the adapter is "thinking" — the run cleanly aborts.
 * const adapter = createSlowMockAdapter({
 *   response: { message: { role: 'assistant', content: 'hi' }, usage },
 *   chatDelayMs: 100,
 * });
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 10);
 * await spawnSubAgent({ adapter, messages, signal: ac.signal });
 * // throws HarnessError(CORE_ABORTED)
 * ```
 */
export function createSlowMockAdapter(
  config: SlowMockAdapterConfig,
): AgentAdapter & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  const respectAbort = config.respectAbort ?? true;
  const chatDelayMs = config.chatDelayMs ?? 0;
  const streamChunkDelayMs = config.streamChunkDelayMs ?? 0;

  const fallbackChunks: readonly StreamChunk[] = config.chunks ?? [
    { type: 'text_delta', text: typeof config.response.message.content === 'string' ? config.response.message.content : '' },
    { type: 'done', usage: config.response.usage ?? DEFAULT_USAGE },
  ];

  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      if (chatDelayMs > 0) {
        await sleep(chatDelayMs, respectAbort ? params.signal : undefined);
      }
      return config.response;
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      calls.push(params);
      for (const chunk of fallbackChunks) {
        if (streamChunkDelayMs > 0) {
          await sleep(streamChunkDelayMs, respectAbort ? params.signal : undefined);
        }
        yield chunk;
      }
    },
  };
}

/**
 * Sleep for `ms` milliseconds. When `signal` is supplied and aborts
 * during the wait, rejects with the standard DOMException-like
 * AbortError shape so AgentLoop's adapter-caller path picks it up as
 * a CORE_ABORTED termination.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(makeAbortError());
    };
    const cleanup = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  const err = new Error('createSlowMockAdapter: aborted via signal');
  err.name = 'AbortError';
  return err;
}
