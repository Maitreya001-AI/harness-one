# Showcase 04 · Orchestration Handoff Boundary

A 4-agent chain (Coordinator → Researcher → 2 Specialists in parallel)
exercising `spawnSubAgent` from `harness-one/orchestration`. Three
scenarios:

1. **Drift detection** — 100 sequential happy-path chain runs verify
   no cross-run state pollution (token usage stable across 100
   identical runs).
2. **Error injection** — one Specialist's adapter throws; the chain
   propagates a typed `HarnessError` that identifies the failing agent.
3. **Cascade abort** — caller schedules `ctrl.abort()` early; chain
   completes without unhandled exceptions.

## What it proves (pressure points)

- Repeated invocation of `spawnSubAgent` does not leak state across
  runs (verified via stable token counts)
- Adapter errors propagate through the helper as `HarnessError` with
  identifying message
- Aborted chains don't leak unhandled rejections

See PLAN.md for the full 15-pressure-point list and HYPOTHESIS.md for
predictions.

## Run

```bash
pnpm start
```

Exits 0 on full pass.

## Critical finding (see FRICTION_LOG.md)

The build surfaced a **high-severity** API design issue:
`spawnSubAgent` does **not** throw on adapter / loop errors. It
records the failure as `doneReason: 'error'` and resolves the Promise
normally. Anyone wrapping `spawnSubAgent` in `try / catch` sees no
exception. The showcase's helper inspects `doneReason` and re-throws,
but consumers writing similar code in production agents will likely
miss this.

This is the single most actionable finding from the four-showcase MVP
build. Recommended response is documented in FRICTION_LOG.md as a
candidate issue / API change.

## Files

| Path | Purpose |
|---|---|
| `src/main.ts` | 4-agent chain + 3 scenario harness |
| `PLAN.md` | Stage 1 — pressure points, success criteria |
| `HYPOTHESIS.md` | Stage 2 — predictions before code, with observed annotations |
| `FRICTION_LOG.md` | Stage 3 — accumulating friction encountered while building |

## Status

MVP complete and passing on the 3 implemented scenarios. Stages still
pending:

- [ ] Stage 4 — Observe: 100+ runs is done; trace-tree assertions need
      wiring (need `traceManager` + `createSlowMockAdapter`)
- [ ] Stage 5 — Harvest, Stage 6 — FeedBack, Stage 7 — Archive
