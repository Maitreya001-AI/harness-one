/**
 * Cassette replayer — loads a JSONL file recorded by
 * {@link recordCassette} and serves responses as a plain {@link AgentAdapter}.
 *
 * Matching semantics:
 *
 *   1. Every recorded entry has a `key` derived from
 *      `computeKey(kind, fingerprint(params))`. Replay recomputes the
 *      key for each incoming request and pops the next matching entry
 *      in record order.
 *
 *   2. "Record order" means each `key` owns an independent FIFO queue.
 *      If the same request was recorded three times, the first three
 *      replay calls serve them in order; the fourth call throws.
 *
 *   3. An unmatched key throws a `HarnessError` with the full request
 *      fingerprint on the `context` side so the diff between
 *      "recorded" and "requested" is obvious in test logs. This is the
 *      single most common failure mode when cassettes drift against a
 *      changing test suite.
 *
 * Replay is synchronous from the caller's perspective — no file I/O
 * happens on the hot path. The cassette is loaded once at
 * `createCassetteAdapter` time.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

import { HarnessError, HarnessErrorCode } from '../../infra/errors-base.js';
import type {
  AgentAdapter,
  ChatParams,
  ChatResponse,
  StreamChunk,
} from '../../core/types.js';

import { computeKey, fingerprint } from './key.js';
import {
  isCassetteEntry,
  type CassetteChatEntry,
  type CassetteEntry,
  type CassetteStreamEntry,
} from './schema.js';

/** Options for {@link createCassetteAdapter}. */
export interface CassetteReplayOptions {
  /**
   * Optional human-readable label reported in the adapter's `name`
   * field and surfaced on error messages. Defaults to the cassette
   * filename when omitted.
   */
  readonly name?: string;
  /**
   * When `true`, yield each recorded stream chunk after the original
   * `offsetMs` delay. Off by default — contract tests want determinism
   * and speed, not realistic cadence.
   */
  readonly simulateTiming?: boolean;
}

/**
 * Load a cassette file from disk and return an {@link AgentAdapter}
 * that serves recorded responses.
 */
export function createCassetteAdapter(
  cassettePath: string,
  opts: CassetteReplayOptions = {},
): AgentAdapter {
  const entries = loadCassette(cassettePath);
  // Per-key FIFO queue, so repeated identical calls are served in
  // record order and the harness can tell "exhausted" apart from
  // "never recorded" in error messages.
  const queues = new Map<string, CassetteEntry[]>();
  for (const entry of entries) {
    let q = queues.get(entry.key);
    if (!q) {
      q = [];
      queues.set(entry.key, q);
    }
    q.push(entry);
  }

  const name = opts.name ?? `cassette:${shortLabel(cassettePath)}`;

  return {
    name,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const fp = fingerprint(params);
      const key = computeKey('chat', fp);
      const entry = popEntry(queues, key, 'chat', fp, cassettePath);
      if (entry.kind !== 'chat') {
        throw cassetteMismatch(
          `Cassette entry for key ${key} is a stream, but chat() was called`,
          cassettePath,
          fp,
        );
      }
      return {
        message: entry.response.message,
        usage: entry.response.usage,
      };
    },
    async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
      const fp = fingerprint(params);
      const key = computeKey('stream', fp);
      const entry = popEntry(queues, key, 'stream', fp, cassettePath);
      if (entry.kind !== 'stream') {
        throw cassetteMismatch(
          `Cassette entry for key ${key} is a chat response, but stream() was called`,
          cassettePath,
          fp,
        );
      }
      const started = Date.now();
      for (const { offsetMs, chunk } of entry.chunks) {
        if (params.signal?.aborted) {
          const reason = params.signal.reason;
          throw reason instanceof Error
            ? reason
            : new HarnessError(
                'Cassette stream aborted via signal',
                HarnessErrorCode.CORE_ABORTED,
                'Caller aborted while the cassette was replaying',
              );
        }
        if (opts.simulateTiming) {
          const target = started + offsetMs;
          const wait = target - Date.now();
          if (wait > 0) await delay(wait, params.signal);
        }
        yield chunk;
      }
    },
  };
}

/**
 * Reads a cassette from disk into memory, skipping blank and malformed
 * lines. Malformed lines are tolerated so an in-progress append (or a
 * trailing newline) does not break replay.
 */
export function loadCassette(cassettePath: string): CassetteEntry[] {
  const raw = readFileSync(cassettePath, 'utf8');
  const entries: CassetteEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Tolerate a corrupt final line from an interrupted append.
      // Earlier lines that fail to parse are likely bit rot and we
      // prefer a loud failure there.
      if (i === lines.length - 1) continue;
      throw new HarnessError(
        `Cassette ${cassettePath} has malformed JSON on line ${i + 1}`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Delete the line or re-record the cassette',
      );
    }
    if (!isCassetteEntry(parsed)) {
      throw new HarnessError(
        `Cassette ${cassettePath} line ${i + 1} does not match the expected schema`,
        HarnessErrorCode.CORE_INVALID_CONFIG,
        'Delete the line or re-record the cassette',
      );
    }
    entries.push(parsed);
  }
  return entries;
}

function popEntry(
  queues: Map<string, CassetteEntry[]>,
  key: string,
  kind: 'chat' | 'stream',
  fp: unknown,
  cassettePath: string,
): CassetteChatEntry | CassetteStreamEntry {
  const q = queues.get(key);
  if (!q || q.length === 0) {
    throw cassetteMismatch(
      q
        ? `Cassette queue for key ${key} is exhausted (more ${kind}() calls than recorded)`
        : `No cassette entry matches key ${key} for ${kind}()`,
      cassettePath,
      fp,
    );
  }
  return q.shift() as CassetteChatEntry | CassetteStreamEntry;
}

function cassetteMismatch(message: string, cassettePath: string, fp: unknown): HarnessError {
  return new HarnessError(
    `${message} — cassette: ${cassettePath}\nrequest: ${JSON.stringify(fp).slice(0, 500)}`,
    HarnessErrorCode.CORE_INVALID_STATE,
    'Re-record the cassette or check that the test request matches the recording',
  );
}

function shortLabel(path: string): string {
  const ix = path.lastIndexOf('/');
  return ix === -1 ? path : path.slice(ix + 1);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => resolvePromise(), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(
        new HarnessError(
          'Cassette stream aborted via signal',
          HarnessErrorCode.CORE_ABORTED,
          'Caller aborted while the cassette was replaying',
        ),
      );
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
