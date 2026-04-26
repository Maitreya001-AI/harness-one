# Apps

Real agent applications built on harness-one. Production-grade code,
either continuously running or maturing into a vertical package.

## Current apps

| App | Status | Feedback path |
|---|---|---|
| [`dogfood/`](./dogfood/) | running | [`HARNESS_LOG.md`](./dogfood/HARNESS_LOG.md) + `dogfood-reports/` + [`RETRO/`](./dogfood/RETRO/) |
| `coding-agent/` | planned | Same as `harness-one-coding` vertical package — see [design](../docs/app-designs/coding-agent-DESIGN.md) |
| `research-collab/` | planned | Multi-agent research collaboration — see [design](../docs/app-designs/research-collab-DESIGN.md) |

## How is this different from `examples/` and `showcases/`?

| Layer | Purpose | Lives at |
|---|---|---|
| **examples** | Learn how to use a subsystem or composition | `examples/` |
| **showcases** | One-off, 7-stage form-pressure experiments archived into CI | `showcases/<n>/` |
| **apps** (this directory) | **Long-term running** + **continuous feedback** | `apps/<name>/` |

Apps do not require the 7-stage method, but each app **must** maintain
the standardized feedback artifacts:

- `HARNESS_LOG.md` — cumulative friction log, appended every time a
  developer or operator hits a harness-one snag (no matter how minor).
- `METRICS.md` — running metrics or links to dashboards.
- `RETRO/<period>.md` — periodic retrospectives (monthly for high-traffic
  apps, quarterly otherwise).

Mechanism in detail:
[`docs/harness-one-app-feedback-loop.md`](../docs/harness-one-app-feedback-loop.md).

## Adding a new app

1. Create a subdirectory: `apps/<name>/`.
2. Required files:
   - `README.md` (project description + ops instructions)
   - `HARNESS_LOG.md` (start empty with template)
   - `METRICS.md` (start empty with template)
   - `RETRO/.gitkeep` (so the directory exists)
3. Add an entry to the table above.
4. The app must satisfy at least one of:
   - **continuously running** (cron / GitHub Action / event-triggered), or
   - **continuously maintained** (corresponds to a planned vertical
     package).
5. Update [`docs/harness-one-form-coverage.md`](../docs/harness-one-form-coverage.md)
   coverage matrix if the new app shifts subsystem coverage.

## App-as-package mode

Some apps double as the source repository for a vertical package — for
example `apps/coding-agent/` is also the `harness-one-coding` npm package.
In that mode:

- The app directory is the canonical development location (no separate
  `packages/harness-one-coding/`).
- Releases go through `pnpm changeset publish` directly from the app
  directory.
- The app dogfoods its own published API — first user is itself.

This is by design (see decision in
[`docs/harness-one-form-coverage.md`](../docs/harness-one-form-coverage.md)
"App-as-package" section). Future apps default to this mode unless they
have a concrete reason to split.
