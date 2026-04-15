/**
 * Error classification for adapter errors.
 *
 * Extracted from AgentLoop to keep the core loop focused on orchestration.
 *
 * @module
 */

import { HarnessError, HarnessErrorCode} from './errors.js';

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
 * - `'ADAPTER_NETWORK'` — timeout / connection refused / network / fetch
 * - `'ADAPTER_PARSE'` — parse / JSON / malformed
 * - `'ADAPTER_ERROR'` — fallback for unrecognized errors
 *
 * @param err - The error to classify (may be any value)
 */
export function categorizeAdapterError(err: unknown): HarnessErrorCode {
  // T10 (Wave-5A): guardrail hard-block takes priority over message-based
  // heuristics — the structured error code is the authoritative signal.
  // GUARDRAIL_VIOLATION is NEVER retryable; callers should not add this
  // category to their `retryableErrors` allow-list.
  if (err instanceof HarnessError && err.code === HarnessErrorCode.GUARD_VIOLATION) {
    return HarnessErrorCode.GUARD_VIOLATION;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (msg.includes('rate') || msg.includes('429') || msg.includes('too many')) return HarnessErrorCode.ADAPTER_RATE_LIMIT;
  if (msg.includes('auth') || msg.includes('401') || msg.includes('api key') || msg.includes('unauthorized')) return HarnessErrorCode.ADAPTER_AUTH;
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch')) return HarnessErrorCode.ADAPTER_NETWORK;
  if (msg.includes('parse') || msg.includes('json') || msg.includes('malformed')) return HarnessErrorCode.ADAPTER_PARSE;
  return HarnessErrorCode.ADAPTER_ERROR;
}
