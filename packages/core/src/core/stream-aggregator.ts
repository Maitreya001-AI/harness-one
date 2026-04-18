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
 * Outcome of a single-chunk UTF-8 byte-length measurement.
 *
 * `bytes` is the count for the input string under the given pending-high
 * continuation; `pendingHigh` carries the trailing unpaired high surrogate
 * (if any) so the caller can thread it into the next chunk and finish the
 * pair. See {@link measureUtf8} for the pair-completion rule.
 */
interface Utf8Measure {
  readonly bytes: number;
  readonly pendingHigh: boolean;
}

/**
 * UTF-8 byte length of `s` without allocating a `Buffer` or `TextEncoder` in
 * the hot path. Ten times faster than `Buffer.byteLength(s, 'utf8')` on short
 * strings while matching its result bit-for-bit for the whole BMP +
 * surrogate-pair range.
 *
 * The previous implementation used `s.length`, which counts UTF-16 code
 * units. CJK / emoji content doubles or quadruples its byte size once it
 * leaves Node, so a 5 MB `maxStreamBytes` budget expressed as code units
 * effectively became a 10–20 MB budget. Switching to UTF-8 bytes makes
 * `maxStreamBytes` / `maxToolArgBytes` match what the docstring says.
 *
 * **Cross-chunk surrogate handling.** A supplementary codepoint
 * (emoji / CJK extension) is two UTF-16 code units (high surrogate +
 * low surrogate). Adapters that split streaming text at arbitrary JS
 * string positions can land a chunk boundary between the two halves:
 *
 *   chunk N    = "\uD83D"   (lone high surrogate)
 *   chunk N+1  = "\uDE00"   (lone low surrogate → paired with prior)
 *
 * A naive per-chunk counter overcounts: the high surrogate claims 4 bytes
 * thinking its paired low is "already seen", then the orphan low on the
 * next chunk falls into the "else" 3-byte branch, reaching 7 bytes for
 * what is a single 4-byte UTF-8 codepoint. We thread a `pendingHigh` flag
 * through the measurement so a pair completed across a boundary counts
 * 4 bytes total (0 for the high on chunk N, 4 for the low on chunk N+1
 * once the pair resolves).
 *
 * Lone surrogates (high without a low, or low without a high) encode as
 * the U+FFFD replacement character in `Buffer.byteLength` / `TextEncoder`
 * — 3 bytes each. This helper matches that behaviour to stay byte-for-byte
 * consistent with the wire format downstream serialisers produce.
 */
function measureUtf8(s: string, priorPendingHigh: boolean): Utf8Measure {
  let bytes = 0;
  let i = 0;
  let pendingHigh = priorPendingHigh;

  if (pendingHigh && s.length > 0) {
    const first = s.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) {
      // Pair completes across the chunk boundary: full supplementary
      // codepoint is 4 UTF-8 bytes. The high surrogate on the prior chunk
      // contributed 0; we pay all 4 here.
      bytes += 4;
      i = 1;
      pendingHigh = false;
    } else {
      // Prior chunk's trailing high was orphan — encode as U+FFFD (3 bytes)
      // to match Buffer.byteLength / TextEncoder behaviour on lone surrogates.
      bytes += 3;
      pendingHigh = false;
      // Fall through without advancing i — s[0] still needs classification.
    }
  }

  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
      i++;
    } else if (code < 0x800) {
      bytes += 2;
      i++;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate. Try to pair with the next code unit in this chunk.
      if (i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i += 2;
          continue;
        }
        // High followed by non-low in the same chunk: lone high → U+FFFD.
        bytes += 3;
        i++;
        continue;
      }
      // High is the last code unit of this chunk — stash for pair
      // completion on the next chunk. No bytes counted yet; if the next
      // chunk does not start with a low, the prior branch above will
      // charge 3 bytes for the replacement character.
      pendingHigh = true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (no preceding pending high consumed it) → U+FFFD.
      bytes += 3;
      i++;
    } else {
      bytes += 3;
      i++;
    }
  }

  return { bytes, pendingHigh };
}

/**
 * Streaming chunk shape consumed by the aggregator. Mirrors the relevant
 * subset of {@link StreamChunk} so the aggregator can
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
  /**
   * Wave-27: per-tool pending high surrogate so two successive deltas on
   * the same tool-call id that happen to split a supplementary codepoint
   * are accounted as 4 bytes end-to-end rather than 7.
   */
  pendingHighSurrogate: boolean;
}

export class StreamAggregator {
  private readonly options: StreamAggregatorOptions;
  /**
   * Wave-12 P0-3: text deltas accumulate into a `string[]` buffer joined
   * lazily inside `getMessage()`. Replaces the O(n²) `accumulatedText +=`.
   */
  private readonly textParts: string[] = [];
  private accumulatedBytes = 0;
  /**
   * Wave-27: carries an unpaired high surrogate from the previous
   * `text_delta` chunk so a supplementary codepoint split across a chunk
   * boundary is counted as 4 bytes (not 7). See {@link measureUtf8}.
   *
   * Scoped to the text_delta stream — tool-call deltas are accounted
   * separately via per-tool pending flags so a high surrogate trailing one
   * tool's args cannot "pair" with a low surrogate arriving on a different
   * tool's delta.
   */
  private textPendingHighSurrogate = false;
  /** Map for O(1) id lookups. Mirrors `toolCallList` exactly. */
  private readonly accumulatedToolCalls: Map<string, ToolCallEntry> = new Map();
  /**
   * Parallel array preserving insertion order so we never need to spread
   * `accumulatedToolCalls.values()` to build the final message (PERF-032).
   */
  private readonly toolCallList: ToolCallEntry[] = [];
  /**
   * Wave-27: pending high surrogate for the "append-to-last-tool" path
   * where deltas arrive without an id. Kept separate from the per-tool
   * pending flag on `ToolCallEntry` so both routes stay correct without
   * cross-contamination.
   */
  private lastToolPendingHighSurrogate = false;

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
      // Wave-27: thread pending-high-surrogate across text_delta chunks so
      // a supplementary codepoint split mid-pair counts 4 bytes (not 7).
      const measure = measureUtf8(chunk.text, this.textPendingHighSurrogate);
      this.accumulatedBytes += measure.bytes;
      this.textPendingHighSurrogate = measure.pendingHigh;
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

      // Pick the pending-high-surrogate state that would pair with this
      // delta's args. With-id deltas use the per-entry flag on the tool
      // call; no-id deltas append to the last tool, so they use the
      // sibling "last tool pending high" flag. The two flags are reset
      // independently in `reset()` and on size-limit failures.
      const withExistingId = partial.id !== undefined
        ? this.accumulatedToolCalls.get(partial.id)
        : undefined;
      let priorArgsPendingHigh = false;
      if (partial.id !== undefined) {
        priorArgsPendingHigh = withExistingId?.pendingHighSurrogate ?? false;
      } else if (this.toolCallList.length > 0) {
        priorArgsPendingHigh = this.lastToolPendingHighSurrogate;
      }

      const argsMeasure = partial.arguments !== undefined
        ? measureUtf8(partial.arguments, priorArgsPendingHigh)
        : { bytes: 0, pendingHigh: priorArgsPendingHigh };
      const partialArgsBytes = argsMeasure.bytes;
      if (partial.arguments) {
        this.accumulatedBytes += partialArgsBytes;
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
            existing.argsBytes += partialArgsBytes;
          }
          existing.pendingHighSurrogate = argsMeasure.pendingHigh;
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
            argsBytes: partialArgsBytes,
            pendingHighSurrogate: argsMeasure.pendingHigh,
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
          last.argsBytes += partialArgsBytes;
        }
        this.lastToolPendingHighSurrogate = argsMeasure.pendingHigh;
        if (last.argsBytes > this.options.maxToolArgBytes) {
          yield {
            type: 'error',
            // Per-call wire-size limits are operationally distinct from
            // cumulative budget exhaustion. Match the WITH-ID path above
            // — both paths must use ADAPTER_PAYLOAD_OVERSIZED so
            // downstream retry/alert heuristics classify them identically.
            error: new HarnessError(
              `Tool call "${last.name}" arguments exceeded maximum size (${this.options.maxToolArgBytes} bytes)`,
              HarnessErrorCode.ADAPTER_PAYLOAD_OVERSIZED,
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
    // Wave-27: cross-chunk surrogate state is per-stream; clear on reuse.
    this.textPendingHighSurrogate = false;
    this.lastToolPendingHighSurrogate = false;
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
