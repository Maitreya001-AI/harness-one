/**
 * Stable lookup-key derivation for cassette entries.
 *
 * The key hashes the semantically significant slice of a `ChatParams`
 * request: messages, tools, core config (temperature/topP/maxTokens/
 * stopSequences), and responseFormat. Non-deterministic or non-content
 * fields — `signal`, per-request logger options, provider-specific
 * `extra` passthrough — are EXCLUDED so the same logical request hashes
 * identically across runs, machines, and SDK versions.
 *
 * Excluding `extra` is a deliberate trade-off: a caller who changes
 * `extra` shape between record and replay will get a cache hit on a
 * cassette recorded with different provider params. The alternative —
 * including `extra` in the hash — means that bumping an SDK version
 * that adds a harmless default value invalidates every cassette. The
 * former is detectable by the diff-on-drift workflow; the latter is a
 * maintenance pit. Contract callers who care MUST record and replay
 * with the same `extra`.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { ChatParams } from '../../core/types.js';

import type { CassetteRequestFingerprint } from './schema.js';

/**
 * Extract the part of a `ChatParams` that identifies the request. The
 * returned object is the canonical "fingerprint" — same value → same
 * hash → same cassette entry.
 */
export function fingerprint(params: ChatParams): CassetteRequestFingerprint {
  const messages = params.messages.map((m) => {
    const base: {
      role: typeof m.role;
      content: string;
      toolCallId?: string;
      toolCalls?: readonly { id: string; name: string; arguments: string }[];
    } = { role: m.role, content: m.content };
    if (m.role === 'tool') base.toolCallId = m.toolCallId;
    if (m.role === 'assistant' && m.toolCalls !== undefined) {
      base.toolCalls = m.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));
    }
    return base;
  });

  const tools = params.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // Only the semantically-meaningful config fields make it into the hash.
  // `extra` and `signal` are deliberately excluded — see module docstring.
  const c = params.config;
  const config =
    c !== undefined
      ? {
          ...(c.temperature !== undefined && { temperature: c.temperature }),
          ...(c.topP !== undefined && { topP: c.topP }),
          ...(c.maxTokens !== undefined && { maxTokens: c.maxTokens }),
          ...(c.stopSequences !== undefined && { stopSequences: c.stopSequences }),
        }
      : undefined;

  return {
    messages,
    ...(tools !== undefined && { tools }),
    ...(config !== undefined && Object.keys(config).length > 0 && { config }),
    ...(params.responseFormat !== undefined && { responseFormat: params.responseFormat }),
  };
}

/**
 * Serialise a fingerprint with stable property ordering, then hash.
 *
 * `JSON.stringify` preserves insertion order in modern engines, but the
 * fingerprint factories above produce that order directly — so we don't
 * need to additionally sort keys. If you ever add new top-level fields,
 * place them in a deterministic position and update this comment.
 */
export function computeKey(kind: 'chat' | 'stream', fp: CassetteRequestFingerprint): string {
  const payload = JSON.stringify({ kind, fp });
  // 16 hex chars of sha-256 = 64 bits, ~10^19 — plenty of headroom against
  // collision in a cassette file with O(100) entries, and keeps keys
  // human-scannable in diffs.
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
