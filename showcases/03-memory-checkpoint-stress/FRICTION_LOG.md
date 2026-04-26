# FRICTION_LOG · 03-memory-checkpoint-stress

> Per `docs/harness-one-showcase-method.md` Stage 3 rule 2: every time
> we work around / get stuck on harness-one, append a timestamped entry
> immediately.

---

## 2026-04-26 — `MemoryEntry.write()` requires an explicit `key` distinct from `id`

**Friction**: First-pass code passed `metadata.key` but no top-level
`key`, mirroring the typical "metadata is opaque" key-value store
mental model. Real `MemoryEntry` has both an `id` (auto-generated) and
a `key` (caller-supplied), and `key` is required.

The naming is non-obvious: most KV stores use `key` and `id`
interchangeably or omit one. Here `id` is the storage handle, `key`
is the caller-meaningful identifier (used for query / lookup). The
docstring on the interface doesn't explain the distinction at the
declaration site — you have to find the testkit to see how they're
used differently.

**Workaround**: Pass `key: stateKey(iter)` at the top level alongside
metadata.

**Feedback action**:
- [ ] Doc: 1-line JSDoc clarification on `MemoryEntry.id` and
      `MemoryEntry.key` explaining when to use which, ideally with an
      example showing both. The current docs let "id auto, key from
      caller" leak through too late.

**Severity**: low

---

## 2026-04-26 — Sub-process crash detection: SIGKILL via pnpm wrapper surfaces as exit code 137

**Friction**: PLAN's "SIGKILL the child + observe `signal === 'SIGKILL'`
in the parent" works only if the parent is the *direct* parent of the
killed process. Spawning through `pnpm exec tsx ...` adds two layers
(pnpm shell + tsx loader); when the leaf node is SIGKILLed, those
intermediaries see the signal and translate it into conventional exit
code 137 (128 + 9). Node's `child_process.spawn().on('exit', code,
signal)` then reports `code: 137, signal: null` to our supervisor.

The first showcase run failed assertions because we expected
`signal === 'SIGKILL'` and got null. The data layer (the actual
form-pressure target) was completely fine; the testing harness was the
problem.

**Workaround**: Recognize `code === 137` as a SIGKILL too. Comment
explains the signal-laundering for future readers.

**Feedback action**:
- [x] **Resolved 2026-04-26** — `harness-one/testing` now exports
      `spawnCrashable({ entry, args, killAt })` returning a structured
      `{ outcome: 'clean' | 'killed' | 'errored', code, signal }`.
      Recognises BOTH `signal === 'SIGKILL'` and `code === 137`
      (laundered via pnpm/tsx wrappers) as the killed outcome.
      Tests in `packages/core/src/testing/__tests__/extra-helpers.test.ts`
      lock all six exit-shape branches.
- [ ] Doc: showcase-method note about wrapped invocations to land in
      W4-DOCS pass.

**Severity**: medium for any future stress test author; trivial once
known.

---

## 2026-04-26 — `CheckpointManager` (sync, in-memory by default) doesn't natively compose with `FsMemoryStore` (async)

**Friction**: The PLAN talks about "CheckpointManager + ContextRelay +
FsMemoryStore" as if they're a stack. They're actually two unrelated
subsystems with mismatched sync/async storage interfaces:

- `CheckpointManager` (in `harness-one/context`) takes a
  `CheckpointStorage` that is **sync** and ships an in-memory default.
- `FsMemoryStore` / `MemoryStore` (in `harness-one/memory`) is **async**
  with `read`/`write`/`query`/`delete`.

To get persistent checkpoints via the CheckpointManager API, a
caller has to write a `CheckpointStorage` adapter that wraps an async
MemoryStore behind a sync interface — which forces either blocking
(bad) or a write-through cache + queue (complex). The MVP showcase
side-stepped this by using `FsMemoryStore` directly without the
`CheckpointManager` abstraction.

**Workaround**: For this showcase, dropped CheckpointManager. The form
pressure (fs-backed crash-recovery) is satisfied by FsMemoryStore
alone, which has its own atomic-rename + index recovery.

**Feedback action**:
- [x] **Resolved 2026-04-26** — implemented BOTH suggestions:
      1. `CheckpointStorage` is now async (`Promise<...>` everywhere).
         Composes naturally with any async backend including the
         existing `FsMemoryStore` pattern. Major version bump for
         the breaking interface change.
      2. New `createFsCheckpointStorage({ dir })` ships from
         `harness-one/context`, with atomic-rename writes, an
         `_index.json` for ordered list reads, and directory-scan
         recovery when the index is torn or missing. Same shape as
         FsMemoryStore.
      Tests: `packages/core/src/context/__tests__/fs-checkpoint-storage.test.ts`
      cover CRUD, cold-restart persistence, torn-index recovery,
      cross-process auto-prune, and concurrent in-process writes.
- [ ] Doc: PLAN.md / form-coverage.md update tracked under W4-DOCS.

**Severity**: medium — the docs over-promise composition that the
APIs don't deliver. New contributors trying to follow the PLAN will
hit this and either give up or build the bridge themselves.

**Suspected root cause**: The two modules grew independently. Sync
storage is right for CheckpointManager's "snapshot a conversation"
use case; async is right for MemoryStore's "long-running entry log"
use case. They were never designed to compose.

---

## (Append new entries above this line — newest first.)
