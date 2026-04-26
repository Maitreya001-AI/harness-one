# `apps/coding-agent` METRICS

> Per the harness-one app feedback loop, this file aggregates the
> high-level numbers that tell whether `coding-agent` is healthy:
> task success rate, mean wall-clock, mean cost, abort distribution.
>
> Rows are filled in by the operator (or the operator's nightly job)
> after each run / cohort. The MVP success thresholds from
> [`docs/coding-agent-DESIGN.md`](../../docs/coding-agent-DESIGN.md) §2.3
> are repeated as targets in the table.

## Success criteria (from DESIGN §2.3)

| Metric | Target |
|---|---|
| Task success on the 5-task harness-one suite | ≥ 4/5 with quality ≥ 3/5 |
| Repeated-task crash rate | 0 fatal crashes over 100 runs |
| Mean cost per task | < $1.00 |
| Mean wall-clock per task | < 30 minutes |
| Ctrl+C clean exit | < 5 seconds |
| `--resume` recovery | Pass (kill + resume completes) |

## Latest cohort

| Field | Value | Notes |
|---|---|---|
| Cohort started | TBD | filled in once the first 5-task run lands |
| Tasks attempted | 0 | |
| Tasks completed | 0 | |
| Mean wall-clock | — | |
| Mean cost | — | |
| Aborts (budget / signal / error) | 0 / 0 / 0 | |

## Ongoing counters (cumulative)

| Counter | Value |
|---|---|
| Total runs | 0 |
| Tool calls (read_file) | 0 |
| Tool calls (write_file) | 0 |
| Tool calls (shell) | 0 |
| Tool calls (run_tests) | 0 |
| Approval prompts | 0 |
| Approval denials | 0 |

## How to refresh

```bash
# Walk the trace directory and aggregate
node tools/aggregate-coding-traces.mjs ~/.harness-coding/traces > METRICS.snapshot.json
```

(That helper script is part of the post-MVP roadmap; see RETRO entries.)
