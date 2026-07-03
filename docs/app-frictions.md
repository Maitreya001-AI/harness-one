# Cross-App Friction Summary

> This document tracks friction observed in **≥2 apps**. Single-app
> friction lives in that app's `HARNESS_LOG.md`. Promotion to this file
> means the friction is systemic and should be prioritized at the harness
> level.
>
> Maintenance cadence: every time an app completes a `RETRO/<period>.md`,
> the reviewer scans the other apps' `HARNESS_LOG.md` for overlap and
> promotes intersecting items here.

---

## Active (not yet resolved)

(None currently open. The two cross-app themes surfaced during the
`coding-agent` + `research-collab` build-out were both resolved on
2026-04-26 — see "Resolved (historical)" below. `apps/dogfood/` remains
the only continuously *running* app; `coding-agent` and `research-collab`
are built and feeding the loop via `HARNESS_LOG.md` but are not yet on a
cron/event trigger.)

## Resolved (historical)

### exactOptionalPropertyTypes conditional-spread tax

- **Affected apps**: `apps/coding-agent` (HC-001 · S3, HC-014 · S12),
  `apps/research-collab` (L-2026-04-26-004).
- **First reported**: 2026-04-26 (coding-agent HC-001, tool/shell wiring).
- **Root cause**: the repo-wide `exactOptionalPropertyTypes: true` forces a
  `...(v !== undefined && { field: v })` conditional-spread at every
  call-site that assigns an `X | undefined` to an optional `field?: X`.
  Both apps independently re-derived the same boilerplate — the same
  friction leaking through two different usage modes, which is what makes
  it harness-level rather than a per-app annoyance.
- **Status / resolution (2026-04-26)**: `harness-one/infra` now exports
  `omitUndefined<T>(obj)` plus the `WithoutUndefined<T>` type. Call-sites
  in `apps/research-collab/src/pipeline/run.ts` (6×) and
  `apps/coding-agent/src/cli/args.ts` (9×) migrated off the conditional
  spread. The helper is additive (no breaking change). No numbered
  issue/PR — resolved in-session; evidence lives in the per-app log
  entries above.

### Cost / observability ergonomics (silent $0, stubbed identifiers)

- **Affected apps**: `apps/coding-agent` (HC-005 · `recordUsage` requires
  `traceId`+`model`, HC-007 · `TokenUsage` not re-exported from `observe`,
  HC-012 · `Span.attributes` non-optional), `apps/research-collab`
  (L-2026-04-26-006 · `CostTracker` silently returns $0 with no pricing),
  `showcases/01-streaming-cli` (FRICTION_LOG · `ModelPricing` field names +
  `createStreamingMockAdapter` not auto-attaching `usage`, so cumulative
  cost stayed silently at 0).
- **First reported**: 2026-04-26.
- **Root cause**: the cost/observability surface let the zero-cost /
  stubbed-identifier failure mode stay *silent* and reachable from three
  independent entry points — a preset with no pricing table, a mock adapter
  with no `usage`, and a single-task caller with no `traceId`/`model`.
- **Status / resolution (2026-04-26, mostly resolved)**:
  `harness-one/observe` adds opt-in `defaultModelPricing` (with
  `DEFAULT_PRICING_SNAPSHOT_DATE`), and `createCostTracker` now `safeWarn`s
  when `budget > 0` but no pricing is configured (`warnUnpricedModels`
  default-on is the runtime guard); `recordUsage`'s `traceId`/`model` are
  relaxed with `'unknown'` fallbacks; `TokenUsage` is re-exported from
  `harness-one/observe`; `Span.attributes`/`events` are optional; and
  `createStreamingMockAdapter` auto-fills `config.usage` onto a terminal
  `done` chunk that omits it. Recorded as *mostly* resolved — the
  ergonomics gaps are closed; remaining follow-ups are discoverability /
  doc polish rather than API changes.

---

## Promotion procedure

When a `RETRO/<period>.md` lands for any app:

1. Open the latest `HARNESS_LOG.md` entries for every other running app.
2. For each open friction in the new RETRO, check whether **any** other
   app's HARNESS_LOG contains an entry pointing to the same root cause
   (same API, same error, same workaround pattern).
3. If yes → add a new bullet under "Active" with:
   - Title (one line, naming the API or behavior)
   - Affected apps + per-app `HARNESS_LOG` entry dates
   - First-reported date
   - Current status (issue/PR/RFC link if any)
   - Tracking issue (open one if none exists)
4. When PR + 1-month observation window confirms no new occurrences,
   move the bullet to "Resolved" with the resolution PR link.

## Why a separate file

Single-app friction is just an app problem and stays in that app's log.
Cross-app friction is a **harness-level** problem — by definition the
abstraction is leaking the same friction in multiple usage modes. These
deserve top-of-roadmap consideration. Tracking them here makes that
visible without forcing reviewers to grep every app's log on every PR.

See [`harness-one-app-feedback-loop.md`](./harness-one-app-feedback-loop.md)
§ "Cross-app summary maintenance" for the contract.
