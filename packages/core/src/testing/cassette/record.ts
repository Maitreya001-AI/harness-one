/**
 * Cassette recorder — wraps a real {@link AgentAdapter} and appends every
 * `chat()` / `stream()` interaction to a JSONL file.
 *
 * Design notes:
 *
 *   - Append-only with one interaction per line so interrupted recordings
 *     leave a usable partial cassette. The reader (`replay.ts`) skips
 *     malformed trailing lines instead of rejecting the file.
 *
 *   - Stream recording materialises the full chunk sequence in memory
 *     before writing. This is safe because cassette fixtures are
 *     intentionally tiny (short prompts, `max_tokens: ~32`). For the
 *     contract suite we prefer to keep file I/O off the hot path of
 *     the stream consumer (no async fs writes between yields).
 *
 *   - Recorded chunks carry an `offsetMs` relative to the start of
 *     `stream()`. Replay uses this only if the caller opts in via the
 *     `simulateTiming` flag — default replay is back-to-back.
 *
 *   - The recorder never catches errors. If the underlying adapter
 *     throws, the error propagates and NO entry is written for that
 *     failing call. Recording error paths deliberately is out of scope
 *     for this layer; a caller who wants that should wrap the adapter
 *     separately.
 *
 * @module
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
} from '../../core/types.js';

import { computeKey, fingerprint } from './key.js';
import type {
  CassetteChatEntry,
  CassetteStreamEntry,
} from './schema.js';

/**
 * Wrap an adapter so every `chat()` / `stream()` call is appended to
 * `cassettePath` as a JSONL entry. Returns a new adapter; the original
 * is left untouched.
 *
 * The wrapper does not deduplicate — two calls with the same request
 * fingerprint produce two cassette entries. Replay will serve them in
 * record order (see `replay.ts`).
 */
export function recordCassette(
  adapter: AgentAdapter,
  cassettePath: string,
): AgentAdapter {
  ensureDir(cassettePath);

  // Capture method references once so we can reference them inside the
  // returned generator without either a non-null assertion (lint noise)
  // or a re-read of `adapter.stream` at call time (risk of the caller
  // monkey-patching the source after wrapping).
  const upstreamStream = adapter.stream?.bind(adapter);
  const upstreamCountTokens = adapter.countTokens?.bind(adapter);

  return {
    ...(adapter.name !== undefined && { name: adapter.name }),
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await adapter.chat(params);
      const fp = fingerprint(params);
      const entry: CassetteChatEntry = {
        version: 1,
        kind: 'chat',
        key: computeKey('chat', fp),
        request: fp,
        response: {
          message: response.message,
          usage: response.usage,
        },
        recordedAtMs: Date.now(),
      };
      append(cassettePath, entry);
      return response;
    },
    ...(upstreamStream !== undefined && {
      async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
        const fp = fingerprint(params);
        const startMs = Date.now();
        const chunks: { offsetMs: number; chunk: StreamChunk }[] = [];
        for await (const chunk of upstreamStream(params)) {
          chunks.push({ offsetMs: Date.now() - startMs, chunk });
          yield chunk;
        }
        const entry: CassetteStreamEntry = {
          version: 1,
          kind: 'stream',
          key: computeKey('stream', fp),
          request: fp,
          chunks,
          recordedAtMs: startMs,
        };
        append(cassettePath, entry);
      },
    }),
    ...(upstreamCountTokens !== undefined && {
      countTokens: upstreamCountTokens,
    }),
  };
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function append(filePath: string, entry: CassetteChatEntry | CassetteStreamEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}
