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

(None yet — `apps/dogfood/` is the only app currently running. Cross-app
overlap will become visible once `coding-agent` or `research-collab`
ship and accumulate at least one quarter of `HARNESS_LOG` entries.)

## Resolved (historical)

(None yet.)

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
