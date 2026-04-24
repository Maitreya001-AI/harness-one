# ADR-NNNN · Imperative-mood title

- **Status**: Proposed | Accepted | Deprecated | Superseded by ADR-XXXX
- **Date**: YYYY-MM-DD
- **Deciders**: maintainer(s) / commit author(s)

## Context

Describe the forces in play. What problem are we solving? What
constraints are non-negotiable? What is the current state that this
decision changes? Two or three short paragraphs is usually enough.
Quote concrete numbers (latency, bundle size, error rates) where
they exist — vague rationale ages badly.

## Decision

State the position in one sentence first, then expand.

> **We will <do X> because <one-line rationale>.**

Use imperative mood ("Use factory functions, not classes"). Specify
exactly what is in scope and what is not — the next reader of this
ADR will use this section to test whether their proposed change
violates it.

## Alternatives considered

For each rejected option, give it a name and one to two lines on why
it lost. The goal is to save future contributors from re-running the
same evaluation.

- **Alternative A — <name>**: <why rejected>.
- **Alternative B — <name>**: <why rejected>.
- **Alternative C — do nothing**: <why insufficient>.

## Consequences

### Positive

- Concrete benefit one.
- Concrete benefit two.

### Negative

Be honest. Every decision costs something.

- Concrete cost / limitation one.
- Concrete cost / limitation two.

### Follow-ups

Optional. List ADRs, issues, or migration tasks this decision creates.

## Evidence

Three to five concrete pointers that prove the decision is implemented
today. Each pointer should be greppable — `path/to/file.ts:functionName`,
the ESLint rule that enforces it, or the test that locks the behavior.

- `packages/<pkg>/src/<file>.ts` — `<symbolOrFunction>`
- `packages/<pkg>/src/<other>.ts` — `<symbolOrFunction>`
- `eslint.config.js` — `<rule-id>` block enforcing the constraint
- `packages/<pkg>/src/__tests__/<file>.test.ts` — witness test

If you can't fill this section, the ADR is not ready to merge. Either
the implementation is missing (mark `Status: Proposed`) or the decision
isn't load-bearing enough to deserve an ADR.
