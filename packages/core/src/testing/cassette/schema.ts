/**
 * Versioned on-disk schema for adapter cassettes.
 *
 * A cassette is a newline-delimited JSON (JSONL) file. Every line is a
 * self-contained {@link CassetteEntry} — no file header, no leading
 * metadata — so that:
 *   1. `record()` can append to a cassette mid-test without rewriting it,
 *   2. a corrupt/truncated final line fails ONLY that entry's replay and
 *      does not blast the rest of the suite, and
 *   3. the file can be grep'd / eyeballed without parsing the whole thing.
 *
 * Every entry carries its own `version` field so individual lines can be
 * migrated in place. Readers MUST reject lines whose `version` is outside
 * {@link SUPPORTED_VERSIONS} rather than silently interpreting a future
 * shape under today's schema.
 *
 * @module
 */

import type { Message, StreamChunk, TokenUsage } from '../../core/types.js';

/**
 * Schema versions this package is willing to read. When adding a new
 * version, keep the previous number in this tuple until a migration lands
 * in `replay.ts` so old cassettes stay readable across one release.
 */
export const SUPPORTED_VERSIONS = [1] as const;

export type CassetteVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Request fingerprint recorded on every entry. The hash of this object
 * (see `computeKey`) is the lookup key during replay. Only semantically
 * significant fields are included — `signal` and internal metadata are
 * deliberately excluded so the same logical request hashes stably across
 * runs.
 */
export interface CassetteRequestFingerprint {
  readonly messages: readonly {
    readonly role: Message['role'];
    readonly content: string;
    readonly toolCallId?: string;
    readonly toolCalls?: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }[];
  }[];
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
  readonly config?: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxTokens?: number;
    readonly stopSequences?: readonly string[];
  };
  readonly responseFormat?: unknown;
}

/** One non-streaming chat interaction captured in a cassette. */
export interface CassetteChatEntry {
  readonly version: CassetteVersion;
  readonly kind: 'chat';
  readonly key: string;
  readonly request: CassetteRequestFingerprint;
  readonly response: {
    readonly message: Message;
    readonly usage: TokenUsage;
  };
  /**
   * Absolute wall-clock millis at record time. Advisory only; replay does
   * not depend on it. Useful when diffing re-recorded cassettes to see
   * which entries are stale.
   */
  readonly recordedAtMs: number;
}

/** One streaming chat interaction captured in a cassette. */
export interface CassetteStreamEntry {
  readonly version: CassetteVersion;
  readonly kind: 'stream';
  readonly key: string;
  readonly request: CassetteRequestFingerprint;
  /**
   * Ordered list of emitted chunks. Each chunk records its millis offset
   * from the start of the stream so replay can optionally honour real
   * SSE cadence (useful for timing-sensitive assertions). Default replay
   * emits back-to-back with no delay.
   */
  readonly chunks: readonly {
    readonly offsetMs: number;
    readonly chunk: StreamChunk;
  }[];
  readonly recordedAtMs: number;
}

export type CassetteEntry = CassetteChatEntry | CassetteStreamEntry;

/**
 * Type guard for runtime-validated entries — used by `replay.ts` to narrow
 * unknown-shaped JSON after parsing.
 *
 * Kept intentionally lenient on nested shapes: the cassette on disk is
 * trusted, and over-validating would slow replay down and drown real bugs
 * in shape noise. We check only that:
 *   - version is supported,
 *   - kind is one we handle,
 *   - key is a non-empty string,
 *   - request and (response | chunks) exist.
 */
export function isCassetteEntry(value: unknown): value is CassetteEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<CassetteEntry>;
  if (typeof e.key !== 'string' || e.key.length === 0) return false;
  if (typeof e.version !== 'number' || !(SUPPORTED_VERSIONS as readonly number[]).includes(e.version)) return false;
  if (typeof e.request !== 'object' || e.request === null) return false;
  if (e.kind === 'chat') {
    const resp = (e as CassetteChatEntry).response;
    return typeof resp === 'object' && resp !== null;
  }
  if (e.kind === 'stream') {
    const chunks = (e as CassetteStreamEntry).chunks;
    return Array.isArray(chunks);
  }
  return false;
}
