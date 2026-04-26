/**
 * Testing utilities — mock adapters and helpers for writing agent tests.
 *
 * Consolidates duplicated mock adapter patterns that previously appeared
 * across 6+ test files into a single reusable testkit.
 *
 * Published as the `harness-one/testing` subpath. Previously
 * re-exported from `harness-one/advanced`, which mis-signalled "production
 * extension point" to adapter authors — the factories here are mock doubles
 * for **test code only** and intentionally live on their own subpath so
 * production bundles do not pull them in by default and so the naming in
 * `package.json` matches the intent (`testing` = test-only; `advanced` =
 * composable production primitives).
 *
 * @module
 */

import type { AgentAdapter, AssistantMessage, ChatParams, ChatResponse, Message, StreamChunk, TokenUsage } from '../core/types.js';

/** Configuration for the mock adapter. */
export interface MockAdapterConfig {
  /** Ordered list of responses the mock will return. The last response repeats. */
  responses: Array<{ content: string; toolCalls?: AssistantMessage['toolCalls'] }>;
  /** Token usage returned per call. Default: `{ inputTokens: 10, outputTokens: 5 }`. */
  usage?: TokenUsage;
}

/**
 * Create a mock AgentAdapter that returns pre-configured responses.
 *
 * The returned adapter includes a `calls` array capturing every ChatParams
 * it received, enabling assertions on what was sent to the LLM.
 *
 * @example
 * ```ts
 * const adapter = createMockAdapter({
 *   responses: [
 *     { content: 'Hello!' },
 *     { content: 'Tool result', toolCalls: [{ id: '1', name: 'search', arguments: '{}' }] },
 *   ],
 * });
 * const response = await adapter.chat({ messages: [] });
 * expect(adapter.calls).toHaveLength(1);
 * ```
 */
export function createMockAdapter(
  config: MockAdapterConfig,
): AgentAdapter & { calls: ChatParams[] } {
  let responseIndex = 0;
  const calls: ChatParams[] = [];
  const usage: TokenUsage = config.usage ?? { inputTokens: 10, outputTokens: 5 };

  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      const resp = config.responses[Math.min(responseIndex++, config.responses.length - 1)];
      const message: Message = {
        role: 'assistant',
        content: resp.content,
        ...(resp.toolCalls ? { toolCalls: resp.toolCalls } : {}),
      };
      return { message, usage };
    },
  };
}

/**
 * Create a mock adapter that always throws the given error.
 * Useful for testing failure paths and fallback behaviour.
 *
 * @example
 * ```ts
 * const adapter = createFailingAdapter(new Error('provider down'));
 * await expect(adapter.chat({ messages: [] })).rejects.toThrow('provider down');
 * ```
 */
export function createFailingAdapter(
  error?: Error | string,
): AgentAdapter & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  const err = typeof error === 'string' ? new Error(error) : (error ?? new Error('Mock adapter failure'));
  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      throw err;
    },
  };
}

/**
 * Create a mock streaming adapter that yields pre-configured chunks.
 *
 * **Usage propagation contract**:
 *
 * Real streaming providers attach a `usage` payload to the terminal
 * `done` chunk; AgentLoop's cumulative usage / cost tracker depend on
 * that. To prevent the silent zero-metrics failure mode that bit
 * showcase 01 (FRICTION_LOG `createStreamingMockAdapter doesn't
 * auto-attach usage to done`), this helper:
 *
 *  1. **Auto-attaches `config.usage`** to any terminal `done` chunk
 *     the caller passed *without* a `usage` field. The auto-attach is
 *     non-destructive: chunks that already carry `usage` are passed
 *     through verbatim.
 *  2. **Throws at construction time** when neither the terminal
 *     `done` chunk nor `config.usage` provides a usage value — the
 *     resulting adapter would silently report zero tokens, which is
 *     a footgun for cost-related test assertions.
 *
 * @example
 * ```ts
 * // Caller supplies config.usage; auto-attached to the terminal done.
 * const adapter = createStreamingMockAdapter({
 *   usage: { inputTokens: 10, outputTokens: 5 },
 *   chunks: [
 *     { type: 'text_delta', text: 'Hello' },
 *     { type: 'text_delta', text: ' world' },
 *     { type: 'done' },
 *   ],
 * });
 * ```
 *
 * @example
 * ```ts
 * // Per-chunk usage takes precedence — useful for varying per-call.
 * const adapter = createStreamingMockAdapter({
 *   chunks: [
 *     { type: 'text_delta', text: 'x' },
 *     { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
 *   ],
 * });
 * ```
 */
export function createStreamingMockAdapter(config: {
  chunks: StreamChunk[];
  usage?: TokenUsage;
}): AgentAdapter & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];

  // Walk the chunks and detect the contract violation: terminal `done`
  // without usage AND no fallback `config.usage`. We do this at
  // construction time so the loud failure happens as soon as a test
  // wires the adapter, not at first call.
  const lastDone = findLastDoneChunk(config.chunks);
  const fallbackUsage = config.usage;
  const lastDoneHasUsage = lastDone !== undefined && hasUsageField(lastDone);

  if (lastDone !== undefined && !lastDoneHasUsage && fallbackUsage === undefined) {
    throw new Error(
      'createStreamingMockAdapter: terminal `done` chunk has no `usage` and `config.usage` is also undefined. '
        + 'AgentLoop will report zero tokens / $0 cost, silently breaking any cost-related assertions. '
        + 'Pass `config.usage = { inputTokens, outputTokens }` for the auto-attach fallback, '
        + 'or set `usage` directly on the terminal done chunk.',
    );
  }

  // Effective usage value used for both `chat()` non-streaming response
  // and the auto-attach to a usage-less terminal `done`. Once we get
  // here, at least one of the two sources has supplied the value.
  const effectiveUsage: TokenUsage = lastDoneHasUsage
    ? (lastDone as { usage: TokenUsage }).usage
    : (fallbackUsage as TokenUsage);

  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      // Collect text from chunks to build a chat response.
      const text = config.chunks
        .filter((c) => c.type === 'text_delta' && c.text)
        .map((c) => c.text)
        .join('');
      return {
        message: { role: 'assistant', content: text },
        usage: effectiveUsage,
      };
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      calls.push(params);
      for (const chunk of config.chunks) {
        // Auto-attach usage to the terminal `done` if the caller
        // didn't supply one. Non-terminal `done` chunks (rare) and
        // any chunk that already carries usage pass through unchanged.
        if (chunk === lastDone && !lastDoneHasUsage && fallbackUsage !== undefined) {
          yield { ...chunk, usage: fallbackUsage } as StreamChunk;
        } else {
          yield chunk;
        }
      }
    },
  };
}

function findLastDoneChunk(chunks: readonly StreamChunk[]): StreamChunk | undefined {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].type === 'done') return chunks[i];
  }
  return undefined;
}

function hasUsageField(chunk: StreamChunk): boolean {
  return (chunk as { usage?: unknown }).usage !== undefined;
}

/**
 * Create a streaming adapter that yields some chunks then throws an error.
 * Useful for testing partial-stream error recovery.
 *
 * @example
 * ```ts
 * const adapter = createErrorStreamingMockAdapter({
 *   chunksBeforeError: [{ type: 'text_delta', text: 'partial' }],
 *   error: new Error('connection reset'),
 * });
 * ```
 */
export function createErrorStreamingMockAdapter(config: {
  chunksBeforeError: StreamChunk[];
  error: Error;
}): AgentAdapter & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      throw config.error;
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      calls.push(params);
      for (const chunk of config.chunksBeforeError) {
        yield chunk;
      }
      throw config.error;
    },
  };
}
