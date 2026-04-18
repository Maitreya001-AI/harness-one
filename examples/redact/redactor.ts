/**
 * Example: Secret redaction primitives — `createRedactor` / `redactValue`
 * / `sanitizeAttributes`.
 *
 * Redaction is a core-level cross-cutting concern (Logger, TraceManager, and
 * exporters all route through `harness-one/redact`). Defaults are **on**:
 *
 *   - `createLogger()` / `createTraceManager()` apply `DEFAULT_SECRET_PATTERN`.
 *   - Langfuse / OpenTelemetry exporters run span attributes through
 *     `sanitizeAttributes` by default.
 *
 * Opt out is **explicit** (`redact: false`). This file shows how to build
 * your own redactor, plug it into custom exporters, and extend the pattern
 * list for PII-specific rules.
 */
import {
  createRedactor,
  redactValue,
  sanitizeAttributes,
  REDACTED_VALUE,
  DEFAULT_SECRET_PATTERN,
  POLLUTING_KEYS,
} from 'harness-one/redact';

function main(): void {
  // ── 1. Default redactor — matches DEFAULT_SECRET_PATTERN keys ───────────
  // The Redactor exposes `shouldRedactKey(key)` / `isPollutingKey(key)` —
  // the `redactValue` helper walks an arbitrary value tree and applies them.
  const defaultRedactor = createRedactor({ useDefaultPattern: true });
  const payload = {
    apiKey: 'sk-ant-12345',
    user: { name: 'Alice', authorization: 'Bearer xyz.abc.def' },
    meta: { token: 'tok_1234567890' },
    safe: 'this field stays',
    nested: { deeply: { password: 'hunter2' } },
  };
  console.log('Default redacted:', redactValue(payload, defaultRedactor));
  // { apiKey: '[REDACTED]', user: { name: 'Alice', authorization: '[REDACTED]' }, ... }

  // ── 2. Extend with domain-specific keys + patterns ──────────────────────
  const piiRedactor = createRedactor({
    useDefaultPattern: true,
    extraKeys: ['ssn', 'phone', 'creditCard'], // exact case-insensitive key match
    extraPatterns: [/private[_-]?key/i],       // merged into the match set
  });
  console.log(
    'PII-aware:',
    redactValue(
      { ssn: '123-45-6789', private_key: 'pk-abc', phone: '555-1234' },
      piiRedactor,
    ),
  );

  // ── 3. sanitizeAttributes — the helper exporters use ────────────────────
  // Custom TraceExporter authors should sanitize before forwarding to an
  // external backend. `sanitizeAttributes` walks the top-level key-value map
  // and recursively redacts values — drops `__proto__` / `constructor` /
  // `prototype` to block prototype-pollution via span attributes.
  const spanAttrs = {
    'http.url': 'https://api.example.com',
    'user.id': 'u-42',
    '__proto__': { malicious: true }, // stripped by POLLUTING_KEYS
    'authorization': 'Bearer abcdef', // key matches DEFAULT_SECRET_PATTERN
  };
  const sanitized = sanitizeAttributes(spanAttrs, defaultRedactor);
  console.log('Sanitized span attrs:', sanitized);

  // ── 4. DoS insurance — cycles handled with [Circular] sentinel ──────────
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const safe = redactValue(cyclic, defaultRedactor);
  console.log('Cycle handled:', JSON.stringify(safe).slice(0, 80));

  // ── 5. Turn off the default pattern (only redact your own extraKeys) ───
  // Useful when your attrs already passed through upstream redaction and
  // you only want to scrub a domain-specific field set.
  const myKeysOnly = createRedactor({
    useDefaultPattern: false,
    extraKeys: ['internalToken'],
  });
  console.log('Custom-only:', redactValue({ apiKey: 'kept', internalToken: 'gone' }, myKeysOnly));

  // ── 6. Constants exported so exporter authors stay consistent ──────────
  console.log('REDACTED_VALUE:', REDACTED_VALUE);
  console.log('DEFAULT pattern source:', DEFAULT_SECRET_PATTERN.source.slice(0, 60), '…');
  console.log('Prototype-pollution keys stripped:', [...POLLUTING_KEYS]);
}

main();
