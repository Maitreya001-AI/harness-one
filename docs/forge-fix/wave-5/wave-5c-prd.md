# PRD: Wave-5C — Package Boundaries & API Surface for 1.0-rc

**Version**: 1.0
**Created**: 2026-04-15
**Status**: Draft (Adversarial Review Pending — technical-skeptic next)
**Author**: product-advocate
**Wave**: 5C of Wave-5 (`wave-5/production-grade`)
**Depends on**: Wave-5B (complete), Wave-5A (complete)
**Feeds into**: Wave-5D (Observability canonical)

---

## 0. Pre-decided constraints (LOCKED — do not re-litigate)

Three decisions were made by the lead before this PRD and are non-negotiable:

| # | Decision | Implication for this PRD |
|---|---|---|
| **PD-1** | `@harness-one/cli` publishes independently on npm under the existing `@harness-one` scope (same org that owns `@harness-one/ajv`, `@harness-one/anthropic`, etc.) | PRD assumes a multi-package fan-out shape, not a single-package with subpath exports. |
| **PD-2** | Versioning is changeset `linked` lockstep — every `@harness-one/*` package bumps the same version simultaneously | PRD does not introduce independent version trains; one changeset = one coordinated release. |
| **PD-3** | api-extractor CI gate runs in **strict mode** — a diff in the generated `*.api.md` blocks merge (not just a warning) from 1.0-rc onward | PRD must include an explicit override/update workflow so iteration is not crippled. |

---

## 1. Executive Summary

Tighten the 1.0-rc API surface by (a) carving god-package `harness-one` (19,842 LOC, 14 subpath exports, ~90-symbol root barrel) into a three-package lineup — `harness-one` (runtime), `@harness-one/cli` (binary), `@harness-one/devkit` (eval + evolve + architecture-checker); (b) renaming `_internal/` → `infra/` with an ESLint rule that forbids external import; (c) closing `HarnessErrorCode` to a module-prefixed namespaced union (no `(string & {})` escape hatch); (d) requiring a JSDoc stability tag on every public export with api-extractor enforcing it in CI; (e) deleting the `eventBus` dead-stub from `packages/preset`; (f) splitting the 651-LOC `cli/templates.ts` god-module; (g) adding a doc-drift CI gate.

This is structural. Behavior does not change. Every downstream consumer breaks at import time — the 1.0-rc quality bar explicitly permits this, and the lead has ratified it in `decisions.md`.

---

## 2. Problem Statement

### 2.1 User pain

**Library consumers** today face a surface shaped like a minefield:

- **Three ways to import the same primitive** — `harness-one`, `harness-one/essentials`, `harness-one/core`. Users do not know which to trust; tree-shakers do not know what is real.
- **`cli/` and `evolve/` ship inside the runtime**. A server importing `createAgentLoop` pulls node-only CLI template strings and an evaluation harness into its bundle. This is not just bloat — it is an attack-surface expansion (CLI parsing paths live in prod code).
- **`_internal/` is internal in name only**. 19 files across `tools`, `observe`, `rag`, `session`, `memory`, `prompt`, `guardrails`, `context`, `orchestration` import from `_internal/`. It is infrastructure, and nothing marks it as "consumer-importable" or "library-only". A reckless consumer can depend on `packages/core/src/_internal/lru-cache.ts` today and the compiler will not stop them.
- **`HarnessErrorCode` lies about itself**. The union declares 25 codes but is typed `HarnessErrorCode | (string & {})` — an open sink. Consumers writing `switch (err.code)` have no way to exhaustively narrow. 27 raw-string throws bypass the declared union; `wc` counts 130 total `throw new HarnessError*` sites. The taxonomy is aspirational, not enforced.
- **No stability signal**. The repo contains **zero** JSDoc stability tags (`@experimental` / `@alpha` / `@beta` / `@stable`). Consumers cannot tell `createRAGPipeline` (arguably incubating) from `AgentLoop` (core-stable). Every upgrade is a lottery.
- **Dead code ships as runtime traps**. `packages/preset/src/index.ts` exposes `Harness.eventBus` as a `Proxy` that logs a deprecation warning and does nothing. Users who write `harness.eventBus.subscribe(...)` get silent no-ops in production.
- **API drift is unpoliced**. No api-extractor, no `*.api.md`, no merge gate. Any reviewer can miss a breaking rename on a Friday afternoon.

### 2.2 Why current structure fails 1.0-rc bar

1.0-rc = "the shape we promise to support for a year". You cannot promise a shape you cannot measure. Today:

- We cannot tell a reviewer "this PR changes the public API" without them reading every diff line.
- We cannot tell a consumer "this symbol is stable, that one is incubating."
- We cannot prevent a consumer from reaching into `_internal/`.
- We cannot prevent a developer from adding a 26th error code without updating the taxonomy.

Every one of these is a **1.0-rc disqualifier**.

### 2.3 Business impact of not fixing

- **Every future breaking change costs a major version** (SemVer). If the 1.0 surface contains accidents (dead `eventBus`, reachable `_internal`, untagged symbols), we ship them as contracts. Fixing them post-1.0 requires 2.0.
- **Adoption friction**: new users reading the `harness-one` README today confront three entry-point stories and no stability signal. Competing frameworks (Mastra, VoltAgent, Vercel AI SDK) ship smaller, clearer surfaces.
- **Security exposure**: runtime processes that `require('harness-one')` pull CLI template-string heuristics, JSON-Schema-as-prompt generators, and evaluation runners. A sandboxed agent worker does not need any of that; a CVE in `cli/templates.ts` becomes a CVE in the prod runtime.

---

## 3. Codebase reality check (verified against HEAD)

The brief made several claims. This PRD verified each:

| Claim in brief | Verified reality | Correction applied |
|---|---|---|
| "Root barrel ~90 symbols" | `packages/core/src/index.ts` = **216 lines, 21 `export` statements, ~90 named symbols when you count each name inside `{ ... }` re-export blocks** | Brief is correct in spirit. (The "21 statements" figure in my original briefing note was misleading — each statement re-exports up to 20 names.) |
| "`_internal/` 16+ external importers" | **19 files** import from `_internal/` across 9 submodules | Brief understated. Use "19 files across 9 domains" in ADR. |
| "`HarnessErrorCode` 21 declared vs 40+ throws" | **25** declared codes; **27** raw-string code literals in throw sites; **130** total `HarnessError*` throw occurrences across 42 files | Brief understated. Keep the qualitative claim (codes drift from throws) but use real numbers. |
| "`cli/templates.ts` 651 LOC" | **651 lines confirmed** | Accurate. |
| "Stability tags: 8 in library" | **Zero** `@experimental`/`@alpha`/`@beta`/`@stable` annotations in `packages/` | Brief was wrong; the 8 live in `docs/`, not in TSDoc. Starting from zero. |
| "`@harness-one/ajv` + `@harness-one/tiktoken` single-file packages" | Confirmed — each has one `src/index.ts` + peer deps | Accurate. |
| "`packages/full/`" | **`packages/full/` has a `dist/` but NO `package.json`, NO `src/`** — it is an abandoned build artifact | **Corrective: this is not a "meta-package", it is dead code to delete.** |
| "`eventBus` dead-stub in preset" | Confirmed at `packages/preset/src/index.ts:371–395` — a `Proxy` that warns and no-ops | Accurate. |

Baseline: `packages/core/src` is **65,299 LOC** total (not 19,842 — that number was pre-Wave-5B). Update the finding text; the god-package problem is worse, not better.

---

## 4. Goals & Non-goals

### 4.1 Goals

- **G-1 Intentional surface**: every symbol exported from any `@harness-one/*` package is there because a human decided it should be, not because a barrel re-exported it by accident.
- **G-2 Clean package boundaries**: a consumer who needs only the runtime does not pay for the CLI or the eval harness.
- **G-3 Failure-loud contracts**: invalid imports (e.g., reaching into `infra/`) fail at lint time; unknown error codes fail at compile time; undocumented public exports fail in CI.
- **G-4 Drift prevention**: api-extractor `*.api.md` is checked into git; any unapproved diff blocks merge.
- **G-5 Developer ergonomics survive**: the override path for legitimate API changes is one command (`pnpm api:update` + commit) and is documented in CONTRIBUTING.

### 4.2 Non-goals (explicitly deferred)

- **NG-1 Behavioral changes** — this wave is structural. Semantics of every remaining symbol are preserved. (Exception: deleting the `eventBus` dead-stub, which had no real semantics.)
- **NG-2 Actually publishing to npm** — publishing is Wave-5G / release-readiness. This wave only makes the packages publishable.
- **NG-3 Multi-tenant re-keying** — Wave-5E.
- **NG-4 Observability rework (MetricsPort, OTel canonical)** — Wave-5D.
- **NG-5 Removing `harness-one/essentials`** — essentials may or may not survive the barrel trim; the decision belongs to the ADR, not the PRD. (PRD only asserts it must be justified or removed.)
- **NG-6 Rewriting `cli/templates.ts` content** — split the god-module, do not rewrite templates.

---

## 5. User journeys / success criteria

### UJ-1: Runtime-only consumer (the 80% case)

> Alice builds a support-ticket classifier. She needs `AgentLoop`, `defineTool`, `createTraceManager`, and an OpenAI adapter.

```
pnpm add harness-one @harness-one/openai
```

- Her bundle contains **no CLI code**, **no eval runner**, **no evolve harness**.
- Her IDE autocomplete shows ~25 root-level symbols, each JSDoc-tagged `@stable`.
- She never sees `_internal`, `infra`, `HarnessErrorCode | (string & {})`, or `eventBus`.

**Measure**: `pnpm why` in her project shows no `@harness-one/cli` or `@harness-one/devkit` transitive dep. `import('harness-one')` resolves to a bundle ≤ target size (see F-1).

### UJ-2: CLI consumer

> Bob scaffolds a new agent project with `pnpm dlx @harness-one/cli init`.

```
pnpm add -D @harness-one/cli
```

- The binary `harness-one` is on his PATH.
- The package does not appear in his production `dependencies` tree.
- He does not transitively receive `@harness-one/devkit`.

**Measure**: the `bin` field lives on `@harness-one/cli`, not on `harness-one`. CI asserts `harness-one` has no `bin` field.

### UJ-3: Devkit consumer

> Carol is tuning an agent. She needs the evaluation runner, flywheel, and the architecture-checker.

```
pnpm add -D @harness-one/devkit
```

- She gets `createEvalRunner`, `createComponentRegistry`, `createRelevanceScorer`, and the architecture-checker without touching the runtime package.
- Her production container, which does not install devDependencies, pulls neither `@harness-one/devkit` nor `@harness-one/cli`.

**Measure**: a dependency graph test asserts `harness-one` does not depend on `@harness-one/devkit` or `@harness-one/cli`.

### UJ-4: Library contributor

> Dave submits a PR that renames `createAgentLoop` to `buildAgentLoop`.

- api-extractor CI step detects the `.api.md` diff.
- Merge is blocked with a comment naming the file and the changed symbol.
- Dave runs `pnpm api:update`, commits the regenerated `.api.md`, adds a changeset entry, and the human reviewer can now see the diff in one file.

**Measure**: a seed PR in the test plan intentionally renames a symbol and confirms CI blocks.

### UJ-5: Infra-internal developer

> Eve wants to reach into `_internal/lru-cache.ts` from her application code.

- Her IDE underlines the import path as an error.
- `pnpm lint` rejects the PR with `no-restricted-imports` naming the rule.

**Measure**: a seed import test asserts the lint rule fires.

---

## 6. Functional Requirements

Each requirement is numbered, has a P0/P1 priority, a measure-of-success, and an explicit map to the brief's Finding tags. All F-requirements are **P0 for 1.0-rc** unless marked otherwise.

### F-1 Root barrel narrowed

**Finding**: C-2
**Priority**: P0
**Ask**: Reduce `packages/core/src/index.ts` from ~90 re-exported names to a ceiling of **25 root-level symbols**. Every surviving symbol must be:
1. imported by at least one known downstream consumer (the monorepo itself is a valid consumer); AND
2. JSDoc-tagged `@stable` or `@beta` (not `@experimental` or `@alpha` — those must live on subpath exports only); AND
3. justified by a one-line comment in the barrel naming the user journey it serves.
**Measure**:
- `wc` of root barrel ≤ 25 exported names (counted by api-extractor).
- api-extractor report for `harness-one` main entry lists ≤ 25 exported declarations.
- PRD reviewer can read each surviving export's one-line justification.
**Migration**: symbols removed from the root barrel remain importable via subpath (`harness-one/observe`, `harness-one/memory`, etc.) for one major cycle. Symbols removed from subpaths too are breaking and listed in Section 8.

### F-2 `_internal/` → `infra/` with lint barrier

**Finding**: C-3
**Priority**: P0
**Ask**: Rename `packages/core/src/_internal/` to `packages/core/src/infra/` (or the name chosen by the ADR — see Section 9.e). Add an ESLint `no-restricted-imports` rule that:
- Permits imports of `infra/*` from **within the same package**.
- Forbids imports of `infra/*` from any other `@harness-one/*` package or from any external consumer.
- Surfaces a human message: "`infra/` is internal. Promote the symbol or use the existing public API."
**Measure**:
- The existing 19 files that currently `from '../_internal/…'` continue to work (they are in-package).
- A seed test file placed in `packages/openai/src/` that imports `harness-one/dist/infra/lru-cache.js` fails lint.
- Finding C-3 closed.

### F-3 `@harness-one/cli` extracted

**Finding**: ARCH-2 (partial)
**Priority**: P0
**Ask**: Create `packages/cli/` (new package, `@harness-one/cli`). Move `packages/core/src/cli/*` into it. The `bin` field moves with it. The `harness-one` package loses:
- `"./cli"` subpath export.
- `"bin": { "harness-one": "./dist/cli/index.js" }` field.
**Measure**:
- `harness-one` `package.json` contains no `bin` and no `cli` subpath.
- `@harness-one/cli/package.json` has `"bin": { "harness-one": "./dist/index.js" }`.
- Running `pnpm dlx @harness-one/cli --help` works in a scratch project that does not install `harness-one` transitively… **(correction)**… actually it will install `harness-one` because the CLI depends on it. The measure is: `harness-one`'s own test/lint does not import from `cli/`.
- Finding ARCH-2 partially closed (evolve half is F-4).

### F-4 `@harness-one/devkit` extracted

**Finding**: ARCH-2 (partial)
**Priority**: P0
**Ask**: Create `packages/devkit/` (new package, `@harness-one/devkit`). Move into it:
- `packages/core/src/evolve/*` (architecture-checker, component-registry, drift-detector, taste-coding)
- `packages/core/src/eval/*` (runner, scorers, generator-evaluator, flywheel)
The `harness-one` package loses its `"./eval"` and `"./evolve"` subpath exports.
**Measure**:
- `harness-one` has no `evolve` or `eval` subpath exports.
- `@harness-one/devkit` exports `createEvalRunner`, `createComponentRegistry`, `createRelevanceScorer`, plus the architecture-checker.
- `harness-one/package.json` does not depend on `@harness-one/devkit`.
- Finding ARCH-2 closed.

### F-5 Single-file packages: merge or keep?

**Finding**: ARCH-3
**Priority**: P1 (structural cleanup, not blocking any user journey)
**Ask**: Decide in the ADR whether to:
- (a) merge `@harness-one/ajv` + `@harness-one/tiktoken` into a single `@harness-one/native-deps` (or `@harness-one/bindings`) package; OR
- (b) keep them separate because each has its own peerDep tree and its own native-binary pain point.
The PRD does not pick; Section 9.c frames the question.
**Measure** (either path):
- No orphaned `dist/` without `package.json` (delete `packages/full/` — this is also a win here).
- Each remaining package has a non-empty `src/` and a `README.md` that explains why it is separate.

### F-6 `HarnessErrorCode` closed

**Finding**: M-3
**Priority**: P0
**Ask**: Replace `HarnessErrorCode | (string & {})` with a **closed** namespaced union. The taxonomy uses module prefixes: `CORE_*`, `TOOL_*`, `GUARD_*`, `SESSION_*`, `MEMORY_*`, `TRACE_*`, `CLI_*`, `ADAPTER_*`, `EVOLVE_*`, `EVAL_*`, `CONTEXT_*`. The exact prefix list belongs to the ADR (Section 9.f).
The `HarnessError` constructor's `code` parameter becomes `HarnessErrorCode` (closed) — no `(string & {})` escape hatch.
**Measure**:
- Every one of the 27 raw-string throw sites maps to a declared code.
- A TypeScript test asserts `switch (err.code) { ... }` is exhaustive (compile error if a new code is added but not handled).
- Count parity: declared codes ≥ used codes; CI diff script flags any drift.
- Finding M-3 closed.

### F-7 Stability tags on every public export

**Finding**: ARCH-4
**Priority**: P0
**Ask**: Every symbol in every `@harness-one/*` package's main entry and subpath entries carries exactly one of: `@stable`, `@beta`, `@alpha`, `@experimental`, `@deprecated`. api-extractor configuration rejects untagged public exports.
The default-tag policy (what happens if a contributor forgets) is Section 9.g — the ADR decides between "untagged = `@stable`" (adoption-friendly) and "untagged = build-fail" (rigor-friendly).
**Measure**:
- api-extractor run on HEAD reports zero untagged public symbols.
- A seed PR that adds an untagged export fails CI.
- Finding ARCH-4 closed.

### F-8 api-extractor CI gate (strict)

**Finding**: ARCH-4 (tooling half)
**Priority**: P0 (pre-decided as strict, PD-3)
**Ask**: Every `@harness-one/*` package runs api-extractor in CI. A diff between the generated `<pkg>.api.md` and the checked-in copy **blocks merge**. The override path is:
1. Contributor runs `pnpm api:update` locally.
2. Commits the regenerated `*.api.md` alongside the code change.
3. Human reviewer now has one file showing every API delta.
Section 6.9 documents the exact CI workflow.
**Measure**:
- A seed PR that changes a type signature without running `pnpm api:update` fails CI with a message pointing at the specific `*.api.md` file.
- A seed PR that runs `pnpm api:update` and commits the result passes.

### F-9 Delete `eventBus` dead-stub

**Finding**: ARCH-10
**Priority**: P0
**Ask**: Remove the `eventBus` property, the `EventBus` Proxy, the `eventBusWarnEmitted` flag, and the `EventBus` type re-export from `packages/preset/src/index.ts`. Remove `eventBus: EventBus` from the `Harness` interface at line 183.
**Measure**:
- `grep -r 'eventBus' packages/preset/src/` returns 0 hits.
- The `Harness` public interface no longer has an `eventBus` field.
- A listed migration entry in Section 8 tells consumers what to use instead (`onEvent()` per owning module).
- Finding ARCH-10 closed.

### F-10 `cli/templates.ts` split

**Finding**: M-11
**Priority**: P1 (ships under `@harness-one/cli` — not on the runtime hot path, but still a maintainability cliff)
**Ask**: Split the 651-LOC `templates.ts` into multiple files. Strategy options — the ADR picks (Section 9.d):
- (i) one file per template kind
- (ii) co-locate each template with its single consumer and delete the god-module
- (iii) keep a `templates/index.ts` barrel and split by domain (tool, guardrail, session, etc.)
**Measure**:
- Largest file in `packages/cli/src/` ≤ 200 LOC after the split.
- Each split file has a header comment naming its one consumer.
- Finding M-11 closed.

### F-11 Doc-drift CI gate

**Finding**: ARCH-10 (doc half)
**Priority**: P1
**Ask**: Every public export (defined as: present in any `*.api.md`) has a corresponding doc artifact. Implementation belongs to the ADR (Section 9.h): cross-check against `docs/reference/*.md`, or against a YAML manifest, or against TSDoc presence + length threshold.
The CI step fails if a symbol appears in `*.api.md` but has no doc entry, and fails if a doc entry references a symbol no longer in `*.api.md`.
**Measure**:
- Baseline measurement: run the check on HEAD, count unmatched symbols, publish that list.
- After PRs close the gaps, a seed PR adding a new untagged-doc export fails CI.

---

## 7. Non-functional requirements

### 7.1 Performance
- Build time across the monorepo does not regress > 15% (`pnpm -r build` before vs after).
- Bundle size of `harness-one` main entry **drops** by ≥ 30% (measured: `pnpm size-limit` on the main entry). Justification: cli + evolve + eval removed.

### 7.2 Security
- No regressions in the Wave-5A fail-closed posture (`createSecurePreset`, `redaction on`, `guardrail required`, `tool-registry quota`, `adapter allow-list`). All those ship on `harness-one`.
- CLI-specific attack surface (template-string parsing, `fs` scaffolds) is isolated to `@harness-one/cli`. Production images that `pnpm install --prod` do not pull the CLI.

### 7.3 Reliability
- Zero behavioral changes. All 7-wave test-suites pass unchanged. Migrations are purely import-path rewrites + error-code replacements.

### 7.4 Developer experience
- `pnpm install` on a fresh checkout + `pnpm -r build` completes on Node 18 LTS, Node 20 LTS.
- `pnpm api:update` documented in CONTRIBUTING.md with a worked example.
- Every breaking import path has a 1-line codemod suggestion (`sed`-style) in CHANGELOG.

### 7.5 Accessibility (developer-facing)
- All new error messages for lint rules, api-extractor, and doc-drift CI include a suggested fix command or a link.

---

## 8. Breaking changes inventory

This is 1.0-rc — consumers will need to migrate. Every item is called out here so the CHANGELOG and migration guide can be auto-derived.

| # | Change | What breaks | Migration path | Codemod? |
|---|---|---|---|---|
| B-1 | Root barrel trimmed to ~25 symbols | `import { X } from 'harness-one'` for X not in the 25 | Use the subpath export (`harness-one/observe`, etc.) | Yes — sed rewrite from an allow-list |
| B-2 | `harness-one/essentials` removed or retained (ADR decides) | `import … from 'harness-one/essentials'` | Switch to root barrel if ADR removes | Yes if removed |
| B-3 | `harness-one/cli` subpath removed | `import … from 'harness-one/cli'` | `pnpm add @harness-one/cli`; `import … from '@harness-one/cli'` | Yes |
| B-4 | `harness-one/eval` and `harness-one/evolve` subpaths removed | Those imports | `pnpm add -D @harness-one/devkit`; `import … from '@harness-one/devkit'` | Yes |
| B-5 | `harness-one` loses `bin` | `pnpm dlx harness-one` | `pnpm dlx @harness-one/cli` | Doc only |
| B-6 | `_internal/` → `infra/` + lint barrier | Any external code importing `_internal/*` (should not exist in well-behaved consumers but may exist in forks) | Remove the reach-in; promote the symbol via a proper export if genuinely needed | No — must be human review |
| B-7 | `HarnessErrorCode` closed | Consumers using bare string codes in `err.code` | Switch to the namespaced codes | Partial — codemod for the 21 old names; new callsites error at compile |
| B-8 | `Harness.eventBus` removed | Any consumer reading or calling `harness.eventBus.*` | Use the owning module's `onEvent()` API | Yes — codemod + deprecation already shipped in Wave-4 |
| B-9 | Stability tags required on new public exports | Contributor PRs that add untagged exports | Add a tag in the JSDoc | No — fail-forward |
| B-10 | `@harness-one/ajv` + `@harness-one/tiktoken` merge *(if ADR picks merge)* | Those package imports | `pnpm remove @harness-one/ajv @harness-one/tiktoken`; `pnpm add @harness-one/native-deps`; rename import specifier | Yes if merge happens |
| B-11 | `packages/full/` (dist-only, no `package.json`) deleted | Any consumer that somehow reached into `packages/full/dist/` | None — it was never published | No |
| B-12 | `cli/templates.ts` splits | Nothing (internal to `@harness-one/cli`) | N/A | N/A |

**Known downstream consumers that will break**: the monorepo itself (`packages/preset`, `packages/full` if revived, examples under `docs/`). No external consumers are known because no `@harness-one/*` package has been published yet (all versions are `0.1.0`, workspace-only). This is actually a gift — 1.0-rc is the first real public shape.

---

## 9. Decisions left to architect (ADR inputs)

The PRD frames, the ADR decides. Each item below is a question the three architect candidates must answer and design-arbiter must choose.

- **9.a Top-package name**. Keep `harness-one` as the npm name of the runtime package, or rename to `@harness-one/core` for consistency with the scope-prefix lineup (`@harness-one/cli`, `@harness-one/devkit`, `@harness-one/openai`, etc.)? Tradeoff: brand-recognition (keep `harness-one` as the marquee name) vs scope consistency (rename). Impact on PD-2 (changeset linked lockstep): consistent names make the `changesets/config.json` `linked` array trivial.

- **9.b Role of `packages/full/`**. It currently has `dist/` but no `package.json`. Options: (i) delete entirely; (ii) resurrect as a meta-package that `peerDependencies` every `@harness-one/*` for one-line installs; (iii) convert to an examples-only package not published. Recommend (i) unless there is a user journey for (ii) the PRD missed.

- **9.c `@harness-one/ajv` + `@harness-one/tiktoken` merge**. Merge into `@harness-one/native-deps`, or keep separate? Merge pros: fewer packages, simpler install, single README for native-binary quirks. Separate pros: each has independent peerDep range; failed install of one does not block the other; tree-shaking is per-package not per-submodule.

- **9.d `templates.ts` split strategy**. Per-template files; per-consumer co-location; or per-domain barrel. Constraint: whatever is picked must keep the largest file ≤ 200 LOC and every template file ≤ 100 LOC.

- **9.e `_internal/` rename**. Brief recommends `infra/`. Alternatives: leave as `_internal/` and rely purely on lint; use `private/`; use `internal/`. The ADR must pick one name and justify via the ESLint rule's wording.

- **9.f `HarnessErrorCode` closure pattern**. Choices: (i) string-literal union only (today's shape without the `(string & {})` escape); (ii) `const enum` (ABI-stable, but awkward across package boundaries); (iii) branded string type; (iv) template-literal union keyed by module prefix (`${Module}_${Suffix}`). Tradeoff: ergonomics (string literal wins) vs compile-time namespace enforcement (template-literal union wins).

- **9.g Stability-tag default policy**. Untagged public export treatment:
  - **Untagged = `@stable`** (adoption-friendly): lower friction for contributors; risk of accidentally locking in half-baked surfaces.
  - **Untagged = build-fail** (rigor-friendly): forces every contributor to make a conscious call; may frustrate early-stage feature work.
  The ADR must pick and document. My (PRD author) bias: **build-fail during 1.0-rc** to bootstrap a tagged surface, **default-to-@stable** after 1.0 ships.

- **9.h Doc-drift check shape**. What artifact represents "the docs"? Options: (i) each `*.api.md` cross-referenced against `docs/reference/<pkg>.md` headings; (ii) a YAML manifest `docs/_manifest.yaml` listing every symbol; (iii) TSDoc presence + a character-count threshold. Cost ordering: (iii) cheapest, (ii) most rigorous, (i) most automatic.

- **9.i `harness-one/essentials` fate**. Keep (second entry point for beginners) or delete (redundant with the trimmed root barrel)? If kept, it must be trimmed to match the 25-symbol root barrel or be explicitly smaller. If deleted, F-1 gets a B-2 migration entry.

---

## 10. Risks (product / user perspective)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | **Every downstream consumer breaks** | Critical | 1.0-rc quality bar explicitly accepts this (`decisions.md`). Codemods for B-1, B-3, B-4, B-7, B-8. Full CHANGELOG entry. |
| R-2 | **Strict api-extractor blocks routine iteration during rc** | High | F-8 override path is one command. CONTRIBUTING.md example. Temporary `api:update` PRs allowed in the rc window. |
| R-3 | **Top-package rename (9.a) costs npm ceremony** | Medium | If ADR picks rename: `harness-one` stays reserved; `@harness-one/core` is the new name; a one-time deprecation README in `harness-one@1.0.0` tells consumers to move. |
| R-4 | **Stability-tag policy (9.g) wrong default makes everything feel unfinished (or locks too much)** | Medium | ADR must justify. Starting from 0 tags is a gift — we can start conservative (`@beta` as default for rc) and upgrade to `@stable` per-symbol when we are ready. |
| R-5 | **Doc-drift CI rejects legitimate doc-deferred PRs** | Medium | F-11 implementation must allow a `// @docs:pending(<link>)` escape with a tracking issue, enforced to resolve before 1.0 final. |
| R-6 | **Splitting `cli/templates.ts` loses find-ability of templates for reviewers** | Low | The split retains a `templates/index.ts` barrel that re-exports by name; `grep` still works. |
| R-7 | **Devkit extraction strands consumers who today do `harness-one/eval`** | Medium | B-4 codemod. changeset note. Cross-reference in migration guide. |
| R-8 | **`infra/` import barrier catches in-tree tools that legitimately need it (e.g., integration tests of `lru-cache`)** | Low | Lint rule scopes to `src/` imports, not `__tests__/` — tests can continue to reach in. |
| R-9 | **`HarnessErrorCode` closure (F-6) breaks third-party error subclasses** | Medium | If any exist (we have not audited). ADR must include a survey of adapter packages throwing `HarnessError` directly. |
| R-10 | **Monorepo build ordering breaks because devkit depends on harness-one depends on infra** | Low | `pnpm -r build` with a dependency-aware scheduler handles this; CI matrix runs in topo order. |

---

## 11. Out of scope (explicitly deferred)

- Wave-5D: observability rework (MetricsPort, OTel canonical, Langfuse downgrade). Touches `observe/` but this PRD only relocates, does not rewrite.
- Wave-5E: trust boundary types (branded types, multi-tenant `tenantId:id` keys, `TrustedSystemMessage`, `SendHandle`).
- Wave-5F: minor cleanups.
- Actually firing `npm publish` — Wave-5G or release-readiness.
- OpenAPI-like generated docs site — separate workstream.
- Rewriting any template content — F-10 is a split, not a rewrite.
- Adding new features to `@harness-one/devkit` — extraction only.

---

## 12. Open questions for technical-skeptic to challenge

The PRD presents these up front so the skeptic can attack them directly and we do not lose a review cycle to re-inventing objections.

1. **"Why split `@harness-one/cli` at all if there are no external consumers yet?"** Counter: the bundle-size win for runtime consumers is real (UJ-1 measure), and publishing the first package with `bin: harness-one` inside `harness-one` would be a 1.0 commitment we cannot cheaply revoke. Splitting now is cheaper than splitting post-1.0.

2. **"25 symbols is arbitrary. Why not 15, or 40?"** The 25 number is calibrated to 7 families × 3-4 symbols each (`AgentLoop`/`createAgentLoop`, `defineTool`/`createRegistry`, `createTraceManager`/`createLogger`, `createSessionManager`, `createPipeline`, `createMiddlewareChain`, `HarnessError` + 3 subclasses). The ADR should ratify or refute the count; the PRD's claim is "≤ 25", not "exactly 25".

3. **"Merging `@harness-one/ajv` + `@harness-one/tiktoken` sounds neat but each has distinct peerDep + native-binary pain."** Fair. That is why 9.c defers to the ADR and the PRD does not pick.

4. **"Strict api-extractor block-merge will grind rc iteration to a halt."** The `pnpm api:update` override is a single command; the friction is a feature, not a bug. If the skeptic can demonstrate via an example PR that the override takes > 2 minutes of human time, we reconsider PD-3 (but that requires lead sign-off to soften).

5. **"You are asserting zero behavioral change, but `HarnessErrorCode` closure (F-6) is a behavioral change — `switch` statements that previously had a `default` branch now have dead code."** The `default` branch remains, it just becomes statically unreachable. That is a win (the TypeScript compiler now tells you). No consumer whose code was correct before this wave breaks after it at runtime.

6. **"Doc-drift CI (F-11) depends on an artifact format you have not picked."** Correct — 9.h. That is the first ADR item to answer; without a pick, F-11 cannot land. Ordering-wise, F-11 can ship last in the wave.

7. **"Renaming `harness-one` → `@harness-one/core` breaks every tutorial, blog post, and Stack Overflow answer written in the pre-1.0 era."** Not yet — pre-1.0 means we have negligible SEO surface (there are no published 0.x versions on npm). 1.0-rc is the first real thing. If ADR picks rename, the window to do it cheaply is now.

8. **"Closing `HarnessErrorCode` with `(string & {})` removed prevents third-party adapters from throwing adapter-specific codes."** True. The mitigation: the taxonomy includes an `ADAPTER_*` prefix and an explicit escape: `ADAPTER_CUSTOM` + a `details.adapterCode: string` field. Adapter authors get namespace hygiene; consumers keep exhaustive-match.

---

## 13. Acceptance criteria (for spec-reviewer and acceptance-reviewer)

This PRD is accepted when:

- [ ] Every Finding tag (C-2, C-3, M-3, M-11, ARCH-1/2/3/4/10) is mapped to at least one F-requirement.
- [ ] Every F-requirement has a measurable success criterion.
- [ ] Every pre-decided constraint (PD-1/2/3) is explicitly honored.
- [ ] The ADR open questions (9.a–9.i) are tractable — the architect candidates can produce three distinct designs around them.
- [ ] The breaking-change inventory (Section 8) lists every consumer-visible shift.
- [ ] The risks (Section 10) and open questions (Section 12) collectively anticipate the technical-skeptic's likely attacks.

---

## 14. Glossary

- **API extractor**: Microsoft tooling that generates a `.api.md` snapshot of a package's public types. A diff in this file indicates a public-API change.
- **Barrel**: an `index.ts` that re-exports from submodules.
- **Finding tag**: identifier (C-2, M-3, ARCH-4, etc.) from the Wave-5C brief mapping to a specific code-review finding.
- **fail-closed**: default behavior when configuration is absent is the safe one (deny, require, enforce) — not the permissive one.
- **god-package**: a single package that has grown to own too many concerns to be version-able, auditable, or tree-shakeable.
- **stability tag**: a JSDoc annotation (`@stable` / `@beta` / `@alpha` / `@experimental` / `@deprecated`) that tells consumers how much a symbol can move between versions.

---

**End of PRD. Submit to technical-skeptic for adversarial review.**
