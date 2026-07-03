# Requests for Comments (RFCs)

This directory holds **Requests for Comments (RFCs)** for `harness-one`.
An RFC is a written proposal for a change that is large enough, or
contested enough, that it deserves discussion *before* code is written.

RFCs are where a design is argued. [ADRs](../adr/README.md) are where a
decision is recorded. The two are complementary: an RFC often *ends* in an
ADR (the accepted design distilled to its load-bearing decision), but not
every ADR needs an RFC, and not every RFC produces exactly one ADR.

## RFC vs. ADR — which do I write?

| | **RFC** (`docs/rfc/`) | **ADR** (`docs/adr/`) |
|---|---|---|
| Purpose | Propose and debate a design *before* it lands | Record a decision *after* it is made |
| Tense | Future ("we should…") | Past/present ("we decided…", "we do…") |
| Size | A change touching multiple subsystems, a new public surface, or a breaking change | A single non-obvious decision |
| Lifecycle | `draft → accepted → implemented` (or `rejected`/`withdrawn`) | `Proposed → Accepted → Deprecated/Superseded` |
| Evidence | Not required (the code doesn't exist yet) | **Required** — greppable pointers to shipped code |
| Ends in | Often one or more ADRs + a MIGRATION entry | Nothing further; it *is* the record |

Rules of thumb:

- **Reach for an RFC** when the change is big enough that you want
  agreement before investing in the implementation: a new sibling package,
  a new public subpath, a breaking change to the `AgentAdapter` contract,
  a cross-cutting refactor, or anything the [ROADMAP](../ROADMAP.md)
  Governance section says needs public review.
- **Reach for an ADR** when the decision is already made and you just need
  to capture *why* — a local design call, a safety default, an
  import-direction rule. See
  [`docs/adr/README.md` § "When to write an ADR"](../adr/README.md#when-to-write-an-adr).
- **Skip both** when the change is a routine bug fix, a doc edit, or a
  decision that's obvious from the code plus a one-line comment.

If an accepted RFC changes something non-obvious about the architecture,
land the corresponding ADR(s) in the same PR (or a fast follow) and
cross-link them. The RFC is the discussion; the ADR is the durable record.

## Numbering

- IDs are zero-padded four-digit integers, monotonic, **never reused**.
- Reserve the next ID with `ls docs/rfc/ | grep -E '^[0-9]' | tail -n 5`.
- Filename: `NNNN-short-slug-in-kebab-case.md` (e.g.
  `0001-message-content-blocks.md`).
- The title inside the document repeats the number: `# RFC-NNNN · Title`.
- `0000-template.md` is the blank template — copy it, don't edit it.

RFC and ADR numbers are **independent sequences**. RFC-0007 and ADR-0007
are unrelated documents; cross-reference by the full `RFC-NNNN` /
`ADR-NNNN` label to avoid ambiguity.

## Lifecycle

```
draft ──► accepted ──► implemented
  │           │
  │           └────► superseded by RFC-XXXX
  ├──► rejected
  └──► withdrawn
```

- **draft** — open for comment. The proposal is not final; the author is
  actively seeking feedback. Mark this in the PR description.
- **accepted** — the design is agreed. Implementation may proceed. Record
  any load-bearing decisions as ADRs.
- **implemented** — the code has landed. Update the RFC's `Status:` line
  and add a pointer to the shipping PR / ADR(s) / MIGRATION entry.
- **rejected** — the proposal was considered and declined. Leave the file
  in place; the negative record is valuable.
- **withdrawn** — the author pulled the proposal before a decision.
- **superseded by RFC-XXXX** — replaced by a newer proposal. Do not delete
  the old file; add a one-line pointer at the top.

RFCs, like ADRs, are **append-only history** once past `draft`. Refine an
accepted RFC by superseding it, not by rewriting its Design section.

## Format

Every RFC follows [`0000-template.md`](./0000-template.md). The required
sections are:

- **Summary** — one paragraph: what changes and why it matters.
- **Motivation** — the problem, with concrete evidence (friction-log
  entries, error rates, repeated workarounds).
- **Design** — the proposed change in enough detail to implement.
- **Alternatives** — other options and why they lost.
- **Migration / compatibility** — what breaks, and the upgrade path.
- **Open questions** — what still needs to be decided.

## Cross-referencing

- Architecture docs and ADRs may link to an RFC for the *discussion*
  behind a decision, using an ordinary relative link — the same way ADRs
  are linked from `docs/architecture/`. (No live example here on purpose:
  the first RFC doesn't exist yet, and a placeholder link would rot.)
- An RFC links forward to the ADR(s) it produced and the MIGRATION entry
  it generated, so a future reader can trace proposal → decision → change.

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](./0001-content-blocks.md) | Content blocks on `Message` (thinking / image round-trip) | Accepted |
