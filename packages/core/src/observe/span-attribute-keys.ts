/**
 * ARCH-009: Reserved span-attribute prefixes + built-in key vocabulary.
 *
 * Span attributes whose key matches neither a reserved prefix nor a known
 * short name produce a one-time warning so consumers can either rename the
 * key to `user.*` (opting out) or request a new reserved prefix upstream.
 *
 * Extracted from `trace-manager.ts` as a self-contained unit so the factory
 * body stays focused on trace state.
 *
 * @module
 * @internal
 */

import type { Logger } from './logger.js';

/** Prefixes the library itself owns. Anything else should use `user.*`. */
export const RESERVED_PREFIXES: readonly string[] = [
  'system.',
  'error.',
  'cost.',
  'user.',
  'harness.',
  'eviction.',
  'chunk.',
];

/** Bare keys the library emits without a prefix. Grandfathered, read-only. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'iteration', 'attempt', 'model', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'path', 'latencyMs', 'passed',
  'verdict', 'reason', 'events', 'parentId', 'errorCategory',
  'errorMessage', 'errorName', 'error', 'streaming', 'conversationLength',
  'adapter', 'toolCount', 'toolName', 'toolCallId', 'input', 'output',
  'usage', 'metadata', 'status', 'spanCount', 'message',
]);

/**
 * Build a once-per-key warner for span attribute keys. The returned callable
 * is safe to invoke on every attribute write — it keeps an internal `Set` of
 * keys that have already been warned about, so the warning fires at most
 * once per unique key across the manager's lifetime.
 *
 * When `logger` is omitted (or throws) the warning is silently swallowed;
 * the warning is advisory, not fatal.
 */
export function createSpanAttributeKeyWarner(
  logger?: Pick<Logger, 'warn'>,
): (key: string) => void {
  const warnedAttrKeys = new Set<string>();
  return (key: string) => {
    if (warnedAttrKeys.has(key)) return;
    if (RESERVED_KEYS.has(key)) return;
    for (const prefix of RESERVED_PREFIXES) {
      if (key.startsWith(prefix)) return;
    }
    warnedAttrKeys.add(key);
    if (!logger) return;
    const msg = `[harness-one/trace-manager] span attribute key "${key}" does not match a reserved prefix (system.*, error.*, cost.*, user.*, harness.*). Consider prefixing with "user." to silence this warning.`;
    try {
      logger.warn(msg, { key });
    } catch {
      // Logger threw — intentional silent fallback; the warning is advisory.
    }
  };
}
