# dogfood Metrics

Operational metrics for the dogfood Issue Triage Bot. Updated monthly
during retro; raw run data lives in `dogfood-reports/` (created by the
bot on first run).

## Data sources

- Per-run trace files: `dogfood-reports/runs/<date>/<issue>.json`
  (written by `apps/dogfood/src/triage.ts` on every triggered issue).
- Weekly rollup: `apps/dogfood/src/weekly.ts` aggregates the past 7
  days of run reports into a Markdown summary.
- (Optional) External dashboards — none wired yet. Add links here when
  Langfuse / OTel exporters are connected.

## Key indicators (rolling 30 days)

| Metric | Current | Previous month | Trend |
|---|---|---|---|
| Triggered runs | TBD | TBD | TBD |
| Successful triages | TBD | TBD | TBD |
| Avg tokens / run | TBD | TBD | TBD |
| Avg wall clock / run | TBD | TBD | TBD |
| Total cost (USD) | TBD | TBD | TBD |
| Guardrail blocks | TBD | TBD | TBD |
| Tool errors | TBD | TBD | TBD |

> Baseline period: this table is empty until the dogfood reporter has
> accumulated at least 30 days of runs. The first
> [`RETRO/2026-Q2.md`](./RETRO/2026-Q2.md) is the trigger to fill it in.

## Anomaly history

Append one line per anomaly that affected a run, with date + cause +
remediation link. Examples that would qualify:

- API outages forcing fallback adapter activation
- Workflow timeouts (CI infrastructure, not the bot itself)
- Schema mismatches when harness-one bumps a major version

(No entries yet.)

## Retention

`dogfood-reports/` is checked into the repo (small JSON per run). When
storage becomes a concern, prune via a separate workflow rather than
overwriting in-place — the time series is the value.
