/**
 * Error classification for adapter errors.
 *
 * Extracted from AgentLoop to keep the core loop focused on orchestration.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from './errors.js';

/**
 * Pattern for HTTP 5xx / upstream-unavailable signals.
 *
 * Matches:
 * - Stand-alone 5xx status codes (bounded by whitespace / start-of-string / end-
 *   of-string) — avoids false-positives on random numeric substrings.
 * - Human-readable phrases: "bad gateway", "service unavailable",
 *   "gateway timeout" (with `-`, `_`, or space separators).
 */
const UNAVAILABLE_RE = /(^|[\s:])5\d\d(\s|$|:)|bad[\s_-]?gateway|service[\s_-]?unavailable|gateway[\s_-]?timeout/i;

/**
 * Pre-compiled regex unions for the remaining classifier categories.
 * A single regex test per category replaces sequential `.includes()`
 * scans. Classification ORDER is load-bearing: the first match wins,
 * so branching order (rate-limit → auth → unavailable → network →
 * parse) matches the documented priority.
 */
const RATE_LIMIT_RE = /rate|429|too many/i;
const AUTH_RE = /auth|401|api key|unauthorized/i;
const NETWORK_RE = /timeout|econnrefused|network|fetch/i;
const PARSE_RE = /parse|json|malformed/i;

/**
 * Optional logger shape consumed for silent-fallback visibility.
 * Debug-level only — not every unclassified error is actionable.
 */
interface ClassifierLogger {
  readonly debug?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Classify an adapter error into a category string based on its message content.
 *
 * Returns one of:
 * - `HarnessErrorCode.GUARD_VIOLATION` — hard-block raised by a guardrail pipeline.
 *   This category is **non-retryable by default**: the default
 *   `retryableErrors` set in `AgentLoop` is `['ADAPTER_RATE_LIMIT']`, so a
 *   GUARDRAIL_VIOLATION never enters the retry loop. Retrying a blocked
 *   input would just hit the same guard again and waste budget.
 * - `'ADAPTER_RATE_LIMIT'` — rate limit / 429 / too many requests
 * - `'ADAPTER_AUTH'` — authentication / 401 / API key / unauthorized
 * - `'ADAPTER_UNAVAILABLE'` — 502/503/504 / bad gateway / service unavailable /
 *   gateway timeout (transient upstream failure — canonical back-off signal)
 * - `'ADAPTER_NETWORK'` — timeout / connection refused / network / fetch
 * - `'ADAPTER_PARSE'` — parse / JSON / malformed
 * - `'ADAPTER_ERROR'` — fallback for unrecognized errors
 *
 * @param err - The error to classify (may be any value)
 * @param logger - Optional structured logger; emits a
 *   `debug('adapter error not classified', {...})` on the fallback path so
 *   operators can surface previously-silent unknown errors without noise.
 */
export function categorizeAdapterError(err: unknown, logger?: ClassifierLogger): HarnessErrorCode {
  // Guardrail hard-block takes priority over message-based heuristics —
  // the structured error code is the authoritative signal.
  // GUARDRAIL_VIOLATION is NEVER retryable; callers should not add this
  // category to their `retryableErrors` allow-list.
  if (err instanceof HarnessError && err.code === HarnessErrorCode.GUARD_VIOLATION) {
    return HarnessErrorCode.GUARD_VIOLATION;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  // First match wins; order of branches is load-bearing.
  if (RATE_LIMIT_RE.test(msg)) return HarnessErrorCode.ADAPTER_RATE_LIMIT;
  if (AUTH_RE.test(msg)) return HarnessErrorCode.ADAPTER_AUTH;
  // 5xx upstream-unavailable takes priority over the generic
  // `timeout`/`fetch` network bucket because "gateway timeout" would otherwise
  // fall through to ADAPTER_NETWORK (which is NOT in the default retry list).
  if (UNAVAILABLE_RE.test(msg)) return HarnessErrorCode.ADAPTER_UNAVAILABLE;
  if (NETWORK_RE.test(msg)) return HarnessErrorCode.ADAPTER_NETWORK;
  if (PARSE_RE.test(msg)) return HarnessErrorCode.ADAPTER_PARSE;
  // Surface the silent-fallback case at debug-level so ops can tell
  // "classifier didn't recognise this message" apart from "adapter
  // explicitly returned ADAPTER_ERROR". Slice to 200 chars to keep log
  // lines bounded on pathological stack traces.
  logger?.debug?.('adapter error not classified', {
    error_message: msg.slice(0, 200),
  });
  return HarnessErrorCode.ADAPTER_ERROR;
}
