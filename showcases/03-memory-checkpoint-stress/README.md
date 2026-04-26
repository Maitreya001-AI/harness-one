# Showcase 03 · Memory + Checkpoint Stress

A supervisor that forks a child process which writes to `FsMemoryStore`,
SIGKILLs the child mid-run, restarts, and verifies the persisted store
survived without data loss or corruption.

## What it proves (pressure points — see PLAN.md)

- `FsMemoryStore.write()` is durable across SIGKILL
- The fs index survives interrupted segments and reloads cleanly
- Resume-from-crash never loses an entry written before the crash
- Resume-from-crash never produces a half-written / corrupted entry
- Checksum verification catches silent corruption (none observed in
  this MVP run)

## Run

```bash
pnpm start
```

MVP defaults: **30 iterations, 2 crash injections (at iter 12 and 22)**.
The full 200-iteration / 5-crash version described in PLAN is left to
manual runs — change `TOTAL_ITERATIONS` and `CRASH_AT` in `src/main.ts`.

Exits 0 on full pass (correct entry count + zero checksum mismatches +
expected number of crashes observed). Exits 1 on any failure.

## Files

| Path | Purpose |
|---|---|
| `src/main.ts` | Supervisor — forks children + verifies persisted store |
| `src/child.ts` | Child entry — writes per-iteration entries, self-SIGKILLs at target |
| `src/state.ts` | State shape + checksum helper |
| `data/` | Generated checkpoint dir (gitignored) |
| `PLAN.md` | Stage 1 — pressure points, success criteria |
| `HYPOTHESIS.md` | Stage 2 — predictions made before code, with observed annotations |
| `FRICTION_LOG.md` | Stage 3 — accumulating friction encountered while building |

## Status

MVP complete and passing. Stages still pending:

- [ ] Stage 4 — Observe: run the full 200/5 stress mode, run on Linux
      and macOS to compare
- [ ] Stage 5 — Harvest, Stage 6 — FeedBack, Stage 7 — Archive

## Friction logged

3 entries in [`FRICTION_LOG.md`](./FRICTION_LOG.md), one of which
(CheckpointManager / FsMemoryStore composition) is escalated as RFC
candidate because it touches the design promise of the form-coverage
matrix.
