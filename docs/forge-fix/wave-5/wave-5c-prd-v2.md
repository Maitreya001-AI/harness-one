# PRD v2: Wave-5C — Package Boundaries & API Surface for 1.0-rc

**Version**: 2.0 (supersedes v1.0 after technical-skeptic ACCEPT-WITH-PRD-EDITS)
**Created**: 2026-04-15
**Status**: Draft v2 (ready for ADR phase — 3× solution-architect competition)
**Author**: product-advocate
**Prior critique**: `docs/forge-fix/wave-5/wave-5c-prd-critique.md`
**Wave**: 5C of Wave-5 (`wave-5/production-grade`); splits into **main 5C** + **Wave-5C.1 follow-up**
**Depends on**: Wave-5B (complete)
**Feeds into**: Wave-5D (Observability canonical)

---

## 0. Pre-decided constraints (LOCKED)

| # | Decision | Implication |
|---|---|---|
| **PD-1** | `@harness-one/cli` publishes under the existing `@harness-one` npm scope | Multi-package fan-out shape, not single-package subpath. |
| **PD-2** | Changeset `linked` lockstep versioning — every `@harness-one/*` package bumps together | No independent version trains. |
| **PD-3** | api-extractor CI gate runs in **snapshot-diff mode** for 5C main body (stability-tag enforcement deferred to Wave-5C.1) — merge blocked on `*.api.md` drift without an accompanying regenerated snapshot | Iteration is protected; stability-tag strictness layers in via the follow-up. |

### Lead decisions applied in v2

- **LD-1**: **F-7 (stability tags) and F-11 (doc-drift CI) split out of main 5C into Wave-5C.1** (same branch, follow-up PR within 1 week of 5C main merge). Rationale: restores main 5C estimate to ~3 weeks and preserves "each wave independently reversible" discipline.
- **LD-2**: **api-extractor gate mode in main 5C = "snapshot diff only"**; full stability-tag enforcement layers in during 5C.1.
- **LD-3**: **F-14 (npm name reservation)** scoped to **placeholder-only** — a minimum-viable publish of `@harness-one/core` if and only if ADR 9.a picks rename. Full deprecation dance for the old `harness-one` name is **Wave-5G**.
- **LD-4**: Explicit scope reductions accepted from critique:
  - F-12 (workspace dep consistency) incorporated (now F-12).
  - F-13 (examples migration) incorporated (now F-13, **P0 blocker for F-4 acceptance**).
  - F-14 (npm placeholder) incorporated (partial, now F-14).
  - F-15 (codemod bundle) **deferred to Wave-5G** — release-readiness, not structural.

---

## 1. Executive Summary

Tighten the 1.0-rc API surface through a staged two-PR sequence on the `wave-5/production-grade` branch:

**Main 5C** (~3 weeks, 11 functional requirements): carve god-package `harness-one` into a three-package lineup — `harness-one` (runtime), `@harness-one/cli` (binary), `@harness-one/devkit` (eval + evolve + architecture-checker); rename in-package `_internal/` → `infra/` with an ESLint barrier (no cross-package migration — all 19 importers are intra-`packages/core/src/`); close `HarnessErrorCode` to a module-prefixed namespaced union; delete the `Harness.eventBus` dead-stub; split the 651-LOC `cli/templates.ts` god-module; add api-extractor CI in snapshot-diff mode; migrate the 20-file `examples/` directory in lockstep; reserve `@harness-one/core` on npm if the ADR picks the rename (placeholder only).

**Wave-5C.1 follow-up** (~1 week, 2 functional requirements): bolt on F-7 (JSDoc stability tag required on every public export) and F-11 (doc-drift CI); tighten api-extractor gate to enforce stability-tag presence.

Behavior does not change (exception: deleting `eventBus`, which had no real semantics). 1.0-rc quality bar accepts breaking changes — `decisions.md` ratifies.

---

## 2. Problem Statement

### 2.1 User pain (corrected against code HEAD)

Library consumers today face a surface shaped like a minefield:

- **Three redundant entry stories** — `harness-one` root, `harness-one/essentials`, `harness-one/core` subpath. Users do not know which to trust; tree-shakers do not know what is real.
- **`cli/` and `evolve/` ship inside the runtime**. A server importing `createAgentLoop` pulls node-only CLI template strings and an evaluation harness into its bundle. This is a **bundle-size** concern, not (as v1 incorrectly argued) a CVE attack-surface concern — `cli/templates.ts` is string constants, not executable parsing (E-8 correction).
- **`_internal/` is internal in name only — but the reach-in risk is via deep dist-path, not via the package's TS `exports` map**. 19 files in `packages/core/src/` currently import from `_internal/`; **all 19 are intra-`packages/core/src/`** (E-1 correction). The problem is not that cross-package consumers reach in today (they do not — the `exports` map does not expose `./_internal` or `./infra`). The problem is that (a) no lint rule *prevents future* external reach-in if someone adds a subpath export by mistake, and (b) `files: ["dist"]` ships `_internal/` artifacts that deep-path importers could reach via non-standard `harness-one/dist/_internal/...`. F-2 closes the future-reach-in gap via lint; it does not migrate any existing code.
- **`HarnessErrorCode` lies about itself**. The union declares **24** codes (E-2 correction — previous v1 said 25; verified at `packages/core/src/core/errors.ts:31-55`) but is typed `HarnessErrorCode | (string & {})` — an open sink. The open shape is **deliberate** (comment at `errors.ts:68-71` documents "accepts any string for forward compatibility, but callers are encouraged to use values from HarnessErrorCode"). Closing it is a real breaking change for adapter subclasses; F-6 must design the adapter-subclass migration.
- **No stability signal**. Zero `@stable`/`@beta`/`@alpha`/`@experimental` JSDoc tags in `packages/`. (7 `@deprecated` tags exist pre-Wave-5C — they must be respected by F-7 when that lands in 5C.1.) Every upgrade is a lottery.
- **Dead code ships as a runtime trap**. `packages/preset/src/index.ts:370-410` exposes `Harness.eventBus` as a `Proxy` that warns and no-ops (verified: throws `HarnessError('DEPRECATED_EVENT_BUS', …)` on method call). Users who write `harness.eventBus.subscribe(...)` get silent failure in production.
- **API drift is unpoliced**. No api-extractor, no `*.api.md`, no merge gate.

### 2.2 Why current structure fails 1.0-rc bar

1.0-rc = "the shape we promise to support for a year". You cannot promise a shape you cannot measure. Today:

- We cannot tell a reviewer "this PR changes the public API" without reading every diff line.
- We cannot prevent a future `./_internal` subpath export from accidentally leaking infrastructure.
- We cannot prevent a developer from adding a 25th error code without updating the taxonomy.
- (Wave-5C.1 concern) We cannot tell a consumer "this symbol is stable, that one is incubating."

### 2.3 Business impact

- **Every future breaking change costs a major version**. If 1.0-rc ships with accidents (dead `eventBus`, unpoliced error-code drift, leaky infra), we promise to carry them for a year.
- **Adoption friction**: competing frameworks (Mastra, VoltAgent, Vercel AI SDK) ship smaller, clearer surfaces.
- **Bundle weight** (not CVE): a runtime-only consumer today pays for CLI template strings and an evaluation harness in their Lambda cold-start. F-3 + F-4 target ≥ 30% main-entry shrink.

---

## 3. Codebase reality check (v2 corrections applied)

| Claim source | Verified reality | v2 correction |
|---|---|---|
| Root barrel size | `packages/core/src/index.ts` = 216 lines, 21 `export` statements, ~90 named symbols | unchanged |
| `_internal/` importers | **19 files, all intra-`packages/core/src/`** (E-1) | v1 implied cross-package migration; v2 clarifies: lint-rule-only work, no migration |
| `HarnessErrorCode` declared codes | **24** (E-2, verified at `errors.ts:31-55`) — not 25 | corrected |
| `HarnessErrorCode` throw sites | **152 total `throw new HarnessError*` across 47 files** (v1 said 130/42 — v1 understated). "Raw-string vs declared" breakdown not verified (requires semantic scan). | corrected |
| `cli/templates.ts` LOC | **651** confirmed | unchanged |
| Stability tags | **0** `@stable`/`@beta`/`@alpha`/`@experimental` in `packages/`; **7** `@deprecated` pre-existing | v2 acknowledges `@deprecated` exists and must survive |
| `packages/full/` | **No `package.json`, no `src/`, retains `dist/` + `node_modules/`** (E-3). Not reachable from workspace (`pnpm-workspace.yaml` matches `packages/*` but pnpm skips entries without `package.json`). Zero in-repo references. | Safe to delete; verify no CI path references it before deletion |
| `@harness-one/ajv` + `@harness-one/tiktoken` | each has single `src/index.ts` + `__tests__/` only | unchanged |
| `eventBus` Proxy dead-stub | `packages/preset/src/index.ts:170-230` + `:370-410` | unchanged |
| **cli/templates.ts reaches into harness-one subpaths** | **`templates.ts:15,53,99-100,142,193,236,281,320,377,437,510-511,573`** emit string templates containing `from 'harness-one/core'`, `'harness-one/prompt'`, `'harness-one/context'`, `'harness-one/tools'`, `'harness-one/guardrails'`, `'harness-one/observe'`, `'harness-one/session'`, `'harness-one/memory'`, `'harness-one/eval'`, `'harness-one/orchestration'`, `'harness-one/rag'`, `'harness-one/evolve'` (E-4) | **new verification**: the CLI's emitted scaffolds depend on subpath exports surviving F-1/F-3/F-4. New F-3 measure added. |
| **`examples/` imports** | **20 TypeScript files, 52 `from 'harness-one*'` occurrences**, including `harness-one/eval` (`full-stack-demo.ts:15,20`; `eval/llm-judge-scorer.ts:8,119`) and `harness-one/evolve` (none external; only `templates.ts` emits it) | **new F-13 owner'd as P0** |

Baseline: `packages/core/src` ≈ 65,299 LOC. God-package remains the headline finding.

---

## 4. Goals & Non-goals

### 4.1 Goals (main 5C)

- **G-1 Intentional surface**: every symbol exported from any `@harness-one/*` package is there because a human decided it should be.
- **G-2 Clean package boundaries**: runtime-only consumers do not pay for CLI or eval harness.
- **G-3 Failure-loud contracts (structural)**: invalid imports fail at lint time (F-2); unknown error codes fail at compile time (F-6). Doc-level failure (untagged exports, doc drift) lives in 5C.1.
- **G-4 Drift prevention (snapshot-level)**: api-extractor `*.api.md` checked into git; unapproved diff blocks merge. Stability-tag enforcement is 5C.1.
- **G-5 Developer ergonomics**: `pnpm api:update` is the one-command override; documented in CONTRIBUTING.md.

### 4.2 Non-goals

- **NG-1 Behavioral changes** (exception: `eventBus` deletion).
- **NG-2 Actually firing `npm publish`** on full release — Wave-5G. (Placeholder publish of `@harness-one/core` is F-14 scope.)
- **NG-3 Multi-tenant re-keying** — Wave-5E.
- **NG-4 Observability rework** — Wave-5D.
- **NG-5 Codemod bundle (F-15 from critique)** — deferred to Wave-5G release-readiness.
- **NG-6 Full deprecation ceremony for `harness-one` on npm** — Wave-5G.
- **NG-7 Rewriting any template content** — F-10 is a split.
- **NG-8 Stability tags (F-7) + doc-drift CI (F-11)** — Wave-5C.1 follow-up, not main 5C.

---

## 5. User journeys / success criteria

### UJ-1: Runtime-only consumer (80% case)

Alice installs `harness-one` + `@harness-one/openai`; gets `AgentLoop`, `defineTool`, `createTraceManager`; bundle contains no CLI, no eval.
**Measure**: `pnpm why` shows no `@harness-one/cli` or `@harness-one/devkit`; main-entry bundle ≥ 30% smaller than pre-5C.

### UJ-2: CLI consumer

Bob runs `pnpm dlx @harness-one/cli init`; the CLI scaffolds code that imports from `harness-one/core`, `harness-one/prompt`, etc.
**Measure**: `bin` field lives on `@harness-one/cli` only. Scaffolded code typechecks against the post-F-1 `harness-one` export map.

### UJ-3: Devkit consumer

Carol installs `@harness-one/devkit` as a devDependency; gets `createEvalRunner`, architecture-checker, evolve; production images (no devDeps) see neither.
**Measure**: `harness-one/package.json` does not list `@harness-one/devkit` as a dependency.

### UJ-4: Library contributor

Dave renames `createAgentLoop` → `buildAgentLoop`; CI detects the `*.api.md` diff and blocks merge with a message pointing at the file; Dave runs `pnpm api:update`, commits the regenerated snapshot, adds a `## API change rationale` section to the PR description, and the merge gate unblocks.
**Measure**: seed PR in the test plan confirms block + override cycle.

### UJ-5: Infra-internal reach-in

Eve tries to add `import { LRUCache } from 'harness-one/infra/lru-cache'` to `packages/openai/src/`. `pnpm lint` fails with `no-restricted-imports` naming the rule.
**Measure**: seed lint fixture asserts the rule fires.

### UJ-6: Examples repo stays green

Any `pnpm -C examples typecheck` run after F-3/F-4/F-1 land passes.
**Measure**: `pnpm -C examples typecheck` is a CI step; green on main-5C merge.

---

## 6. Functional Requirements (main 5C — 11 items)

Numbered F-1..F-6, F-8..F-10, F-12..F-14. (F-7 + F-11 moved to §10 Wave-5C.1. F-15 deferred to Wave-5G.)

### F-1 Root barrel narrowed

**Finding**: C-2 · **Priority**: P0

**Ask**: Reduce `packages/core/src/index.ts` from ~90 re-exported names to a ceiling of **≤ 25 value symbols + unbounded type-only re-exports** (E-8 correction). Type-only re-exports are SDK type contracts and do not contribute to runtime bundle weight or import-time surface; value symbols do.

Every surviving **value** symbol must:
1. be imported by at least one in-tree consumer (monorepo packages + `examples/` + `cli/templates.ts` emitted code count); AND
2. carry a one-line justification comment in the barrel naming the user journey it serves.
(Stability tags for these symbols land in 5C.1.)

**Candidate value-symbol list (13-17 items; ADR refines within ≤ 25 ceiling)** — derived by reverse-engineering current consumers:

1. `createAgentLoop` — primary factory (UJ-1)
2. `AgentLoop` — class, direct instantiation + type narrowing
3. `createSecurePreset` — Wave-5A fail-closed entry (UJ-1)
4. `createRegistry` — tool registry
5. `defineTool` — tool definition DSL
6. `createTraceManager` — observability entry
7. `createLogger` — observability entry
8. `createSessionManager` — session primitive
9. `createPipeline` — guardrail composition
10. `createMiddlewareChain` — middleware composition
11. `HarnessError` — base error
12. `MaxIterationsError` — common subclass
13. `AbortedError` — common subclass
14. `GuardrailBlockedError` — common subclass
15. `ToolValidationError` — common subclass
16. `TokenBudgetExceededError` — common subclass
17. `runInput` / `runOutput` / `runToolOutput` — guardrail convenience (counts as 3; may collapse to 1 namespace)

**Non-candidates moved to subpath-only** (examples — non-exhaustive): `createFallbackAdapter`, `createResilientLoop`, `createOrchestrator`, `createRAGPipeline`, `createEvalRunner` (moves to `@harness-one/devkit`), `createComponentRegistry` (moves to `@harness-one/devkit`), `createPromptBuilder`, `packContext`, `compress`, `createAdapterSummarizer`, `MessageQueue`, `toSSEStream`, `formatSSE`.

**Adapter factory note**: `createOpenAIAdapter`, `createAnthropicAdapter` are **not** in `harness-one` today (they live in `@harness-one/openai` / `@harness-one/anthropic`). They do not enter the `harness-one` barrel. ADR may decide to re-export them for discoverability; if yes, they consume 2 slots of the 25.

**Measure**:
- api-extractor report for `harness-one` main entry lists ≤ 25 **value** exports; type-only exports unbounded but named in the `.api.md` snapshot.
- Every surviving value export has a one-line justification comment in `index.ts`.
- ADR produces a final ratified list as an appendix; three architect proposals must each present a concrete list (not "approximately 25").

**Migration**: removed symbols remain importable via subpath exports where their subpath survives (see ADR 9.k for the final exports map).

### F-2 `_internal/` → `infra/` with in-package lint barrier

**Finding**: C-3 · **Priority**: P0

**Ask** (v2 corrected scope): Rename `packages/core/src/_internal/` to `packages/core/src/infra/` (ADR 9.e picks final name). Add an ESLint `no-restricted-imports` rule that:

- **Permits** imports of `infra/*` from anywhere **within `packages/core/src/`** (all 19 current importers stay green without code changes — the only change they see is the directory rename, handled by `sed`).
- **Forbids** imports of `infra/*` from any file **outside `packages/core/src/`** (other `@harness-one/*` packages, `examples/`, and hypothetical downstream consumers).
- Does **not** forbid `__tests__/` from reaching in — tests can import from `infra/*` freely.

**Work scope**: mechanical rename + one ESLint rule. No cross-package surgery. E-1-corrected effort: **hour-scale**, not "multi-day".

**Known limitation** (documented from critique): the lint rule does **not** prevent deep-dist-path reach-in (`harness-one/dist/infra/lru-cache.js`). That vector is closed by (a) the `exports` map not listing `./infra`, and (b) optionally narrowing `files` in `package.json` to exclude `dist/infra/` — ADR may decide this independently.

**Measure**:
- The 19 existing importers typecheck + lint green after the rename.
- A seed file under `packages/openai/src/` that imports `harness-one/dist/infra/lru-cache.js` OR tries `from '../../core/src/infra/lru-cache'` fails lint.
- Finding C-3 closed.

### F-3 `@harness-one/cli` extracted

**Finding**: ARCH-2 (partial) · **Priority**: P0

**Ask**: Create `packages/cli/` (new package, `@harness-one/cli`). Move `packages/core/src/cli/*` into it. The `bin` field moves with it. `harness-one` loses its `./cli` subpath export and its `bin` field.

**New measure (E-4)**: Before F-3 lands, add a build-time parser test: enumerate every `from 'harness-one/*'` string-literal in `cli/templates.ts` (verified list at HEAD: `core`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `eval`, `orchestration`, `rag`, `evolve`). Assert that **every one of these subpaths still resolves** against the post-F-1 / post-F-4 `harness-one/package.json#exports`. If F-4 removes `./eval` and `./evolve` (it does), `templates.ts` must be updated in lockstep to emit `from '@harness-one/devkit'` instead. The test fails the F-3 build if any emitted subpath is orphaned.

**Measure**:
- `harness-one/package.json` contains no `bin` and no `./cli` subpath.
- `@harness-one/cli/package.json` declares `harness-one` as a **regular `dependency`** (not `peerDependency`) so `pnpm dlx @harness-one/cli` resolves it (E-5 correction — v1 had a contradictory crossed-out clause).
- Build-time parser test (above) is green.
- `harness-one`'s own tests/lint do not import from `cli/`.
- Finding ARCH-2 partially closed.

### F-4 `@harness-one/devkit` extracted

**Finding**: ARCH-2 (partial) · **Priority**: P0

**Ask**: Create `packages/devkit/` (new package, `@harness-one/devkit`). Move `packages/core/src/evolve/*` and `packages/core/src/eval/*`. `harness-one` drops `./eval` and `./evolve` subpath exports.

**Acceptance blocker**: F-13 (examples migration) must land in the same PR or a same-week companion PR. If F-13 is not green, F-4 cannot merge.

**Measure**:
- `harness-one/package.json` exports map lacks `./eval` and `./evolve`.
- `@harness-one/devkit` exports `createEvalRunner`, `createComponentRegistry`, `createRelevanceScorer`, architecture-checker.
- `harness-one/package.json` does not depend on `@harness-one/devkit`.
- F-13 acceptance green.
- Finding ARCH-2 closed.

### F-5 `@harness-one/ajv` + `@harness-one/tiktoken` — merge or keep

**Finding**: ARCH-3 · **Priority**: P1

**Ask**: ADR decides between (a) merge into `@harness-one/native-deps`, (b) keep separate. Plus: delete `packages/full/` (E-3; no `package.json`, no `src/`, unreferenced in-workspace).

**Measure**:
- No orphaned `dist/` without `package.json` (i.e., `packages/full/` is deleted).
- Each remaining native-dep package has non-empty `src/` + `README.md` explaining its peerDep story.
- Prior to `packages/full/` deletion: CI audit confirms zero references in `.github/`, `pnpm-workspace.yaml` (implicit via `packages/*`), `tsconfig.json` paths, and tsup configs.

### F-6 `HarnessErrorCode` closed

**Finding**: M-3 · **Priority**: P0

**Ask**: Replace `HarnessErrorCode | (string & {})` with a **closed** namespaced union keyed by module prefix: `CORE_*`, `TOOL_*`, `GUARD_*`, `SESSION_*`, `MEMORY_*`, `TRACE_*`, `CLI_*`, `ADAPTER_*`, `EVOLVE_*`, `EVAL_*`, `CONTEXT_*`. Prefix list + closure pattern belong to ADR 9.f.

**Adapter subclass migration (E-2 new requirement)**: `@harness-one/openai`, `@harness-one/anthropic`, `@harness-one/redis`, `@harness-one/langfuse` may subclass `HarnessError` and emit codes today. ADR 9.f MUST specify:
- Do adapters get their own prefix (`ADAPTER_*`) baked into the union?
- OR does `HarnessError` provide an escape hatch `{ code: 'ADAPTER_CUSTOM', details: { adapterCode: string } }` — closing the union, preserving adapter autonomy?
Per critique §7, template-literal-union (`${Module}_${Suffix}`) + `ADAPTER_CUSTOM` escape is the current frontrunner, but ADR decides.

**Measure**:
- Every `throw new HarnessError*` site across `packages/core/src/` (152 sites, 47 files — corrected from v1's 130/42) maps to a declared code.
- A TypeScript exhaustiveness test asserts `switch (err.code) { … }` is exhaustive (compile error if a new code is added without a branch).
- No use of `(string & {})` in the declaration.
- Adapter subclass migration guide added to CHANGELOG.
- Finding M-3 closed.

### F-7 — DEFERRED TO Wave-5C.1

See §10. Not a main 5C requirement.

### F-8 api-extractor CI gate — **snapshot-diff mode** (LD-2)

**Finding**: ARCH-4 (tooling half) · **Priority**: P0

**Ask** (v2 scope-reduced): Every `@harness-one/*` package runs api-extractor in CI. CI fails if the generated `<pkg>.api.md` differs from the checked-in copy. **Stability-tag enforcement is OFF in main 5C; layers in via 5C.1.**

**Override path (v2 explicit)**:
1. Contributor runs `pnpm api:update` locally.
2. Commits the regenerated `*.api.md` alongside the code change.
3. PR description **must include a `## API change rationale` section** (regex-checked by CI — `^## API change rationale\s*$` + at least 20 chars of body).
4. CI gate verifies: (a) checked-in `*.api.md` matches regenerated output, (b) PR description contains rationale section.
5. **No separate CODEOWNERS gate in rc phase** — regular reviewer approval suffices. A CODEOWNERS `@harness-one/api-stewards` gate is deferred to post-1.0 hardening (acknowledged from critique §2-E7; lead chose not to add it during rc to avoid over-gating iteration).

**Measure**:
- Seed PR renames a symbol without running `pnpm api:update` → CI fails with file+symbol name.
- Seed PR runs `pnpm api:update`, commits snapshot, adds `## API change rationale` → CI passes.
- Seed PR runs `pnpm api:update` but omits rationale section → CI fails on regex check.
- api-extractor output is deterministic (no timestamps, no machine-specific paths).

### F-9 Delete `eventBus` dead-stub

**Finding**: ARCH-10 · **Priority**: P0

**Ask**: Remove the `eventBus` property, the `EventBus` Proxy, the `eventBusWarnEmitted` flag, and the `EventBus` type reference from `packages/preset/src/index.ts` (lines `170-230`, `370-410` verified). Remove `eventBus: EventBus` from the `Harness` interface.

**Measure**:
- `grep -r 'eventBus' packages/preset/src/` returns 0 hits.
- `Harness` public interface has no `eventBus` field.
- CHANGELOG migration entry: "use the owning module's `onEvent()` API".
- Finding ARCH-10 (runtime-trap half) closed. Doc-drift half closes in 5C.1.

### F-10 `cli/templates.ts` split

**Finding**: M-11 · **Priority**: P1

**Ask**: Split the 651-LOC god-module. Ships inside `@harness-one/cli/`, so the work lives in the new `packages/cli/` after F-3. ADR 9.d picks strategy.

**Measure**:
- Largest file in `packages/cli/src/` ≤ 200 LOC.
- Each split file has a header comment naming its one consumer.
- Finding M-11 closed.

### F-11 — DEFERRED TO Wave-5C.1

See §10. Not a main 5C requirement.

### F-12 Workspace dependency consistency (new in v2, from critique)

**Priority**: P0 (release blocker)

**Ask**: Every `@harness-one/*` package that imports from `harness-one` must declare the dependency explicitly in `package.json`. CI script enumerates `import 'harness-one` statements across the workspace and asserts each importing package has a matching `dependencies` or `peerDependencies` entry with a consistent version range (workspace protocol: `workspace:*`).

In-scope packages: `ajv`, `tiktoken`, `anthropic`, `openai`, `langfuse`, `opentelemetry`, `redis`, `preset`, plus new `cli` + `devkit`.

**Measure**:
- CI script `pnpm verify:deps` enumerates imports vs declared deps; exits non-zero on mismatch.
- `pnpm -r build` topo-ordered build succeeds.

### F-13 Examples directory migration (new in v2, from critique E-F-13)

**Priority**: P0 — **acceptance blocker for F-4**

**Ask**: The `examples/` directory (verified: 20 TypeScript files, 52 `from 'harness-one*'` occurrences) must be migrated in lockstep with F-3 (CLI extract), F-4 (devkit extract), and F-1 (barrel trim).

Specific migrations required:
- `examples/full-stack-demo.ts:15` — `import type { Scorer } from 'harness-one/eval'` → `'@harness-one/devkit'`
- `examples/full-stack-demo.ts:20` — `import { createEvalRunner } from 'harness-one/eval'` → `'@harness-one/devkit'`
- `examples/eval/llm-judge-scorer.ts:8,119` — `from 'harness-one/eval'` → `'@harness-one/devkit'`
- Any `from 'harness-one/evolve'` → `'@harness-one/devkit'`
- Any symbol removed from the root `harness-one` barrel by F-1 → update to subpath import

**Measure**:
- `pnpm -C examples typecheck` is green after F-3 + F-4 + F-1 land.
- No example imports `harness-one/eval`, `harness-one/evolve`, or `harness-one/cli` post-wave.
- `examples/package.json` (create if absent) declares `@harness-one/devkit` as a devDependency.

**Owner**: part of F-4 implementation team — F-4 cannot pass acceptance-reviewer without F-13 green.

### F-14 npm name placeholder — partial (new in v2, from critique E-F-14 + LD-3)

**Priority**: P0 — **conditional on ADR 9.a picking rename**

**Ask** (v2 scope-reduced from critique): IF ADR 9.a decides to rename `harness-one` → `@harness-one/core`, THEN:
- (i) Publish a **minimal placeholder** package to npm under `@harness-one/core` at version `1.0.0-placeholder.0` (or similar pre-release tag). Placeholder contents: a single README.md + package.json with `"private": false`, no `files`, no real exports. Sole purpose: **reserve the name** to prevent squatting.
- (ii) Existing `harness-one` package on npm stays at `0.4.x` — no changes. No deprecation field, no 1.0 publish, no rug-pull for existing 0.x installers.
- (iii) Full deprecation ceremony (add `"deprecated": "moved to @harness-one/core, see migration guide"` to a future `harness-one@1.0.0` publish) is **Wave-5G** release-readiness — not this wave.

IF ADR 9.a decides NOT to rename (keep `harness-one` as the marquee name), F-14 is a no-op and the PRD skips it.

**Measure**:
- Conditional on ADR 9.a rename outcome.
- If rename: `npm view @harness-one/core` shows the placeholder; package is published under the existing `@harness-one` org; no other `@harness-one/*` package is blocked or affected.
- If no rename: F-14 closed as N/A.

### F-15 — DEFERRED TO Wave-5G

Codemod bundle (from critique) is release-readiness, not structural. Not in scope for main 5C or 5C.1.

---

## 7. Non-functional requirements

### 7.1 Performance

- `pnpm -r build` does not regress >15% vs pre-5C baseline.
- `harness-one` main-entry bundle shrinks ≥ 30% (size-limit measured).

### 7.2 Security

- No regressions in Wave-5A fail-closed posture.
- CLI-emitted template strings isolated to `@harness-one/cli`; production `pnpm install --prod` in consumer projects does not pull the CLI. (Bundle-weight argument only; not a CVE argument — v1's CVE framing was overclaim per E-7 of critique.)

### 7.3 Reliability

- Zero behavioral changes beyond `eventBus` deletion.
- All existing tests pass unchanged post-migration.
- F-13-migrated examples typecheck in CI.

### 7.4 Developer experience

- `pnpm install` + `pnpm -r build` green on Node 18 LTS + Node 20 LTS.
- `pnpm api:update` + `## API change rationale` override path in CONTRIBUTING.md with worked example.
- Every breaking import path has a 1-line sed-style suggestion in CHANGELOG.

---

## 8. Breaking changes inventory (v2)

| # | Change | What breaks | Migration | Codemod (Wave-5G)? |
|---|---|---|---|---|
| B-1 | Root barrel trimmed ≤ 25 value symbols | Non-surviving `import { X } from 'harness-one'` | Use subpath export | Yes |
| B-2 | `harness-one/essentials` (ADR 9.j) | Decision pending | If removed: switch to root barrel | Conditional |
| B-3 | `harness-one/cli` subpath removed | That import | `pnpm add @harness-one/cli` | Yes |
| B-4 | `harness-one/eval` + `harness-one/evolve` removed | Those imports | `pnpm add -D @harness-one/devkit` | Yes |
| B-5 | `harness-one` loses `bin` | `pnpm dlx harness-one` | `pnpm dlx @harness-one/cli` | Doc only |
| B-6 | `_internal/` → `infra/` + lint barrier | None today (all 19 importers are intra-package — E-1) | N/A for existing code; future reach-in blocked | No |
| B-7 | `HarnessErrorCode` closed | Adapter subclasses with custom codes (F-6) | `ADAPTER_CUSTOM` + `details.adapterCode` escape (ADR 9.f) | Partial |
| B-8 | `Harness.eventBus` removed | Consumers reading/calling `harness.eventBus.*` | Use owning module's `onEvent()` | Yes |
| B-9 | Stability tags (5C.1) | Untagged public exports | See §10 | See §10 |
| B-10 | `@harness-one/ajv` + `@harness-one/tiktoken` merge (if ADR 9.c merges) | Those imports | `@harness-one/native-deps` | Yes if merge |
| B-11 | `packages/full/` deleted | Nothing (unreferenced) | None | No |
| B-12 | `cli/templates.ts` splits | Nothing (internal to `@harness-one/cli`) | N/A | N/A |
| B-13 | `@harness-one/core` placeholder on npm (F-14, conditional) | Nothing (placeholder only) | None in 5C; full deprecation Wave-5G | N/A |

**Known downstream consumers**: the monorepo itself — `packages/preset`, `examples/` (20 files). `packages/full/` is dead. No external consumers because no `@harness-one/*` package has been published at 1.0-series yet.

---

## 9. Decisions left to architect (ADR inputs)

- **9.a** Top-package name: rename `harness-one` → `@harness-one/core`, or keep? Gates F-14.
- **9.b** `packages/full/`: delete (recommended per E-3) vs resurrect as meta-package.
- **9.c** `@harness-one/ajv` + `@harness-one/tiktoken`: merge vs keep.
- **9.d** `templates.ts` split strategy.
- **9.e** `_internal/` rename target (recommended: `infra/`).
- **9.f** `HarnessErrorCode` closure pattern + **adapter subclass migration** (template-literal union + `ADAPTER_CUSTOM` escape is frontrunner per critique §7).
- **9.g** Stability-tag default policy (5C.1 decision — build-fail recommended per critique §7; defer until Wave-5C.1 ADR).
- **9.h** Doc-drift CI artifact format (5C.1 decision — deferred).
- **9.i** `harness-one/essentials.ts` fate (promoted from NG to ADR decision per critique §7).
- **9.j** (new, from critique) — same as 9.i above (merged).
- **9.k** (new, from critique) — post-trim `harness-one/package.json#exports` map emitted as ADR artifact. Today 14 subpaths; F-3 removes 1 (`./cli`); F-4 removes 2 (`./eval`, `./evolve`); potentially more per F-1.
- **9.l** (deferred post-1.0) — CODEOWNERS `@harness-one/api-stewards` team + 2-approver gate. NOT in main 5C (LD-2 / LD-3 rationale: avoid over-gating during rc).

---

## 10. Wave-5C.1 follow-up scope (new §10 per lead directive)

**Target**: Same branch `wave-5/production-grade`, follow-up PR opened within **1 week** of main 5C merge. Estimated **~1 week of wall-clock work**.

### 10.1 F-7 — JSDoc stability tag required on every public export

**Finding**: ARCH-4 (policy half) · **Priority**: P0 for 1.0-rc

**Ask**: Every public symbol in every `@harness-one/*` package's main entry and subpath entries carries exactly one of `@stable`, `@beta`, `@alpha`, `@experimental` — and **optionally also** `@deprecated` with a removal-version string (E-6 correction: 7 `@deprecated` tags already exist; they must be respected).

Default policy: ADR 9.g decides between (a) untagged = build-fail (rigor-friendly, critique frontrunner), or (b) untagged = default-`@stable` (adoption-friendly). Per critique §7: pick build-fail during rc.

Deprecated-and-being-removed-in-this-wave symbols (e.g., `eventBus` in F-9) do NOT need a new stability tag because they are gone post-landing.

**Measure**:
- api-extractor run reports zero untagged public symbols.
- Seed PR adding an untagged export fails CI.

### 10.2 F-11 — Doc-drift CI

**Finding**: ARCH-10 (doc half) · **Priority**: P1

**Ask**: Every public export (in `*.api.md`) has a corresponding doc artifact. ADR 9.h picks format:
- (i) `*.api.md` cross-referenced against `docs/reference/<pkg>.md` headings
- (ii) `docs/_manifest.yaml` explicit symbol list
- (iii) TSDoc presence + character threshold (cheapest)

**Measure**:
- Baseline measurement on main-5C HEAD; published list of unmatched symbols.
- Post-landing: seed PR adding undocumented new export fails CI.
- `@docs:pending(<tracking-issue>)` escape allowed during rc; must resolve before 1.0 final.

### 10.3 api-extractor gate tightening

Switch F-8's mode from "snapshot-diff only" to "snapshot-diff + stability-tag enforcement". Configuration update only; no new CI job.

---

## 11. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Every downstream consumer breaks | Critical | 1.0-rc quality bar accepts; codemods in Wave-5G |
| R-2 | api-extractor snapshot-diff gate too harsh during rc | High | `pnpm api:update` + `## API change rationale` = 2-minute override |
| R-3 | ADR 9.a rename costs npm ceremony | Medium | F-14 placeholder-only; full deprecation to Wave-5G |
| R-4 | Stability-tag default policy (deferred to 5C.1) | Medium | Scope boundary explicit; 5C.1 ADR decides before tag rollout |
| R-5 | `cli/templates.ts` emits subpath imports that F-1/F-4 break | High | F-3 new measure: build-time parser test enumerates + validates |
| R-6 | Examples silently break on F-4 | Critical | F-13 is P0 blocker for F-4 acceptance |
| R-7 | `HarnessErrorCode` closure breaks third-party adapters | Medium-High | F-6 + ADR 9.f explicitly design `ADAPTER_CUSTOM` escape; adapter survey before merge |
| R-8 | `infra/` import barrier catches legitimate tests | Low | Rule exempts `__tests__/` paths |
| R-9 | 5C.1 follow-up drags past 1-week target | Medium | Scope is 2 requirements + 1 config flip; if it drags, open a circuit-breaker per `decisions.md` §门禁条件 |
| R-10 | `packages/full/` deletion breaks an undiscovered CI path | Low | F-5 measure: grep CI configs before delete |

---

## 12. Out of scope (explicitly deferred)

- Wave-5C.1 follow-up (F-7, F-11, api-extractor strict mode) — same branch, next PR.
- Wave-5D — observability.
- Wave-5E — trust boundaries.
- Wave-5F — minor cleanup.
- Wave-5G — release-readiness: actually `npm publish`, full deprecation ceremony for `harness-one`, codemod bundle (F-15 from critique), CODEOWNERS `api-stewards` team (9.l).

---

## 13. Open questions for next-phase reviewers

Same as v1 with critique-informed sharpening:

1. "Why 25 value symbols, not 15 or 40?" — answered by candidate list in F-1; ADR ratifies within the ≤ 25 ceiling.
2. "Merge `@harness-one/ajv` + `@harness-one/tiktoken`?" — ADR 9.c.
3. "Strict api-extractor grinds rc iteration?" — LD-2 addresses: snapshot-diff only in main 5C; `pnpm api:update` + rationale section is the one-command override.
4. "Zero behavioral change, but `HarnessErrorCode` closure affects `switch` defaults?" — `default` branch becomes statically unreachable (a win). Runtime unchanged.
5. "Doc-drift depends on undecided format?" — deferred to 5C.1 with ADR 9.h.
6. "Rename `harness-one` breaks SEO?" — pre-1.0 SEO surface is negligible; no published 0.x on npm for `harness-one` at the 1.0-series name.
7. "`HarnessErrorCode` closure breaks third-party adapter subclasses?" — critique §7 + F-6 + ADR 9.f address via template-literal union + `ADAPTER_CUSTOM` escape. Adapter-subclass migration guide in CHANGELOG.
8. "Why split F-7/F-11 out of main 5C?" — LD-1: keeps main 5C at ~3 weeks, preserves "each wave independently reversible" per `decisions.md` §门禁条件.

---

## 14. Acceptance criteria (for spec-reviewer / acceptance-reviewer)

**Main 5C accepted when**:
- [ ] Every main-5C F-requirement (F-1..F-6, F-8..F-10, F-12..F-14) has a measurable success criterion met.
- [ ] Every PD-1/PD-2/PD-3 + LD-1..LD-4 honored.
- [ ] ADR 9.a..9.f, 9.i, 9.k answered; 9.g, 9.h explicitly deferred-to-5C.1.
- [ ] §8 breaking-change inventory complete.
- [ ] §11 risks enumerated; mitigations documented.
- [ ] F-13 examples migration green (blocks F-4).
- [ ] Every fact in §3 traces to a code path.

**Wave-5C.1 accepted when**:
- [ ] F-7 stability tags present on every public export; ADR 9.g resolved.
- [ ] F-11 doc-drift CI green; ADR 9.h resolved.
- [ ] api-extractor gate mode upgraded to enforce stability tags.

---

## 15. Glossary

Unchanged from v1.

---

**End of PRD v2. Hand off to solution-architect × 3 competition phase.**
