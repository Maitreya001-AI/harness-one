# Session · Threat Model

> Session manager, auth context, conversation store, LRU, GC. Owns the
> lifecycle of long-lived conversation state and the binding between a
> request and its caller identity.

## Trust boundaries

- **AuthContext** — trusted but caller-minted. Whoever calls
  `createAuthContext` is already inside the trust boundary.
- **Session store** — pluggable. Default is in-memory; Redis / durable
  stores are separate trust tiers.
- **Session id** — treated as a bearer capability. Anyone with the id
  can read the session.

## STRIDE

### Spoofing

- **Threat**: Predictable session id lets an attacker guess a valid
  handle for another user.
  - Mitigation: Session ids are crypto-random via
    `prefixedSecureId('sess')` / infra/ids; they don't encode time or
    user identity.
  - Evidence: `packages/core/src/infra/ids.ts`.

- **Threat**: A message saved with `role: 'system'` but no `_trust`
  brand is restored and treated as a trusted system prompt.
  - Mitigation: `sanitizeRestoredMessage` downgrades un-branded
    system messages to `user` on restore. Session consumers must
    pass restored messages through the sanitiser.
  - Evidence: `packages/core/src/core/trusted-system-message.ts:62`.

### Tampering

- **Threat**: `AuthContext.roles` array is mutated post-creation (e.g.
  a middleware pushes `'admin'` after the fact).
  - Mitigation: `createAuthContext` deep-freezes arrays, metadata, and
    nested values; mutations throw in strict mode, silently fail
    elsewhere.
  - Evidence: `packages/core/src/session/auth.ts:23-34`,
    `packages/core/src/session/auth.ts:50-65`.

### Repudiation

- **Threat**: Session GC evicts a session in-flight and the caller
  gets an "unknown session" error with no audit trail.
  - Mitigation: Eviction is driven by `session-lru` + `session-gc`;
    the event bus emits `session:evicted` / `session:expired`
    lifecycle events for observers to record.
  - Evidence: `packages/core/src/session/session-event-bus.ts`,
    `packages/core/src/session/session-gc.ts:37-40`.

### Information Disclosure

- **Threat**: Two tenants share the same in-memory store; a bug in the
  lookup path returns tenant A's session to tenant B.
  - Mitigation: Session manager keys by id only; isolation between
    tenants is the store's responsibility. The `AuthContext.tenantId`
    field lets store implementations partition by tenant, but the
    default in-memory store does NOT partition — it trusts callers.
  - Status: Partially mitigated — tenant isolation is a store-layer
    concern; deployments sharing a store across tenants must pick a
    store that enforces it (e.g. Redis with keyspace prefixes).

### Denial of Service

- **Threat**: Unbounded session creation exhausts memory.
  - Mitigation: `maxSessions` (default 100) + LRU eviction; ids whose
    last access is older than `ttlMs` (default 5 min) expire via the
    background GC.
  - Evidence: `packages/core/src/session/manager.ts:104-120`.

- **Threat**: GC interval hangs the Node process on shutdown.
  - Mitigation: GC timer is `unref()`-ed so an idle GC loop never
    blocks Node process exit; a throwing GC pass does not kill the
    timer.
  - Evidence: `packages/core/src/session/session-gc.ts:25`,
    `packages/core/src/session/session-gc.ts:38-40`.

- **Threat**: Callers forget to `dispose()` the manager, leaking the
  GC interval.
  - Mitigation: `dispose()` clears the interval and all stored
    sessions; documented on the manager JSDoc.
  - Evidence: `packages/core/src/session/manager.ts:53-57`.

### Elevation of Privilege

- **Threat**: An attacker tampers with the session's stored
  `ConversationStore` to replace a `user` message with a `system` one.
  - Mitigation: Trust is brand-based; restoration goes through
    `sanitizeRestoredMessage`. The attacker cannot forge the
    process-local `Symbol` that gates trusted-system behaviour.
  - Evidence: `packages/core/src/core/trusted-system-message.ts:24`.

- **Threat**: `AuthContext.permissions` exposes a mutable array, and a
  compromised dependency pushes `'write'` into a read-only caller's
  context.
  - Mitigation: Deep-freeze of the context at creation time — this
    defeats prototype manipulation and array mutation.
  - Evidence: `packages/core/src/session/auth.ts:50-65`.

## Residual risks

- Session-id handling is bearer-token-style. Anyone who can exfiltrate
  the id from a log or URL has full access. Session ids MUST not be
  embedded in logs or URLs; the default logger redactor catches
  `session_id` by key.
- GC-evicted sessions are not recoverable. Deployments that need
  durable session replay must use `@harness-one/redis` or similar.
- The event bus is synchronous; a slow subscriber blocks every session
  op. The manager doesn't wrap handlers in a timeout.
- AuthContext does NOT expire; callers must rotate it themselves on
  role changes.

## References

- `docs/architecture/07-session.md`
- `docs/security/core.md` — trusted-system brand
- `docs/security/context.md` — checkpoint replay
