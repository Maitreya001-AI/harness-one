# Showcases

Form-pressure experiments. Each showcase strictly follows the 7-stage method
in [`docs/harness-one-showcase-method.md`](../docs/harness-one-showcase-method.md):
**Plan → Hypothesis → Build → Observe → Harvest → FeedBack → Archive**.

## Current state

The first batch of four showcases has **MVP implementations** (Stage 3
"Build" complete, Stage 4 "Observe with real-API runs" pending). Each
ships PLAN.md (Stage 1), HYPOTHESIS.md (Stage 2), FRICTION_LOG.md
(Stage 3), and a runnable `src/`.

| # | Showcase | Primary subsystem(s) | Status | PLAN draft |
|---|---|---|---|---|
| 01 | [`streaming-cli/`](./01-streaming-cli/) | `core` streaming + `session` + `observe` | MVP build | [`docs/showcase-plans/01-streaming-cli-PLAN.md`](../docs/showcase-plans/01-streaming-cli-PLAN.md) |
| 02 | [`rag-support-bot/`](./02-rag-support-bot/) | `rag` + `context` + `prompt` + `guardrails` | MVP build | [`docs/showcase-plans/02-rag-support-bot-PLAN.md`](../docs/showcase-plans/02-rag-support-bot-PLAN.md) |
| 03 | [`memory-checkpoint-stress/`](./03-memory-checkpoint-stress/) | `memory` (FsMemoryStore + crash recovery) | MVP build | [`docs/showcase-plans/03-memory-checkpoint-stress-PLAN.md`](../docs/showcase-plans/03-memory-checkpoint-stress-PLAN.md) |
| 04 | [`orchestration-handoff/`](./04-orchestration-handoff/) | `orchestration` (`spawnSubAgent` + cascade abort) | MVP build | [`docs/showcase-plans/04-orchestration-handoff-PLAN.md`](../docs/showcase-plans/04-orchestration-handoff-PLAN.md) |

Run any showcase with `pnpm -C showcases/<name> start` (showcase 01 has
a `start:replay` for non-interactive CI mode). Each `<name>/README.md`
explains scenarios + pass criteria.

When a showcase starts, create its subdirectory here and populate it with
the standard 7-stage artifacts:

```
showcases/01-streaming-cli/
  PLAN.md            # Stage 1
  HYPOTHESIS.md      # Stage 2
  FRICTION_LOG.md    # Stage 3 (cumulative)
  OBSERVATIONS.md    # Stage 4
  HARVEST.md         # Stage 5
  FEEDBACK.md        # Stage 6
  src/               # Implementation
  cassettes/         # Recorded real-API runs
  README.md          # Reader-facing summary, written last
```

## How is this different from `examples/` and `apps/`?

| Layer | Purpose | Lives at |
|---|---|---|
| **examples** | Learn how to use a subsystem or composition | `examples/` |
| **showcases** (this directory) | Calibrate the library itself via 7-stage form-pressure experiments | `showcases/<n>/` |
| **apps** | Real, continuously-running agent applications | `apps/<name>/` |

The line is **purpose, not engineering effort**. A 200-line showcase is
fine — what makes it a showcase is the discipline (PLAN before code,
HYPOTHESIS before observation, ≥10 real-API runs before archival,
FRICTION_LOG → HARVEST → FEEDBACK).

Authoritative spec: [`docs/harness-one-form-coverage.md`](../docs/harness-one-form-coverage.md).

## Starting a new showcase

1. Confirm the form really is a showcase (not an example or an app) using
   the three-layer decision tree in
   [`docs/harness-one-form-coverage.md`](../docs/harness-one-form-coverage.md).
2. Read the full 7-stage method in
   [`docs/harness-one-showcase-method.md`](../docs/harness-one-showcase-method.md).
3. Copy the matching PLAN draft from `docs/showcase-plans/` to
   `showcases/<n>/PLAN.md` and refine it.
4. PLAN.md gate must pass before HYPOTHESIS; HYPOTHESIS gate must pass
   before Build. Don't skip gates — the value is in the discipline.
5. Timebox enforced. Overrun signals scope failure: stop and retro rather
   than push through.

## Promotion to CI as a regression line

Once a showcase has completed all 7 stages, its cassette feeds CI:

```yaml
# .github/workflows/ci.yml — illustrative
- run: pnpm tsx showcases/01-streaming-cli/src/main.ts --replay
```

Any change that breaks a showcase replay must either fix the change or
explicitly record the break in `MIGRATION.md`.
