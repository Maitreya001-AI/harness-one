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
- [ ] Possibly: a `harness-one/testing` helper for spawning crash-test
      children that hides this concern. Anyone writing a chaos /
      stress harness for harness-one will hit this exact issue. A
      `spawnCrashable({ entry, args, killAt })` helper that returns a
      structured outcome (clean / killed / errored) would centralize
      it.
- [ ] Doc: the showcase-method doc's Stage 3 advice on "process-level
      chaos injection" should warn about wrapped invocations.

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
- [ ] Either ship a `createFsCheckpointStorage()` helper in
      `harness-one/context` that bridges to MemoryStore, or change
      `CheckpointStorage` to be async so the natural composition
      works.
- [ ] Doc: PLAN.md and form-coverage.md both name "CheckpointManager
      + ContextRelay" as the memory pressure stack. Either update the
      docs to point at FsMemoryStore directly, or fix the gap above.

**Severity**: medium — the docs over-promise composition that the
APIs don't deliver. New contributors trying to follow the PLAN will
hit this and either give up or build the bridge themselves.

**Suspected root cause**: The two modules grew independently. Sync
storage is right for CheckpointManager's "snapshot a conversation"
use case; async is right for MemoryStore's "long-running entry log"
use case. They were never designed to compose.

---

## (Append new entries above this line — newest first.)
