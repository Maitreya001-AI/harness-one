# DESIGN · `apps/coding-agent` / `harness-one-coding`

> **Status: stub.** This document is a placeholder for the full design.
> The full design has not yet been authored.
>
> Per [`harness-one-form-coverage.md`](../harness-one-form-coverage.md):
> `apps/coding-agent/` is the development location for the
> `harness-one-coding` vertical npm package — **app and package are one
> directory, not two**. This decision is final unless explicitly revisited.

---

## What is in scope (when written)

- Architecture & ownership boundary with `harness-one` core
- Public API surface of the `harness-one-coding` npm package
- Tools / guardrails / memory design for long-horizon coding sessions
- 6-milestone roadmap, M0 → M5
- Open questions to resolve before M1 starts
- Engineering effort: months-level (not a showcase, not a quick win)

## Why this is a stub

The full design is "数月级别" engineering — it is not in scope for the
three-layer migration that introduced this directory. The stub exists so
README/index links resolve. The first owner of this app should expand
this file into the full RFC before any code lands at `apps/coding-agent/`.

## When to expand this stub

Trigger conditions:

1. Engineering capacity is allocated to start the coding-agent app, OR
2. The first PR proposing `apps/coding-agent/` opens a directory
   (whichever comes first).

At that point this stub becomes a formal RFC: assign an owner, set a
review deadline, answer open questions, lock the M0 scope.

## Related

- App-layer feedback mechanism:
  [`harness-one-app-feedback-loop.md`](../harness-one-app-feedback-loop.md)
- Subsystem coverage matrix entry:
  [`harness-one-form-coverage.md`](../harness-one-form-coverage.md) §
  "App layer (3 entries)"
- Showcases that de-risk this app's hardest subsystems:
  - [`docs/showcase-plans/03-memory-checkpoint-stress-PLAN.md`](../showcase-plans/03-memory-checkpoint-stress-PLAN.md)
    — proves memory layer can survive long agentic loops with crashes.
