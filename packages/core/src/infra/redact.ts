/**
 * Shared secret-redaction utilities.
 *
 * Used by Logger, TraceManager, and exporter adapters (OTel, Langfuse) to
 * scrub sensitive keys (API keys, tokens, passwords, cookies, etc.) and to
 * block prototype-polluting keys (`__proto__`, `constructor`, `prototype`)
 * from being stored or exported.
 *
 * @module
 */

/** Placeholder substituted for redacted values. */
export const REDACTED_VALUE = '[REDACTED]';

/**
 * Default deny pattern: case-insensitive match against field names containing
 * common secret indicators anywhere in the key path.
 */
export const DEFAULT_SECRET_PATTERN =
  /(^|[._-])(api[_-]?key|authorization|auth[_-]?token|secret|token|password|passwd|credential|bearer|cookie|session[_-]?id|private[_-]?key|access[_-]?key|refresh[_-]?token)([._-]|$)/i;

/** Keys that pollute `Object.prototype` or similar when assigned. */
export const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Configurable redaction behavior. */
export interface RedactConfig {
  /** Additional regex used OR'd with the default pattern. */
  readonly extraPatterns?: readonly RegExp[];
  /** Additional exact key names to redact (case-insensitive). */
  readonly extraKeys?: readonly string[];
  /** If false, the default pattern is disabled. Default: true. */
  readonly useDefaultPattern?: boolean;
  /** If false, prototype-polluting keys are not rejected. Default: true. */
  readonly blockPollutingKeys?: boolean;
}

/** Compiled redactor: returns true if a key should be redacted. */
export interface Redactor {
  shouldRedactKey(key: string): boolean;
  isPollutingKey(key: string): boolean;
}

/**
 * Create a redactor from configuration. The returned redactor is pure —
 * it contains no state and can be cached at construction time.
 */
export function createRedactor(config?: RedactConfig): Redactor {
  const useDefault = config?.useDefaultPattern ?? true;
  const blockPolluting = config?.blockPollutingKeys ?? true;
  const extraKeysLower = new Set(
    (config?.extraKeys ?? []).map((k) => k.toLowerCase()),
  );
  const extraPatterns = config?.extraPatterns ?? [];

  return {
    shouldRedactKey(key: string): boolean {
      if (typeof key !== 'string') return false;
      if (extraKeysLower.has(key.toLowerCase())) return true;
      if (useDefault && DEFAULT_SECRET_PATTERN.test(key)) return true;
      for (const p of extraPatterns) {
        p.lastIndex = 0;
        if (p.test(key)) return true;
      }
      return false;
    },
    isPollutingKey(key: string): boolean {
      return blockPolluting && POLLUTING_KEYS.has(key);
    },
  };
}

/**
 * Deep-redact a value tree. Keys matching the redactor are replaced with the
 * redaction placeholder; prototype-polluting keys are dropped entirely.
 *
 * The input is NOT mutated; the returned value is a fresh shallow or deep
 * clone as needed. Circular references are preserved with a `[Circular]`
 * sentinel string (matching `createSafeReplacer` semantics).
 */
export function redactValue(value: unknown, redactor: Redactor): unknown {
  const seen = new WeakSet<object>();
  function walk(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (v instanceof Date) return v.toISOString();
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (redactor.isPollutingKey(k)) continue;
      out[k] = redactor.shouldRedactKey(k) ? REDACTED_VALUE : walk(val);
    }
    return out;
  }
  return walk(value);
}

/**
 * Sanitize a map of attributes to be safe for span/log export: drops
 * prototype-polluting keys and redacts sensitive values. Returns a new object.
 */
export function sanitizeAttributes(
  attrs: Record<string, unknown>,
  redactor: Redactor,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (redactor.isPollutingKey(k)) continue;
    out[k] = redactor.shouldRedactKey(k)
      ? REDACTED_VALUE
      : redactValue(v, redactor);
  }
  return out;
}
