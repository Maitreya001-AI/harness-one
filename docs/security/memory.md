# Memory · Threat Model

> Long-term memory store, filesystem backend, cross-context relay,
> memory-query. Persistence layer — an injection here can plant
> poisoned content that surfaces across future sessions.

## Trust boundaries

- **Memory entry content** — written by host code or imported via
  relay. Content is treated as data, not trusted prompt.
- **Entry ids** — ingested from user-facing APIs; validated at the
  storage boundary.
- **Filesystem path** — the store directory is trusted; entries below
  it must stay below.
- **Network relay** — a memory relay shared between contexts is a
  cross-process trust boundary.

## STRIDE

### Spoofing

- **Threat**: An attacker writes an entry with a forged id matching an
  existing entry and smuggles replacement content.
  - Mitigation: ID strictness — `ENTRY_ID_PATTERN` rejects any id
    containing path separators, `.`, `..`, NUL, or non-alnum punctuation
    before the path is constructed. Callers using human-friendly keys
    must hash them before passing.
  - Evidence: `packages/core/src/memory/fs-io.ts:29-38`.

### Tampering

- **Threat**: Concurrent writes to the same entry leave a half-written
  file; next read fails or returns partial JSON.
  - Mitigation: Entry writes use write-then-rename atomicity
    (fs-io.ts).
  - Evidence: `packages/core/src/memory/fs-io.ts:2-9`.

- **Threat**: A JSON entry on disk is corrupted (by disk error or
  tamper); deserialiser throws and the whole store is unreadable.
  - Mitigation: `parseJsonSafe` + `validateMemoryEntry` /
    `validateIndex` schemas at load time; malformed entries surface as
    a `HarnessError`, not a silent `JSON.parse` throw.
  - Evidence: `packages/core/src/memory/fs-io.ts:14`,
    `packages/core/src/memory/_schemas.ts`.

### Repudiation

- **Threat**: Batch delete partially fails; the caller never learns
  which ids were dropped and which survived.
  - Mitigation: `fs-store` collects `failed: Array<{path, error}>`
    from batch I/O and logs `[harness-one/fs-store] <source>: N
    delete(s) failed`; caller can inspect the failed list.
  - Evidence: `packages/core/src/memory/fs-store.ts:95-101`,
    `packages/core/src/memory/fs-store.ts:306-310`.

### Information Disclosure

- **Threat**: A traversal id (`../etc/passwd`) is supplied to `get`
  and the store reads an arbitrary file.
  - Mitigation: Every path-generating helper calls
    `validateEntryId` which enforces `ENTRY_ID_PATTERN`; ids that
    could escape the directory are rejected before `readFile`.
  - Evidence: `packages/core/src/memory/fs-io.ts:29-49`.

- **Threat**: Memory entries accidentally serialise an API key into
  content, which surfaces in future retrievals.
  - Status: Partially mitigated — the memory store does not redact
    content. Callers must redact at write time. Downstream consumers
    that forward memory content to telemetry are covered by the
    observe subsystem's redactor.
  - Evidence: `docs/security/observe.md`.

### Denial of Service

- **Threat**: Unbounded entries exhaust inode count / disk.
  - Mitigation: `fs-store` supports `maxEntries` and evicts the oldest
    via LRU once the cap is hit; deletion failures are surfaced but
    don't block eviction.
  - Evidence: `packages/core/src/memory/fs-store.ts:327-333`.

- **Threat**: A caller opens many files concurrently, exhausting the
  Node fd pool.
  - Mitigation: fs-io batches I/O in controlled-concurrency chunks;
    see doc comment at `packages/core/src/memory/fs-io.ts:4-8`.
  - Evidence: `packages/core/src/memory/fs-io.ts:4-8`.

### Elevation of Privilege

- **Threat**: Relay imports an entry whose content parses into a
  `{role: 'system'}` message and the consumer treats it as a trusted
  system prompt.
  - Mitigation: Same brand-based trust model as elsewhere: the
    `_trust` symbol is process-local and does not survive
    serialisation; any restored system message without the brand is
    downgraded to `user` via `sanitizeRestoredMessage`.
  - Evidence: `packages/core/src/core/trusted-system-message.ts:62`.

- **Threat**: Relay concurrent writers both claim the same version,
  resulting in a last-writer-wins scenario that erases the intermediate
  update.
  - Mitigation: Relay documents "single-writer pattern" (Fix 22);
    `saveState` retries on version-conflict errors so the logical
    single writer can still recover from transient conflicts.
  - Evidence: `packages/core/src/memory/relay.ts:19-30`,
    `packages/core/src/memory/relay.ts:41-47`.

## Residual risks

- Content redaction is the caller's responsibility. A naive caller
  writing raw `Message.content` to memory may persist secrets that the
  observability redactor can't reach at export.
- The default in-memory store does not survive process restart; relay
  + `@harness-one/redis` (or a disk-backed store) is required for
  durable state.
- File-system store relies on the OS for isolation; a shared
  directory across tenants has no in-code partition — callers must
  prefix ids or use per-tenant stores.
- Concurrent cross-process writers to the same fs directory can still
  race (fs-io is atomic per-write but two processes writing different
  keys is not serialised).

## References

- `docs/architecture/08-memory.md`
- `docs/security/session.md` — session store trust model
- `docs/security/redact.md` — at-rest redaction caveats
