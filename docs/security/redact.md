# Redact · Threat Model

> Secret-redaction utilities (`createRedactor`, `sanitizeAttributes`,
> `redactValue`). Thin subsystem — re-exports the canonical
> implementation at `infra/redact`. Used by Logger, TraceManager, and
> exporter adapters.

## Trust boundaries

- **Key-value pairs submitted for redaction** — mixed trust. Come
  from log attributes, trace metadata, error causes, adapter
  responses.
- **Caller-supplied patterns** — caller-trusted. Additional regex
  patterns & key lists handed in via config.
- **Consumers** — trusted. The caller is expected to *call* the
  redactor before emission; the subsystem cannot retroactively scrub
  data that bypassed it.

## STRIDE

### Spoofing

- **Threat**: A caller's data contains a key like `api_keyy` (double
  y) that looks like a secret but doesn't match the default pattern.
  The redactor lets it through.
  - Status: By design — redaction is opt-in. Callers with
    application-specific key shapes must pass `extraKeys` /
    `extraPatterns`.
  - Evidence: `packages/core/src/infra/redact.ts:27-35`.

### Tampering

- **Threat**: An attacker who can write attribute keys sets
  `__proto__` to poison the serialised output.
  - Mitigation: `POLLUTING_KEYS` set explicitly bars `__proto__`,
    `constructor`, and `prototype`; `isPollutingKey` is consulted by
    `sanitizeAttributes` before any assignment to the output object.
    Default `blockPollutingKeys: true` cannot be flipped false
    accidentally.
  - Evidence: `packages/core/src/infra/redact.ts:23`,
    `packages/core/src/infra/redact.ts:70-72`,
    `packages/core/src/infra/redact.ts:111-125`.

### Repudiation

- **Threat**: A value is scrubbed to `[REDACTED]` with no record of
  which key was redacted.
  - Mitigation: The `REDACTED_VALUE` placeholder IS the record —
    downstream consumers can see the key was present but its value is
    gone. Pairing with the Logger guarantees the key name survives
    (so SRE can triage) while the value stays hidden.
  - Evidence: `packages/core/src/infra/redact.ts:13`.

### Information Disclosure

- **Threat**: Secrets in values that don't share a key name with a
  match pattern (e.g., an arbitrary `details` field containing a
  bearer token in free text) leak.
  - Status: Unmitigated — redaction is key-based, not value-based.
    Callers that risk value-level leaks should run a content-filter
    or PII guardrail BEFORE the telemetry emit.
  - Evidence: `packages/core/src/guardrails/pii-detector.ts` (caller's
    mitigation path).

- **Threat**: Nested secrets inside an object value escape because
  `redactValue` doesn't walk deeply enough.
  - Mitigation: `redactValue` recurses into nested objects and arrays
    using the same redactor; the walk is bounded only by the input
    structure (no artificial depth cap, so callers must supply
    finite-depth objects).
  - Evidence: `packages/core/src/infra/redact.ts:84-110`.

### Denial of Service

- **Threat**: Caller passes a deeply recursive or circular object;
  `redactValue` loops forever.
  - Status: Unmitigated — tracked in issue #TBD. The walk does not
    maintain a visited-set. Deployments that allow user-supplied
    attribute bags must cap depth at the caller layer (e.g. JSON
    round-trip with a depth cap, or stringify+truncate before hand).
  - Evidence (vulnerable code): `packages/core/src/infra/redact.ts:84-110`.

### Elevation of Privilege

- **Threat**: A nested attribute containing `__proto__` at a deep
  level of an output bag escapes pollution stripping because the
  walker assigns into the output before checking the key.
  - Mitigation: `sanitizeAttributes` tests `isPollutingKey(k)` before
    assigning to the sanitised output, and `redactValue` delegates to
    the same redactor on the way down; the polluting-key check runs
    at every level.
  - Evidence: `packages/core/src/infra/redact.ts:70-72`,
    `packages/core/src/infra/redact.ts:111-125`.

## Residual risks

- **Callers must call**. The redactor is a pure function; any code
  path that emits attributes without invoking `sanitizeAttributes`
  (custom exporter adapters, ad-hoc `console.log` calls) bypasses
  protection. The Logger and TraceManager cover the default path;
  audit any new exporter to ensure it chains through.
- The default pattern is English-centric. Keys in other languages
  (e.g., `мотик`, `令牌`) holding secrets pass unless callers register
  `extraKeys`.
- Pollution blocking assumes the output object's prototype is
  `Object.prototype`. If a caller creates the output with
  `Object.create(null)` or a custom prototype, the pollution-risk
  surface differs — but so does the attacker's leverage, so this is
  neutral.

## References

- `docs/architecture/15-redact.md`
- `docs/security/observe.md` — primary consumer
- `docs/security/core.md` — adjacent trust model
