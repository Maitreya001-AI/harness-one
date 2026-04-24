# Context · Threat Model

> Context budget, HEAD/MID/TAIL packing, compression, cache-stability
> hash, and checkpoint manager. Controls what messages survive the
> token budget cut — mistakes here either drop security-relevant
> messages or keep attacker-supplied ones past their welcome.

## Trust boundaries

- **Message history** — mixed trust. System messages (branded via
  `trusted-system-message`), user input, tool output, and RAG
  retrievals all flow through the packer.
- **Checkpoint storage** — semi-trusted. In-memory default is local;
  pluggable storage (e.g. Redis) is a separate boundary.
- **Token counter** — host-supplied. A miscounting counter can cause
  over-budget packs, not an auth-level break.

## STRIDE

### Spoofing

- **Threat**: A restored checkpoint contains a `role: 'system'` message
  the attacker originally wrote; replaying elevates them.
  - Mitigation: `sanitizeRestoredMessage` downgrades un-branded system
    messages to `user`. Checkpoint consumers are expected to pass
    restored messages through the sanitiser before replay.
  - Evidence: `packages/core/src/core/trusted-system-message.ts:62`.

- **Threat**: A forged `Checkpoint.id` collides with an existing
  checkpoint and overwrites it.
  - Mitigation: IDs are minted via `prefixedSecureId('cp')` which draws
    from `crypto.randomBytes`; collision probability is negligible and
    ids are not predictable from timestamps.
  - Evidence: `packages/core/src/context/checkpoint.ts:63-65`.

### Tampering

- **Threat**: A tool-output message is tampered with in storage between
  packing and replay, substituting a `trusted_system` provenance value.
  - Mitigation: `MessageProvenance` is a string enum on
    `BaseMessage.meta` but the trusted-system elevation path keys off
    the `_trust` symbol brand, not `provenance`. Provenance is
    advisory; trust gating is the brand.
  - Evidence: `packages/core/src/core/types.ts:20-28`,
    `packages/core/src/core/trusted-system-message.ts:24`.

### Repudiation

- **Threat**: Context trim silently drops a message required for an
  audit trail; no record of what was dropped.
  - Mitigation: `packContext` returns the trimmed indices / token
    counts alongside the packed array; callers should log the returned
    metrics.
  - Evidence: `packages/core/src/context/pack.ts:55-65`.

### Information Disclosure

- **Threat**: A compression summariser returns an LLM-generated summary
  that accidentally echoes a system-prompt secret (e.g. an API key that
  was inlined into a trusted-system message).
  - Status: Partially mitigated — the summariser is user-supplied and
    sees whatever messages it's given. Callers should redact
    system-role content before summarising. The default `truncate`
    strategy never calls an LLM.
  - Evidence: `packages/core/src/context/compress.ts:20-28`.

- **Threat**: Cache-stability hash leaks content by being a hash of
  unredacted text.
  - Mitigation: Hashes cover 16-char SHA-256 prefixes which do not
    reversibly encode content; but adversarial known-plaintext attacks
    on short repeated strings are theoretically possible.
  - Evidence: `packages/core/src/context/cache-stability.ts`.

### Denial of Service

- **Threat**: A caller passes an unbounded message array and
  `packContext` runs token counting on every message.
  - Mitigation: `countTokens` in `checkpoint.ts` uses a 4 chars-per-
    token heuristic by default (linear in content bytes), and
    `packContext` switched to index-based trimming (no shift/copy) —
    the inner loop is O(n) where n = MID segment length.
  - Evidence: `packages/core/src/context/pack.ts:55-65`,
    `packages/core/src/context/checkpoint.ts:20-26`.

- **Threat**: Budget configured with a gigantic `maxTokens` per
  segment; subsequent `allocate()` calls attempt to fit real data and
  exhaust memory.
  - Mitigation: `createBudget` rejects non-positive segment sizes with
    `CORE_INVALID_CONFIG` before accepting the config.
  - Evidence: `packages/core/src/context/budget.ts:50-55`.

- **Threat**: `createCheckpointManager` with
  `maxCheckpoints = Infinity` retains every checkpoint forever.
  - Mitigation: Config validation rejects `< 1`; default cap is 5.
    `autoPrune()` evicts the oldest once the cap is hit.
  - Evidence: `packages/core/src/context/checkpoint.ts:68-76`.

### Elevation of Privilege

- **Threat**: A compressed message batch smuggles a `role: 'system'`
  claim through the summarised output (the summariser decides it's a
  "system-level observation" and marks it trusted).
  - Mitigation: Compression returns plain text; the caller decides
    what role to wrap it in, and trusted-system status requires the
    `createTrustedSystemMessage` factory. A downstream bug that wraps
    summary output in `role: 'system'` without the brand will be
    downgraded on restore.
  - Evidence: `packages/core/src/core/trusted-system-message.ts`.

## Residual risks

- Token counters are advisory — a malicious tokenizer that always
  returns 0 will pack unbounded messages. Host code should rate-limit
  its adapters separately.
- Checkpoint storage adapters (e.g. `@harness-one/redis`) have their
  own trust model; this doc only covers the in-memory default.
- Compression strategies that dispatch LLM calls can themselves become
  an indirect prompt-injection vector. Callers must apply their
  `GuardrailPipeline` to summariser inputs and outputs separately.

## References

- `docs/architecture/03-context.md`
- `docs/security/core.md` — upstream trust brand
- `docs/security/session.md` — checkpoint replay path
