/**
 * Error classification for adapter errors.
 *
 * Extracted from AgentLoop to keep the core loop focused on orchestration.
 *
 * @module
 */

/**
 * Classify an adapter error into a category string based on its message content.
 *
 * Returns one of:
 * - `'ADAPTER_RATE_LIMIT'` — rate limit / 429 / too many requests
 * - `'ADAPTER_AUTH'` — authentication / 401 / API key / unauthorized
 * - `'ADAPTER_NETWORK'` — timeout / connection refused / network / fetch
 * - `'ADAPTER_PARSE'` — parse / JSON / malformed
 * - `'ADAPTER_ERROR'` — fallback for unrecognized errors
 *
 * @param err - The error to classify (may be any value)
 */
export function categorizeAdapterError(err: unknown): string {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (msg.includes('rate') || msg.includes('429') || msg.includes('too many')) return 'ADAPTER_RATE_LIMIT';
  if (msg.includes('auth') || msg.includes('401') || msg.includes('api key') || msg.includes('unauthorized')) return 'ADAPTER_AUTH';
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch')) return 'ADAPTER_NETWORK';
  if (msg.includes('parse') || msg.includes('json') || msg.includes('malformed')) return 'ADAPTER_PARSE';
  return 'ADAPTER_ERROR';
}
