# Showcase 01 · Streaming CLI

A minimal interactive REPL that exercises **`core` streaming**, **`session`
multi-turn**, and **`observe` lifecycle / cost** end to end.

## What it proves (pressure points)

See `PLAN.md` for the full list of 14 pressure points. The MVP build in
this directory exercises:

- `text_delta` events flow chunk-by-chunk to stdout
- `done` event carries `totalUsage`; `CostTracker` produces non-zero
  totals
- Multi-turn history accumulates correctly across turns
- Graceful shutdown moves through `init → ready → draining → shutdown`
  and flushes traces before exit
- A second signal during shutdown force-exits with code 1
- Replay mode (`--replay`) is fully deterministic for CI

## Run

```bash
# Interactive (read from stdin):
pnpm start

# Deterministic CI mode (3 scripted turns, then graceful exit):
pnpm start:replay
```

Both modes use a **mock streaming adapter**
(`createStreamingMockAdapter` from `harness-one/testing`). To run
against a real provider, swap in `@harness-one/anthropic` or
`@harness-one/openai` — the AgentLoop wiring is identical.

## Files

| Path | Purpose |
|---|---|
| `src/main.ts` | REPL loop + lifecycle + signal handlers + per-turn execution |
| `src/scripted-replies.ts` | Deterministic Q/A pairs for replay mode |
| `PLAN.md` | Stage 1 — pressure points, success criteria, non-goals |
| `HYPOTHESIS.md` | Stage 2 — predictions made before code, with observed annotations |
| `FRICTION_LOG.md` | Stage 3 — accumulating friction encountered while building |

## Status

MVP complete. Stages still pending per
[`docs/harness-one-showcase-method.md`](../../docs/harness-one-showcase-method.md):

- [ ] Stage 4 — Observe: ≥10 real-API runs (need `ANTHROPIC_API_KEY`)
- [ ] Stage 5 — Harvest: 2x2 matrix `assumed × actual`
- [ ] Stage 6 — FeedBack: convert FRICTION entries to issues / PRs
- [ ] Stage 7 — Archive: cassettes + CI replay job

## Related friction so far

5 friction entries logged in [`FRICTION_LOG.md`](./FRICTION_LOG.md):

1. `ModelPricing` field naming (low)
2. `HarnessLifecycle` exposes named verbs, not `transitionTo()` (low)
3. `TraceManager.shutdown()` doesn't exist; use `flush()` (low)
4. `AgentLoopConfig` field is `signal`, not `externalSignal` (trivial,
   self-inflicted)
5. `createStreamingMockAdapter` doesn't auto-fill usage on `done`
   (medium — silent zero metrics)
