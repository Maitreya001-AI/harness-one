# ADR-0014 · Demote `createSecurePreset` from the root barrel; keep 18 value slots, not 19

- **Status**: Accepted
- **Date**: 2026-07-03
- **Deciders**: harness-one maintainers

## Context

The `harness-one` root entry (`packages/core/src/index.ts`) is a **curated
barrel**: a hand-picked set of value symbols covering the common
user-journeys, so prototypes and examples can `import { … } from
'harness-one'` without knowing every subpath. Everything else ships from its
owning subpath or a sibling package. Keeping the barrel small also keeps its
public-API contract stable and tree-shaking friendly.

The original layout reserved **19** value slots, and slot 11 was
`createSecurePreset` — the batteries-included secure entry point. That
placement is impossible without breaking the dependency graph:

- `createSecurePreset` lives in `@harness-one/preset`, which depends on
  `harness-one` (core) **and** on the provider adapter packages, which in
  turn depend on core.
- Re-exporting `createSecurePreset` from core's barrel would make core
  import from `@harness-one/preset` — i.e. `harness-one` →
  `@harness-one/preset` → (`@harness-one/anthropic` / `@harness-one/openai`)
  → `harness-one`. A dependency cycle.

That directly violates the acyclic layering rules
([ADR-0002](./0002-l3-subsystem-isolation.md) family; 00-overview rule 5:
"L5 preset/cli/devkit depend on `harness-one`, never the reverse") and the
zero-dependency posture of core ([ADR-0004](./0004-zero-runtime-deps-in-core.md)).
This ADR records why the barrel is 18, not 19 — a decision previously noted
only in prose in `docs/architecture/00-overview.md`.

## Decision

> **The root barrel carries exactly 18 value symbols.
> `createSecurePreset` is demoted out of the barrel and ships exclusively
> from `@harness-one/preset`, because re-exporting it from core would
> create the triangular dependency cycle `harness-one` →
> `@harness-one/preset` → adapters → `harness-one`.**

Consequences of the decision, made explicit:

- Users reach `createSecurePreset` via `import { createSecurePreset } from
  '@harness-one/preset'`, never from `'harness-one'`. The core barrel's
  header comment says so, at the demotion site.
- The 18 slots are the core-only, cycle-free primitives (loop, errors,
  tools, guardrails, observe, session factories). Anything that would force
  core to depend "upward" is disqualified from the barrel by construction.
- Type-only re-exports remain unbounded (zero runtime cost); this cap is
  about *value* symbols only.

## Alternatives considered

- **Keep 19 slots, re-export `createSecurePreset` from core.** Rejected:
  creates the `harness-one` → `@harness-one/preset` → adapters →
  `harness-one` cycle; breaks the acyclic layering rule and core's zero-dep
  guarantee.
- **Move `createSecurePreset` into core** so the barrel can carry it without
  a cycle. Rejected: the preset intentionally composes adapters, redaction,
  guardrails, and provider registries — pulling it into core would drag
  those dependencies into the zero-dep package (ADR-0004) and blur the
  core-vs-preset boundary.
- **Lazy / dynamic re-export** (`export const createSecurePreset = () =>
  import('@harness-one/preset')`). Rejected: hides a hard dependency behind
  runtime magic, defeats tree-shaking and static API extraction, and still
  couples core's contract to preset's.
- **Leave it undocumented** (the prose note in 00-overview is "enough").
  Rejected: the 19→18 demotion is a non-obvious, load-bearing decision that
  a future contributor could "helpfully" re-add without an ADR to stop them.

## Consequences

### Positive

- The dependency graph stays acyclic and core stays zero-dep; the barrel's
  contract is describable without reference to sibling packages.
- The barrel size is pinned and testable — a `public-api-shape` type-level
  test locks the exported set, so an accidental 19th slot fails CI.
- The core-vs-preset boundary is legible: if a candidate symbol would force
  an upward import, it doesn't belong in the barrel.

### Negative

- `createSecurePreset` — arguably *the* recommended production entry point —
  is not importable from `'harness-one'`, which surprises users who expect
  the "one obvious import". The README and core barrel comment have to call
  this out.
- The "18" is a curated number with judgment behind it; future additions
  need the same cycle check, and the count in docs/tests must be kept in
  sync when the set legitimately changes.

## Evidence

- `packages/core/src/index.ts` — module header: "The curated barrel exposes
  **18 value symbols** … `createSecurePreset` is **not** re-exported here —
  it ships exclusively from `@harness-one/preset` to avoid a three-leg cycle
  (`harness-one` → `@harness-one/preset` → `harness-one`)"; the 18 numbered
  `export { … }` slots follow.
- `packages/preset/src/index.ts` — where `createSecurePreset` actually
  ships.
- `packages/core/tests/type-level/public-api-shape.test-d.ts` — locks the
  root barrel's exported shape.
- `docs/architecture/00-overview.md` § "导入路径" — the prose note this ADR
  formalizes ("18 个值符号 … 原 ADR 排布为 19 个槽位 … slot 11
  `createSecurePreset` 因三角循环风险下放到 `@harness-one/preset`").
- [ADR-0004](./0004-zero-runtime-deps-in-core.md) /
  [ADR-0002](./0002-l3-subsystem-isolation.md) — the zero-dep and
  layering rules that make the cycle disqualifying.
