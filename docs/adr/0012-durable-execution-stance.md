# ADR-0012 · Treat the agent loop as in-memory; durable/replayable execution is out of scope for core

- **Status**: Accepted
- **Date**: 2026-07-03
- **Deciders**: harness-one maintainers

## Context

[ADR-0001](./0001-no-graph-dsl.md) chose an explicit `async function*`
loop over a graph DSL. That choice buys a grep-able control flow and
ordinary streaming/abort semantics — and it owns a consequence that
deserves its own record: **`AgentLoop.run()` is an in-memory
`AsyncGenerator`. It is not durable, not replayable, and not resumable
across process restarts.** If the process dies mid-run, the run is gone;
there is no execution log to replay from.

Durable-execution frameworks (Temporal, Restate, DBOS, AWS Step Functions)
solve a real problem: long-lived workflows that must survive crashes,
redeploys, and multi-hour tool calls by persisting every step and replaying
deterministically. Users coming from that world reasonably ask whether the
agent loop offers the same guarantee.

It does not, and building it into core would fight ADR-0001 head-on:
deterministic replay requires the framework to own the scheduler and record
every side effect — exactly the "user no longer owns the call site" property
ADR-0001 rejected. It would also pull persistence, serialization, and a
replay engine into a package that promises zero runtime dependencies
([ADR-0004](./0004-zero-runtime-deps-in-core.md)).

What core *does* offer is a **checkpoint seam** for saving and restoring
conversation state, plus **memory stores** for cross-run data — enough to
resume the *conversation* deliberately, without pretending to replay the
*execution*.

## Decision

> **The `AgentLoop` is an in-memory `AsyncGenerator` and stays that way.
> Distributed / durable / replayable execution (Temporal-style record-and-
> replay, resumable runs) is explicitly out of scope for `harness-one`
> core and belongs in a sibling integration. The supported seam for
> surviving a restart is state persistence, not execution replay:
> `context`'s async `CheckpointStorage` (+ `CheckpointManager`) for
> conversation snapshots, and `memory` stores for cross-run state.**

What this means in practice, and what users should do **today**:

- **Checkpoint at iteration boundaries.** The loop exposes observer hooks
  (`onIterationEnd`, `onTokenUsage`) and emits an event per iteration. Save
  a checkpoint from a hook / event handler; on restart, `restore()` the
  last checkpoint and start a fresh `AgentLoop` from those messages. You
  resume the conversation, not the in-flight iteration.
- **`CheckpointStorage` is async by contract** (`save`/`load`/`list`/
  `delete` all return promises), so a network- or disk-backed store drops
  in without changing the manager.
- **Know the fs store's durability envelope.** `createFileSystemStore()`
  writes each entry and each index atomically, but multi-file operations
  are **not transactional** — a crash between the entry write and the
  index write can desync `_index.json`. `FsMemoryStore.reconcileIndex()`
  rebuilds the index at boot / on a schedule / after a confirmed crash.
  Reads are unaffected (they scan entry files, never the index). This is
  documented in `docs/ARCHITECTURE.md`. Multi-process access still needs
  an external lock.

The scope boundary: core gives you **durable state you choose to persist
at boundaries you choose**, not automatic durable *execution*.

## Alternatives considered

- **Build durable execution into the loop** (persist every step, replay
  deterministically). Rejected: requires core to own the scheduler and
  intercept every side effect, directly contradicting ADR-0001; and pulls
  a persistence + replay engine into a zero-dep package (ADR-0004).
- **Ship a `@harness-one/temporal` (or Restate/DBOS) integration in this
  repo now.** Deferred, not rejected in principle: durable execution is a
  legitimate sibling-package concern, but it is not core's job and is not
  in scope for this ADR. If demand materializes it lands as its own
  package with its own dependency, wrapping the loop from outside.
- **Make `run()` resumable by serializing generator state.** Rejected: JS
  async generators are not serializable; any "resume" would be a
  reconstruction from persisted messages anyway — which is exactly the
  checkpoint seam, without the illusion of true replay.
- **Do nothing / leave it implicit.** Rejected: silence invites users to
  assume durability that isn't there and get burned by a mid-run crash.
  The negative-space decision is worth writing down.

## Consequences

### Positive

- The loop keeps ADR-0001's properties: grep-able control flow, ordinary
  streaming/abort, no scheduler in between, zero deps.
- Users get an honest, documented durability model — persist state at
  boundaries you control — instead of a leaky "it just resumes" promise.
- Durable-execution integrations remain possible *around* the loop
  (checkpoint in a hook, drive `run()` from inside a Temporal activity)
  without core taking the dependency.

### Negative

- No automatic crash recovery. A run interrupted mid-iteration loses that
  iteration's in-flight work; the user resumes from the last checkpoint,
  possibly re-doing a tool call. Non-idempotent tools need the user's own
  dedupe.
- Checkpoint granularity is the user's responsibility — checkpoint too
  rarely and you lose more on crash; too often and you pay I/O.
- "harness-one doesn't do durable execution" is a real gap for
  long-horizon workflow users, who must reach for a sibling integration or
  a workflow engine and wrap the loop themselves.

## Evidence

- `packages/core/src/core/agent-loop.ts` — `async *run(messages):
  AsyncGenerator<AgentEvent>`; in-memory generator, no persistence.
- `packages/core/src/context/types.ts` — `interface CheckpointStorage`
  with async `save` / `load` / `list` / `delete`; `CheckpointManager`
  `save` / `restore`.
- `packages/core/src/context/checkpoint.ts` — `createCheckpointManager()`.
- `packages/core/src/context/fs-checkpoint-storage.ts` —
  `createFsCheckpointStorage()`, atomic-rename-backed `CheckpointStorage`.
- `packages/core/src/core/agent-loop-types.ts` — `onIterationEnd` /
  `onTokenUsage` observer hooks used to checkpoint at iteration boundaries.
- `docs/ARCHITECTURE.md` — the fs-store "not transactional" +
  `FsMemoryStore.reconcileIndex()` durability envelope.
- [ADR-0001](./0001-no-graph-dsl.md) — the explicit-loop decision whose
  durability consequence this ADR owns.
