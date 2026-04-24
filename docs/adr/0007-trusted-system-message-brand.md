# ADR-0007 · Brand `SystemMessage` with a process-local symbol

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

A `SystemMessage` carries higher authority than a `UserMessage`: the
LLM treats it as the configured operator, and downstream tool-call
gating sometimes relies on it. Two failure modes threaten this
authority gradient:

1. **User-input concatenation** — application code that builds a
   system prompt by interpolating user text (e.g. `system: \`You are
   ${role}.\``) opens up a prompt-injection vector if `role` is
   attacker-controlled.
2. **Storage round-tripping** — sessions persist messages to disk or
   Redis. An attacker with write access to the store can forge
   `{ role: 'system', content: '…' }` rows; on restore, the loop
   would treat them as authoritative.

Without a runtime distinction, both vectors look identical to the
agent loop: it just sees a `Message` whose `role === 'system'`.

## Decision

> **Trusted system messages are minted only through
> `createTrustedSystemMessage()`, which attaches a non-serialisable
> process-local `Symbol` brand. Any `role: 'system'` message lacking
> the brand is downgraded to `role: 'user'` on restore via
> `sanitizeRestoredMessage()`.**

The brand is a TypeScript `unique symbol` constant declared inside
`trusted-system-message.ts` and never exported. JSON serialization
strips it (symbols are non-enumerable to `JSON.stringify`), so any
message that passes through storage loses the brand and is treated as
untrusted on the way back in. Host code that needs a system message
across a restore must re-mint it.

## Alternatives considered

- **`as SystemMessage` casts** — the existing TS type lets you assert
  any `Message` to a `SystemMessage`. Rejected: the cast is
  invisible at the call site and is the exact pattern that
  user-input concatenation tends to take.
- **A boolean field** (`isTrusted: true`). Rejected: serialisable
  and forgeable. Anyone with write access to the store can set it.
- **Cryptographic signature** over the message. Rejected: requires
  key management, defeats simple console debugging, and the threat
  model (storage tampering, prompt-injection) doesn't actually need
  signature semantics — it needs unforgeability across a JSON
  round-trip, which a process-local symbol already provides.
- **Branded type by string literal** (`{ readonly _trust: 'trusted' }`).
  Rejected: serialisable to JSON, so storage-tampering still wins.

## Consequences

### Positive

- The trust gradient is a runtime property the loop can check
  (`isTrustedSystemMessage(msg)`), not a developer convention.
- A message read from storage that claims `system` but lacks the
  brand is automatically downgraded to `user`. Storage tampering
  cannot elevate.
- The brand is invisible to JSON, network transport, and casual
  logging — it cannot leak by accident.
- Host code that intentionally builds a system message goes through
  one named factory, which is grep-able for audit.

### Negative

- The brand does not survive `structuredClone` or `JSON.parse(JSON.
stringify(msg))`. Code that round-trips messages through any
  serialisation has to re-mint, which is the desired behaviour but
  takes some explaining for first-time users.
- Cross-process scenarios (multi-worker, queue-based agents) cannot
  pass a trusted system message between processes without re-minting
  on the receiving side. We accept this; cross-process trust would
  require signatures and we deliberately scoped this ADR to
  in-process safety.
- Tests that assemble system messages by hand have to call the
  factory, not type the literal `{ role: 'system', … }`. The
  `harness-one/testing` exports cover the common cases.

## Evidence

- `packages/core/src/core/trusted-system-message.ts` — the
  process-local `TRUSTED_SYSTEM_BRAND = Symbol(…)`,
  `createTrustedSystemMessage()`, `isTrustedSystemMessage()`,
  `sanitizeRestoredMessage()`.
- `packages/core/src/core/types.ts` — `TrustedSystemBrand` type and
  `SystemMessage._trust?: TrustedSystemBrand` field declaration.
- `packages/core/src/session/manager.ts` — restore path that runs
  `sanitizeRestoredMessage` before yielding messages back to the
  caller.
- `packages/core/src/core/__tests__/` — coverage of the round-trip
  downgrade behaviour (system→user when brand is missing).
- `docs/architecture/01-core.md` — public-facing description of the
  trusted-system-message contract.
