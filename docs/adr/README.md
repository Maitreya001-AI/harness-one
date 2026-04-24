# Architecture Decision Records

This directory holds the **Architecture Decision Records (ADRs)** for
`harness-one`. An ADR captures a single non-obvious design decision,
the alternatives that were rejected, and the consequences the project
has accepted in exchange.

ADRs are not API docs and not changelogs. They exist so that a
contributor reading the code six months from now can answer
"why did we do it this way?" without paging through pull-request
history.

## Format

ADRs use a trimmed **MADR 4.0 / Nygard hybrid** with the following
sections (all required):

```
# ADR-NNNN · Imperative-mood title

- **Status**: Accepted | Proposed | Deprecated | Superseded by ADR-XXXX
- **Date**: YYYY-MM-DD
- **Deciders**: maintainers / commit author(s)

## Context
The forces in play. What problem are we solving?

## Decision
The position we have chosen. State it as one sentence first, then
expand. Use imperative mood ("Use factory functions, not classes").

## Alternatives considered
Each rejected option, with one to two lines on why it was rejected.

## Consequences
Both positive **and** negative consequences. Be honest about what
this decision costs.

## Evidence
Three to five concrete pointers (`path/to/file.ts:fn`, ESLint rule,
test) that prove the decision is implemented today. If you can't fill
this section the ADR isn't ready to merge.
```

A blank template is in [`0000-adr-template.md`](./0000-adr-template.md).
Copy it to a new file and replace the placeholders.

## When to write an ADR

Write one when **all** of these are true:

1. The decision is non-obvious from reading the code.
2. There is a credible alternative someone might propose.
3. Reversing the decision would touch more than one subsystem.

Concrete triggers:

- A new layer or import-direction rule that ESLint will enforce.
- Picking one of several competing libraries / patterns / interfaces.
- A safety default (fail-closed vs. fail-open, hard limit vs. warn).
- A backward-incompatible change to a public surface.
- A "we are choosing not to ship X" decision (negative space matters too).

Skip an ADR when the decision is local (a single file or function),
when it's a routine bug fix, or when the rationale is already obvious
from the code and a code comment.

## Numbering

- IDs are zero-padded four-digit integers, monotonic, **never reused**.
- Reserve the next ID by `ls docs/adr/ | tail -n 5`.
- Filename: `NNNN-imperative-title-in-kebab-case.md`.
- Title in the document repeats the number: `# ADR-NNNN · Title`.

## Status lifecycle

```
Proposed ──► Accepted ──► Deprecated
                  │
                  └────► Superseded by ADR-XXXX
```

- **Proposed** — open for discussion. Mark in the PR description that
  the decision is not final and tag the owner.
- **Accepted** — currently in force. The Evidence section must point
  to real code.
- **Deprecated** — no longer in force; the rule it imposed has been
  retired. Leave the file in place.
- **Superseded by ADR-XXXX** — replaced by a newer decision. Do not
  delete the old file; future readers need the historical context.

When you supersede an ADR, edit the old file's `Status:` line and add
a one-line pointer at the top: `> Superseded by [ADR-XXXX](./XXXX-...md).`

## Editing existing ADRs

ADRs are **append-only history**. Do not rewrite the Context or
Decision of an Accepted ADR — write a new one and supersede instead.
Typo fixes and broken-link repairs are fine; substantive content
changes are not.

The Evidence section is the one exception: when files are renamed or
moved, update the pointers so the ADR keeps its grep value. Note the
update in the same commit message.

## Cross-referencing from architecture docs

The per-subsystem docs in [`../architecture/`](../architecture/) are
free to link out to ADRs:

```markdown
See [ADR-0006](../adr/0006-fail-closed-guardrail-default.md)
for the fail-closed rationale.
```

ADRs link back the same way. Architecture docs describe **what** the
system does today; ADRs explain **why** that's the shape.

## Index

| ID                                               | Title                                                                  | Status   |
| ------------------------------------------------ | ---------------------------------------------------------------------- | -------- |
| [0001](./0001-no-graph-dsl.md)                   | Use an explicit loop, not a graph DSL                                  | Accepted |
| [0002](./0002-l3-subsystem-isolation.md)         | Forbid imports between L3 subsystems                                   | Accepted |
| [0003](./0003-factory-functions-not-classes.md)  | Construct primitives through factory functions, not `new`              | Accepted |
| [0004](./0004-zero-runtime-deps-in-core.md)      | Keep `harness-one` core at zero runtime dependencies                   | Accepted |
| [0005](./0005-trace-cost-token-unified.md)       | Unify trace, cost, and token usage on one identifier                   | Accepted |
| [0006](./0006-fail-closed-guardrail-default.md)  | Default guardrail pipeline to fail-closed                              | Accepted |
| [0007](./0007-trusted-system-message-brand.md)   | Brand `SystemMessage` with a process-local symbol                      | Accepted |
| [0008](./0008-adapter-conformance-not-mocks.md)  | Test adapters with shared conformance suites                           | Accepted |
| [0009](./0009-streaming-hard-limits.md)          | Treat streaming size limits as hard caps, not warnings                 | Accepted |
| [0010](./0010-observe-port-vs-implementation.md) | Define `MetricsPort` in core; ship implementations as sibling packages | Accepted |
