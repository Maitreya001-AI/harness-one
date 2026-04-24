# i18n Strategy

`harness-one` is targeting open-source distribution beyond the
original Chinese-speaking contributor core. The principal
distribution language for documentation must be English — npm
listings, GitHub SEO, enterprise procurement audits, and every
AI-powered code assistant indexing this repo assume English first.

This document inventories what currently lives in Chinese,
prioritizes what to translate, and captures the decisions we've
already made so a future translation PR doesn't have to rediscover
them.

**Scope of this doc**: planning only. No translation is performed in
the same PR — that is a separate, non-trivial engineering effort.

## Current-state inventory

Measured by number of CJK Unified Ideograph codepoints (`U+4E00..U+9FFF`)
in each Markdown file. Files with ≤50 CJK characters are treated as
"effectively English" (counts in that bracket are invariably either
quoted identifiers or brand names like `中文版`).

### Already English (no action)

- `README.md` — canonical English landing page.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`.
- `docs/adr/*.md` — architecture decision records (0000–0010).
  The ADR template and every ratified ADR are English-first.
- `docs/chunking-spec.md`, `docs/embedding-spec.md`,
  `docs/provider-spec.md`, `docs/retriever-spec.md` — adapter
  contracts surfaced to external integrators.
- `docs/release.md` — release engineering runbook (this PR).
- `MIGRATION.md` — breaking-change ledger.

### Intentionally bilingual (keep both)

- `README.zh-CN.md` — mirror of `README.md`. This file is a **feature**,
  not a gap: it signals to a Chinese-speaking first-time visitor that
  the project welcomes them. The English `README.md` links to it at
  the top; any future translation update should keep both files in
  sync, not delete one.

### Needs translation — P0 (blocks first npm release)

These are the docs a new adopter hits after the README. If an
English-speaking developer can't follow the architecture after 10
minutes, they close the tab.

| File                                                | CJK chars |
| --------------------------------------------------- | --------- |
| `docs/architecture/00-overview.md`                  | 1686      |
| `docs/architecture/01-core.md`                      | 2379      |
| `docs/architecture/02-prompt.md`                    | 501       |
| `docs/architecture/03-context.md`                   | 1124      |
| `docs/architecture/04-tools.md`                     | 936       |
| `docs/architecture/05-guardrails.md`                | 1411      |
| `docs/architecture/06-observe.md`                   | 2855      |
| `docs/architecture/07-session.md`                   | 1078      |
| `docs/architecture/08-memory.md`                    | 1471      |
| `docs/architecture/09-eval.md`                      | 737       |
| `docs/architecture/10-evolve.md`                    | 820       |
| `docs/architecture/11-cli.md`                       | 916       |
| `docs/architecture/12-orchestration-multi-agent.md` | 1964      |
| `docs/architecture/13-rag.md`                       | 1329      |
| `docs/architecture/14-advanced.md`                  | 972       |
| `docs/architecture/15-redact.md`                    | 730       |
| `docs/architecture/16-evolve-check.md`              | 840       |
| `docs/architecture/17-testing.md`                   | 394       |

Total: ~21 200 CJK characters, ~18 files. Rough effort estimate at
~400 characters/hour of careful translation = 50–60 engineering
hours. The architecture docs are the spec that every code reviewer
cites — translation accuracy matters more than throughput, so
budget accordingly.

### Needs translation — P1 (before public v1.0)

Internal planning + community docs. Publicly visible, but not on
the critical path to first-adopter success.

| File / tree                           | CJK chars (approx)         |
| ------------------------------------- | -------------------------- |
| `docs/testing-plan.md`                | 798                        |
| `docs/testing-plan/P0-*.md`           | ~2 500 across 7 files      |
| `docs/testing-plan/P1-*.md`           | ~2 400 across 5 files      |
| `docs/testing-plan/P2-*.md`           | ~1 500 across 3 files      |

The testing plan is load-bearing for project governance but isn't
front-of-funnel for first-time users.

### Mixed / internal (defer indefinitely)

- Track-P's own prompts and internal team-facing notes that happen
  to land in docs. These are workflow artifacts, not product docs —
  translate only if they become externally cited.

## Decisions pinned

1. **`README.md` stays as the canonical English landing page.** We do
   NOT create `README.en.md` — that would imply `README.md` is the
   non-English default, which is the wrong signal for an
   international open-source project.
2. **`README.zh-CN.md` stays.** Mirror files for non-English
   audiences are additive value, not technical debt.
3. **Chinese inline comments inside `packages/*/src/**` are not in
   scope for this doc.** A future pass can audit them against
   `docs/ARCHITECTURE.md`'s "reviewers read code, not translations"
   convention; until then, treat them as code-level notes that
   won't surface to consumers through published `.d.ts`.
4. **No machine translation.** The architecture docs carry
   semantics — "subsystem", "middleware", "ports", "layer" —
   where a wrong synonym changes the contract. Every translation PR
   must be reviewed by someone who can read both the source doc
   and the implementation it describes.

## Tracking

A translation pass is too large for a single PR. The suggested
execution unit is one architecture doc per PR:

1. Create a branch `i18n/en-<doc-slug>`.
2. Translate the doc in place — replace the Chinese with English,
   keep the filename. The zh-CN audience is served via git history;
   we do not maintain per-file `foo.zh-CN.md` mirrors for the
   architecture docs.
3. Call out any subtle terminology choices in the PR body so
   reviewers can cross-check.
4. Remove the file's row from the P0/P1 table in this doc.

Open issues tagged `i18n` as each doc is claimed, so two people
don't translate the same file.
