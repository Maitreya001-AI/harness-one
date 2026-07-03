# RFC-NNNN · Imperative-mood title

- **Status**: draft | accepted | implemented | rejected | withdrawn | superseded by RFC-XXXX
- **Date**: YYYY-MM-DD
- **Author(s)**: name / handle
- **Tracking**: issue / PR / ADR links once they exist

## Summary

One paragraph. What changes, and why does it matter? A reader should be
able to decide from this alone whether the rest of the RFC is relevant to
them.

## Motivation

State the problem, not the solution. What hurts today? Quote concrete
evidence — a `HARNESS_LOG.md` / `FRICTION_LOG.md` entry, an error rate, a
workaround that appears in ≥ 2 places, a broken user expectation. Vague
motivation produces vague designs.

- What is the current behavior / state?
- Who is affected and how often?
- What is the cost of doing nothing?

## Design

The proposed change, in enough detail that someone other than the author
could implement it. Include:

- The public API surface (types, function signatures, subpath).
- How it composes with existing primitives (loop, tools, guardrails, …).
- Worked example(s) — the smallest code that shows the change in use.
- Non-goals — what this RFC explicitly does **not** change.

Prefer the smallest primitive that solves the problem. If the design adds
a fourth optional argument to an existing function, say why a new
primitive isn't better.

## Alternatives

For each rejected option, name it and give one to two lines on why it lost.
Include "do nothing" as an explicit alternative.

- **Alternative A — <name>**: <why rejected>.
- **Alternative B — <name>**: <why rejected>.
- **Do nothing**: <why the status quo is insufficient>.

## Migration / compatibility

- Is this a breaking change? For whom (root barrel, a subpath, an
  adapter)?
- What is the upgrade path? `@deprecated` aliases, codemod, doc note?
- Which `MIGRATION.md` section will this land under?
- Does it touch an `api-extractor` snapshot or a `publishConfig` surface?

If nothing breaks, say so explicitly — "additive, no migration required".

## Open questions

Everything still undecided. Convert each to a resolved note (or a
follow-up issue) before the RFC moves from `draft` to `accepted`.

- Question one …
- Question two …

## Resolution

_(Filled in when the RFC reaches `accepted` / `implemented` / `rejected`.)_

- Decision:
- ADR(s) produced:
- Shipping PR / MIGRATION entry:
