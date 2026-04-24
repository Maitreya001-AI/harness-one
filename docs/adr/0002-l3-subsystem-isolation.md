# ADR-0002 · Forbid imports between L3 subsystems

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

`harness-one`'s core package is split into three layers:

- **L1 `infra/`** — leaf utilities (`ids`, `backoff`, `lru-cache`,
  `redact`, `errors-base`).
- **L2 `core/`** — domain types, `AgentLoop`, error layer, cross-cutting
  ports (`MetricsPort`, `InstrumentationPort`).
- **L3 subsystems** — `orchestration`, `session`, `observe`,
  `guardrails`, `memory`, `tools`, `prompt`, `context`, `rag`,
  `evolve-check`, `redact`.

Without a hard boundary between L3 subsystems, ordinary engineering
gravity creates point-to-point imports: `tools` reaches into
`observe` for span helpers; `orchestration` peeks at `session` for
locking; `memory` borrows a `Logger` shape from `observe`. Each
edge looks harmless on its own. In aggregate they make the
dependency graph a hairball, break tree-shaking, and turn every test
of one subsystem into an integration test of all of them.

## Decision

> **L3 subsystems must not import each other — neither at runtime nor
> as type-only imports. Shared abstractions belong in L2.**

If subsystem A needs a type or function defined in B, the type/function
moves down into `packages/core/src/core/` (L2) where both can import
it without forming a cycle. The rule applies to relative paths
(`../<other>`) and to public subpaths (`harness-one/<other>`). Tests
are exempt because integration coverage often does need to wire two
subsystems together.

## Alternatives considered

- **Allow type-only cross-imports** — relax the rule for `import type`
  on the theory that types are erased at runtime. Rejected: the
  type-graph still couples the subsystems for build, makes
  refactoring one subsystem hurt the others, and obscures where the
  shared abstraction belongs (which is L2).
- **Topological ordering instead of full isolation** — declare a
  partial order so e.g. `observe` is "below" `tools` and importable.
  Rejected: every order we proposed had at least one pair where both
  subsystems wanted edges in both directions; the order bookkeeping
  was a worse problem than the cycle it was trying to prevent.
- **Trust the maintainers** — no lint enforcement, just a doc rule.
  Rejected: the rule was violated within months of being written down
  the first time. Lint is the only durable enforcement.

## Consequences

### Positive

- Each L3 subsystem is independently testable, documentable, and
  tree-shakeable. Bundling `harness-one/memory` alone does not pull
  in `observe` or `tools`.
- "Where does this new symbol live?" has a single answer: if more
  than one subsystem needs it, it goes to L2.
- Refactors of one subsystem cannot accidentally break a sibling.
- Adapter packages (`@harness-one/redis`, `@harness-one/anthropic`,
  …) consume each subsystem through the same public subpath users
  do, so the boundary is dogfooded.

### Negative

- A new shared abstraction has to graduate to L2 before it can be
  reused. There is no "private internal package" tier.
- Some intuitively sibling concepts (e.g. `redact` and `observe`)
  must publish their shared shapes through L2 ports rather than
  directly importing each other.
- Contributors hitting the lint rule for the first time often want
  to disable it locally. The rule's error message points at this
  ADR to forestall that.

## Evidence

- `eslint.config.js` — the `no-restricted-imports` block that maps
  every L3 subsystem to a list of forbidden sibling paths
  (relative + `harness-one/<sibling>`).
- `packages/core/src/orchestration/`, `…/session/`, `…/observe/`,
  `…/guardrails/`, `…/memory/`, `…/tools/`, `…/prompt/`,
  `…/context/`, `…/rag/`, `…/evolve-check/`, `…/redact/` — eleven
  L3 subsystem source roots that the lint rule covers.
- `packages/core/src/core/metrics-port.ts`,
  `packages/core/src/core/instrumentation-port.ts` — examples of
  shared abstractions placed at L2 so multiple subsystems can use
  them without crossing.
- `docs/ARCHITECTURE.md` — "Allowed import edges" section is the
  single-page restatement of the rule for PR review.
