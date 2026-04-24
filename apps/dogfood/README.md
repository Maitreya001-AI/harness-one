# @harness-one/dogfood

Dogfood agent that runs `harness-one` against every new GitHub issue in this
repository. It exists for one reason: if we are not using our own library in
production, we will not find the bugs our users find.

## What it does

On `issues: opened` the bot:

1. Reads the issue body from `$GITHUB_EVENT_PATH`.
2. Uses `createSecurePreset` (`guardrailLevel: 'standard'`) to run an
   Anthropic-backed loop with two read-only tools:
   - `search_recent_issues` — fuzzy match against the last 100 closed issues
     via `gh` CLI.
   - `render_triage_report` — deterministic markdown renderer.
3. Posts a single comment on the issue with suggested labels, potential
   duplicates, and one-line reproduction hints — always prefixed with a
   disclaimer that the content is machine-generated.
4. Writes a structured trace (`dogfood-reports/runs/<date>/<issue>.json`)
   containing `traceId`, cost, latency, events, and SHA-256 fingerprint of
   the issue body (never the body itself).

On any error the bot exits 0 and records the failure to the report; a
separate workflow step opens a tracking issue with label `dogfood-failure`
so the original issue is never blocked or polluted.

## Weekly rollup

`apps/dogfood/src/weekly.ts` aggregates the last 7 days of run reports into
`dogfood-reports/weekly-YYYY-WW.md` (total runs / success rate / p50-p95
latency / total cost / top error codes). A scheduled workflow commits the
file every Sunday.

## Running locally

```bash
export ANTHROPIC_API_KEY=sk-...
export GITHUB_EVENT_PATH=./tests/fixtures/issue-opened.json
export GITHUB_REPOSITORY=Maitreya001-AI/harness-one
pnpm --filter @harness-one/dogfood triage
```

Set `DOGFOOD_DRY_RUN=1` to skip the comment POST — the report is still
written. Set `DOGFOOD_MOCK=1` to replace the Anthropic adapter with a
deterministic fixture adapter (used by tests + CI smoke).

## Why not Octokit?

We deliberately shell out to `gh` CLI instead of importing Octokit. Two
reasons: (1) zero external runtime deps outside the peer `@anthropic-ai/sdk`,
matching the core library's supply-chain promise; (2) the `gh` binary is
already present on every GitHub-hosted runner, so the workflow is one
`run:` step shorter than it would be with npm deps.
