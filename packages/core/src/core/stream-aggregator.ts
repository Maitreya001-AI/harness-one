/**
 * StreamAggregator — accumulates a streaming adapter response into a single
 * assistant `Message` while emitting per-chunk events.
 *
 * Extracted from `AgentLoop.handleStream` (ARCH-001). The aggregator owns:
 *
 * - `accumulatedText` — concatenated `text_delta` payloads.
 * - `accumulatedToolCalls` — `Map<id, {id,name,arguments}>` for O(1) id lookups.
 * - `toolCallList` — parallel array preserving insertion order so the final
 *   message can be assembled without a `Map.values()` spread.
 * - `accumulatedBytes` — running byte count for per-iteration size limits.
 *
 * Behavioural parity with the historical inline implementation is the
 * extraction's primary contract:
 *
 *   - The same events are emitted in the same order.
 *   - Size-limit errors fire at the same chunk boundary.
 *   - The final assembled `Message` has the same shape (`toolCalls` omitted
 *     when empty rather than set to `[]`).
 *
 * Ownership: the aggregator is intentionally a class with internal mutable
 * state — the streaming hot path is allocation-sensitive (PERF-024 / PERF-032),
 * and a class lets the AgentLoop reuse a single instance (via `reset()`)
 * across iterations should the loop ever choose to.
 *
 * @module
 */

import type { Message, ToolCallRequest, TokenUsage } from './types.js';
import { HarnessError, HarnessErrorCode } from './errors.js';

/**
 * Streaming chunk shape consumed by the aggregator. Mirrors the relevant
 * subset of {@link import('./types.js').StreamChunk} so the aggregator can
 * be unit-tested without an adapter. The `type` widens to `string` so the
 * aggregator can ignore unknown chunk variants without breaking on future
 * additions to the StreamChunk union.
 */
export interface StreamAggregatorChunk {
  readonly type: 'text_delta' | 'tool_call_delta' | 'done' | string;
  readonly text?: string;
  readonly toolCall?: Partial<ToolCallRequest>;
  readonly usage?: TokenUsage;
}

/**
 * Discriminated union of events produced by `handleChunk`. The AgentLoop
 * yields these to its consumer 1:1 (after wrapping `error` events in the
 * standard `AgentEvent` taxonomy).
 */
export type StreamAggregatorEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; toolCall: Partial<ToolCallRequest> }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: Error };

/** Final accumulated state returned by `getMessage()`. */
export interface StreamAggregatorMessage {
  readonly message: Message;
  readonly usage: TokenUsage;
  readonly bytesRead: number;
}

/** Limits configuring stream-size enforcement. */
export interface StreamAggregatorOptions {
  /** Maximum bytes accumulated within this aggregator instance (per-iteration). */
  readonly maxStreamBytes: number;
  /** Maximum bytes per single tool-call's arguments. */
  readonly maxToolArgBytes: number;
  /** Cumulative bytes already read across all prior iterations of the loop. */
  readonly cumulativeStreamBytesSoFar: number;
  /** Cap on cumulative bytes across all iterations combined. */
  readonly maxCumulativeStreamBytes: number;
  /** Maximum number of distinct tool calls per iteration. Default: 128. */
  readonly maxToolCalls?: number;
}

/**
 * Stateful aggregator. Construct once per stream iteration; feed every
 * chunk through `handleChunk()`; collect the final `Message` via
 * `getMessage(usage)`.
 *
 * Aborting / re-using: call `reset()` to discard accumulated state and
 * reuse the instance for another iteration.
 */
/**
 * Internal tool-call accumulator entry. Wave-12 P0-3 swaps the single
 * `arguments: string` (concatenated per chunk) for a `string[]` buffer that
 * is `join('')`-ed lazily inside `getMessage()`, avoiding the O(n²) cost of
 * repeated string concatenation on the streaming hot path.
 */
interface ToolCallEntry {
  id: string;
  name: string;
  readonly argsParts: string[];
  /** Running total of `argsParts` byte length — kept in sync on each push. */
  argsBytes: number;
}

export class StreamAggregator {
  private readonly options: StreamAggregatorOptions;
  /**
   * Wave-12 P0-3: text deltas accumulate into a `string[]` buffer joined
   * lazily inside `getMessage()`. Replaces the O(n²) `accumulatedText +=`.
   */
  private readonly textParts: string[] = [];
  private accumulatedBytes = 0;
  /** Map for O(1) id lookups. Mirrors `toolCallList` exactly. */
  private readonly accumulatedToolCalls: Map<string, ToolCallEntry> = new Map();
  /**
   * Parallel array preserving insertion order so we never need to spread
   * `accumulatedToolCalls.values()` to build the final message (PERF-032).
   */
  private readonly toolCallList: ToolCallEntry[] = [];

  constructor(options: StreamAggregatorOptions) {
    this.options = options;
  }

  /** Total bytes consumed by this aggregator since construction / last reset. */
  get bytesRead(): number {
    return this.accumulatedBytes;
  }

  /**
   * Process a single chunk from the adapter stream.
   *
   * Yields zero, one, or multiple events:
   *  - `text_delta` — passthrough of the chunk's text content.
   *  - `tool_call_delta` — passthrough for downstream visibility.
   *  - `warning` — non-fatal aggregation issue (e.g. tool delta with no id
   *    and no preceding tool call).
   *  - `error` — size limit or other terminal aggregation failure. After
   *    yielding an `error`, the caller MUST stop pumping chunks; subsequent
   *    `handleChunk` calls are still safe but produce undefined message
   *    state.
   *
   * Behavioural parity with the original inline implementation is preserved:
   *   - Per-chunk size checks fire at exactly the same boundaries.
   *   - Tool-call deltas without an id append to the most-recently-seen
   *     tool call (when one exists) or emit a `warning` (when not).
   */
  *handleChunk(chunk: StreamAggregatorChunk): Generator<StreamAggregatorEvent> {
    if (chunk.type === 'text_delta' && chunk.text) {
      this.accumulatedBytes += chunk.text.length;
      const sizeErr = this.checkSizeLimits();
      if (sizeErr) {
        yield { type: 'error', error: sizeErr };
        return;
      }
      // Wave-12 P0-3: buffer; joined lazily in `getMessage()`.
      this.textParts.push(chunk.text);
      yield { type: 'text_delta', text: chunk.text };
      return;
    }

    if (chunk.type === 'tool_call_delta' && chunk.toolCall) {
      const partial = chunk.toolCall;
      yield { type: 'tool_call_delta', toolCall: partial };

      if (partial.arguments) {
        this.accumulatedBytes += partial.arguments.length;
        const sizeErr = this.checkSizeLimits();
        if (sizeErr) {
          yield { type: 'error', error: sizeErr };
          return;
        }
      }

      if (partial.id) {
        const existing = this.accumulatedToolCalls.get(partial.id);
        if (existing) {
          if (partial.name) existing.name = partial.name;
          if (partial.arguments) {
            existing.argsParts.push(partial.arguments);
            existing.argsBytes += partial.arguments.length;
          }
          if (existing.argsBytes > this.options.maxToolArgBytes) {
            yield {
              type: 'error',
              // Wave-13 P0-1: per-call wire-size limits use the dedicated
              // ADAPTER_PAYLOAD_OVERSIZED code rather than the cumulative
              // CORE_TOKEN_BUDGET_EXCEEDED — they are operationally distinct
              // (one is configuration-bound, the other is request-state-bound)
              // and downstream retry/alerting heuristics MUST be able to tell
              // them apart.
              error: new HarnessError(
                `Tool call "${existing.name}" arguments exceeded maximum size (${this.options.maxToolArgBytes} bytes)`,
                HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED,
                'Reduce tool call argument size or increase maxToolArgBytes',
              ),
            };
            return;
          }
        } else {
          // Wave-12 P1-12: Check tool-call count limit BEFORE allocating the
          // new entry — a rogue stream could otherwise allocate thousands of
          // partial entries before the cap fires on the next iteration.
          const maxToolCalls = this.options.maxToolCalls ?? 128;
          if (this.accumulatedToolCalls.size >= maxToolCalls) {
            yield {
              type: 'error',
              // Wave-13 P0-2: a per-iteration configuration cap on tool-call
              // count is an invalid-state condition, NOT a token budget
              // exhaustion. Use CORE_INVALID_STATE so ops dashboards don't
              // lump this into cumulative-budget alerts.
              error: new HarnessError(
                `Exceeded maximum number of tool calls (${maxToolCalls})`,
                HarnessErrorCode.CORE_INVALID_STATE,
                'Reduce the number of tool calls or increase maxToolCalls',
              ),
            };
            return;
          }
          // PERF-024: New tool call — push once into the parallel array so
          // subsequent deltas mutate in place via the map reference.
          const entry: ToolCallEntry = {
            id: partial.id,
            name: partial.name ?? '',
            argsParts: partial.arguments ? [partial.arguments] : [],
            argsBytes: partial.arguments?.length ?? 0,
          };
          this.accumulatedToolCalls.set(partial.id, entry);
          this.toolCallList.push(entry);
        }
        return;
      }

      // No id: append to the most-recent tool call via the parallel array
      // (O(1); avoids `[...map.values()]`).
      if (this.toolCallList.length > 0) {
        const last = this.toolCallList[this.toolCallList.length - 1];
        if (partial.name) last.name = partial.name;
        if (partial.arguments) {
          last.argsParts.push(partial.arguments);
          last.argsBytes += partial.arguments.length;
        }
        if (last.argsBytes > this.options.maxToolArgBytes) {
          yield {
            type: 'error',
            error: new HarnessError(
              `Tool call "${last.name}" arguments exceeded maximum size (${this.options.maxToolArgBytes} bytes)`,
              HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
              'Reduce tool call argument size or increase maxToolArgBytes',
            ),
          };
          return;
        }
      } else {
        yield {
          type: 'warning',
          message: 'Received partial tool call chunk without ID and no accumulated calls',
        };
      }
      return;
    }
    // 'done' chunks carry usage; handled by the caller via `getMessage`.
  }

  /**
   * Build the final assistant message + bytes-read metadata.
   *
   * `toolCalls` is omitted from the message entirely when no tool calls
   * accumulated (preserves prior behaviour where the field was absent rather
   * than `[]`, which downstream observers depend on).
   */
  getMessage(usage: TokenUsage): StreamAggregatorMessage {
    // Wave-12 P0-3: flatten the per-entry `argsParts` buffer into the final
    // `arguments: string` the public `ToolCallRequest` shape mandates. This
    // is the single join per tool call across the whole stream, replacing
    // the O(n²) per-chunk concatenation loop.
    const toolCalls: ToolCallRequest[] =
      this.toolCallList.length === 0
        ? []
        : this.toolCallList.map((e) => ({
            id: e.id,
            name: e.name,
            arguments: e.argsParts.length === 1 ? e.argsParts[0] : e.argsParts.join(''),
          }));
    const message: Message = {
      role: 'assistant',
      content: this.textParts.length === 1 ? this.textParts[0] : this.textParts.join(''),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    return { message, usage, bytesRead: this.accumulatedBytes };
  }

  /** Discard accumulated state; the instance is ready for reuse. */
  reset(): void {
    this.textParts.length = 0;
    this.accumulatedBytes = 0;
    this.accumulatedToolCalls.clear();
    this.toolCallList.length = 0;
  }

  private checkSizeLimits(): HarnessError | null {
    if (this.accumulatedBytes > this.options.maxStreamBytes) {
      return new HarnessError(
        `Stream exceeded maximum size (${this.options.maxStreamBytes} bytes)`,
        HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
        'Reduce response size or increase maxStreamBytes',
      );
    }
    if (
      this.options.cumulativeStreamBytesSoFar + this.accumulatedBytes >
      this.options.maxCumulativeStreamBytes
    ) {
      return new HarnessError(
        'Cumulative stream size exceeded maximum across all iterations',
        HarnessErrorCode.CORE_TOKEN_BUDGET_EXCEEDED,
        'Reduce conversation length or increase maxCumulativeStreamBytes',
      );
    }
    return null;
  }
}
