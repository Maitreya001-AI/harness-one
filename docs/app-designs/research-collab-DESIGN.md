# DESIGN · `apps/research-collab`

> **Status: stub.** This document is a placeholder for the full design.
> The full design has not yet been authored.

---

## Inception scope (from the migration index)

- Multi-agent research collaboration pipeline
- Engineering effort: 1-2 weeks for an MVP
- Maturity: **inception** — 8 open questions remain to be answered before
  M1 RFC kickoff
- Default decision: **not** published as an npm package (revisit when
  needed)

## Open questions (to answer in M0 RFC)

The migration index calls out 8 open questions. They must be answered
before any code lands at `apps/research-collab/`:

1. Quality-first vs dogfood-first orientation (this is the most
   load-bearing question — see also `00-INDEX.md` reviewer concerns).
2. Single-process vs multi-process agent isolation.
3. Storage backend: in-memory only, or fs/vector-store?
4. Handoff schema: explicit zod, or harness-one orchestration primitives?
5. Trace tree shape across agents (parent/child boundary semantics).
6. Cost attribution per agent vs aggregate.
7. Failure semantics: cascade abort vs partial results.
8. End-of-session artifact format (what does "research output" mean?).

These overlap heavily with the
[`docs/showcase-plans/04-orchestration-handoff-PLAN.md`](../showcase-plans/04-orchestration-handoff-PLAN.md)
showcase. Run that showcase first to derisk Q4-Q7 cheaply before
committing to this app's design.

## Why this is a stub

`research-collab` is at inception stage — open questions outnumber
locked decisions. Promoting it to a full RFC requires a project owner
and explicit prioritization vs `coding-agent`. Stub exists so README
links resolve.

## When to expand this stub

Trigger conditions:

1. Showcase 04 (`orchestration-handoff`) completes its 7-stage cycle and
   produces FRICTION_LOG → HARVEST that informs Q4-Q7 above.
2. Engineering capacity is explicitly allocated to research-collab.
3. Q1 (quality-first vs dogfood-first) is decided — this gates everything
   else.

## Related

- Multi-agent showcase that de-risks this app:
  [`docs/showcase-plans/04-orchestration-handoff-PLAN.md`](../showcase-plans/04-orchestration-handoff-PLAN.md)
- Subsystem coverage matrix entry:
  [`harness-one-form-coverage.md`](../harness-one-form-coverage.md) §
  "App layer (3 entries)"
- App-layer feedback mechanism:
  [`harness-one-app-feedback-loop.md`](../harness-one-app-feedback-loop.md)
