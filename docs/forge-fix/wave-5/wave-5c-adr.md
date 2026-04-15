# Wave-5C ADR — Package Boundaries & API Surface for 1.0-rc (LOCKED)

**Status**: Accepted
**Date**: 2026-04-15
**Arbiter**: design-arbiter
**Branch**: `wave-5/production-grade`
**Scope**: Main 5C only. Wave-5C.1 (F-7 + F-11 + api-extractor strict) is a separate follow-up PR on the same branch.
**Depends on**: Wave-5B merged (AgentLoop decomposition complete).
**Feeds into**: Wave-5C.1 → Wave-5D (Observability canonical).
**PRD reference**: `docs/forge-fix/wave-5/wave-5c-prd-v2.md` (LOCKED v2).
**Inputs**:
- `wave-5c-arch-A-minimalist.md` (Architect A — package minimalism, native-deps merge, keep `harness-one` name)
- `wave-5c-arch-B-ergonomic.md` (Architect B — rename to `@harness-one/core`, enum error codes, consumer ergonomics)
- `wave-5c-arch-C-ecosystem.md` (Architect C — keep `harness-one` marquee, string-literal union errors, copy established SDK conventions)
- `wave-5c-arch-critique.md` (technical-critic, §3 hybrid)
- `wave-5c-prd-critique.md` (earlier skeptic; verified-fact corrections already applied in PRD v2)

**Locked lead constraints honored**:
- `@harness-one/cli` publishes under `@harness-one` scope (PD-1)
- Changeset `linked` lockstep (PD-2)
- api-extractor **snapshot-diff-only** in main 5C; stability-tag enforcement to 5C.1 (PD-3 / LD-2)
- F-7 + F-11 → 5C.1 (LD-1)
- F-14 npm placeholder conditional on ADR 9.a (LD-3) — **this ADR picks KEEP; F-14 becomes a defensive reservation only, not a rename companion (see §3.a)**

---

## 1. Executive Verdict

**Scoring-matrix winner**: **Hybrid (C-biased) — 24/30**, dominantly C's structural decisions with A's minimalist barrel philosophy and B's runtime-introspectable error closure. The critic's recommended hybrid (§3 of `wave-5c-arch-critique.md`) is **adopted with two targeted disagreements** (see §3.f and §3.a).

**One-line rationale**: C's shape (keep `harness-one` marquee, keep ajv/tiktoken separate, architecture-checker in core via `./evolve-check` subpath) produces the lowest-risk migration surface; A contributes the disciplined 18-symbol barrel plus the rigorous `rm dist/infra` + `files` narrowing belt-and-suspenders; B contributes the string-enum closure for `HarnessErrorCode` so `Object.values()` runtime introspection works out of the box. The `HarnessErrorCode` shape departs from the critic's template-literal hybrid recommendation (see §3.f rationale).

**Confidence**: High. Migration surface is mechanical, sequence is three PRs, every deferred item is explicitly named and bounded.

---

## 2. Scoring matrix (5 × 6, 1-5 per cell)

Scoring starts from the technical-critic's scorecard (§2 of critique) and adjusts where this arbiter disagrees. Cell scores are 1 (poor) to 5 (best). **Bold** = dimension winner.

| Dimension | A (Minimalist) | B (Ergonomic) | C (Ecosystem) | Arbiter note |
|---|---|---|---|---|
| **PRD compliance (F-1..F-14 depth)** | 4 — 18-symbol barrel + explicit symbol drops, `SUBPATH_MAP` test is the sharpest F-3 asset of all three proposals | **5** — strongest F-6 (enum gives runtime value), F-3 (bin + programmatic entry), F-13 codemod | 4 — thorough F-2 lint via `no-internal-modules`, but `./evolve-check` expansion slightly bloats F-1 subpath ceiling | critic gave B 5, A 4, C 4 — arbiter agrees |
| **Migration cost (own monorepo + examples/)** | 3 — native-deps merge forces preset rewrites, `rm dist/infra` needs source-map test | 2 — rename `harness-one→@harness-one/core` **and** enum code renames compound (B-F-3), atomic mega-PR (B-F-11) is a review-cost bomb | **4** — no rename, no native-deps merge; only extractions + rename of `_internal` | critic agrees; arbiter holds |
| **Long-term maintainability (5D/5E/5F-friendly)** | **4** — minimalist barrel composes well with Wave-5D `MetricsPort` (though A-F-14 correctly flags `createCostTracker` demotion) | 4 — enum enables telemetry introspection needed by 5D | 3 — tagged-object `ADAPTER_CUSTOM` (C-F-3) breaks every existing `err.code` stringifier; 5D loggers pay cost | critic scored all three 3-4; arbiter upgrades A to 4 because demotion of `createCostTracker` is reversible in 5D while C's tagged-object is not |
| **Consumer DX (install story, imports, errors)** | 3 — 18 symbols feels spartan; dropping `createResilientLoop` from root is a real DX regression (A-F-7) | **5** — scoped family reads clearest; `Object.values(HarnessErrorCode)` wins runtime UX | 4 — marquee + scoped siblings is the familiar pattern; `assertNever` at root is a mild DX smell (C-F-9) | critic agrees |
| **Risk surface (how many decisions could be wrong)** | 3 — three novel calls (native-deps merge, no-CJS devkit, `rm dist/infra`) | 2 — rename + enum + atomic landing compound; B-F-10 (`details.adapterCode: string` reopens the sink under a different name) | **4** — fewest novel calls; `evolve-check` is one new subpath pattern but justified | critic scored 3/2/4; arbiter holds |
| **Defensibility vs future critic / spec-reviewer** | 3 — A-F-11 contradicts own lockstep-logic (merge-if-lockstep would also merge adapters — inconsistency) | 3 — `import type HarnessErrorCode` silently erases runtime introspection (B-F-1); defensible but has a footgun | **4** — precedents (Stripe, Vite, Next) aren't perfect citations (C-F-1/C-F-2) but span well-known SDKs | critic agrees |
| **TOTAL (30 max)** | **20** | 21 | **23** | **Hybrid: 24** |

### Where this arbiter disagrees with the critic's scoring

- Maintainability dimension: arbiter upgrades **A from 4 → 4** (no change numerically) but explicitly notes A-F-14 (`createCostTracker` demotion) is a Wave-5D fixable regression, not a design flaw. Arbiter **downgrades C maintainability** (critic gave 3) and keeps at 3 because the tagged-object `ADAPTER_CUSTOM` is a 5D logging pipeline tax.
- Net totals match critic's. Winner remains C at 23; hybrid lifts to 24 by trading C's tagged-object for B's enum.

---

## 3. Decisions locked

Each decision: **LOCKED answer → one-paragraph rationale → contributing architect**. Where the critic's hybrid is adopted, noted. Where it is rejected, justified.

### 3.a ADR 9.a — Top package name

**LOCKED**: **Keep `harness-one` as the marquee unscoped name.** Do NOT rename to `@harness-one/core`.

**Rationale**: The rename's value (SEO / family-branding) is speculative pre-1.0 (B-F-4 — `harness-one@0.x` has negligible organic traffic; the rename buys aesthetic not measurable outcome); the cost is real (every consumer rewrites imports, and if 9.f also closes `HarnessErrorCode`, they do two mechanical sweeps in the same wave — B-F-3). C-F-6 (caret-range silent upgrade risk) is acknowledged and mitigated by Wave-5G's explicit deprecation dance on the old name. The unscoped-marquee + scoped-siblings pattern is established (`stripe`, `next`, `vite`, `vitest`) — C's precedent citations imperfect (C-F-1, C-F-2) but directionally correct. **Re-open as a 2.0 question** if post-1.0 support tickets demonstrate consumer confusion. **F-14 becomes a defensive reservation**: publish a `@harness-one/core@0.0.0-reserved` placeholder (single README, `"private": false`, no exports) to prevent lateral squat; also reserve `@harness-one/{runtime,sdk,framework}`. This narrows F-14 from "placeholder-if-rename" (PRD LD-3) to "defensive reservation regardless" — $0 additional cost, closes arbiter-open-question #7 and #9 from critique.

**Contributor**: C (primary), A (concur). Reject B.

### 3.b ADR 9.b — `packages/full/` fate

**LOCKED**: **Delete.** Before the delete commit, run a one-shot audit: `grep -r "packages/full" .github/ pnpm-workspace.yaml tsconfig*.json packages/*/tsup.config.* examples/` — must return zero hits. No `package.json`, no `src/`, unreferenced in workspace (E-3 verified in `wave-5c-prd-critique.md`). All three architects concur.

**Contributor**: unanimous (A, B, C, critic).

### 3.c ADR 9.c — `@harness-one/ajv` + `@harness-one/tiktoken`

**LOCKED**: **Keep separate.** Reject A's `@harness-one/native-deps` merge.

**Rationale**: A's merge argument (A §2) is fundamentally a maintainer-cost optimization; by A's own defense §12.1 ("the real weight is the peer dep"), the merge saves the consumer zero bytes. The costs are real: peer error-message quality degrades (A-F-3 — merged shim produces opaque module-resolve errors instead of per-package "install `tiktoken` to use this"), the peer stories are asymmetric (Ajv synchronous; tiktoken WASM-async-init), and A's own lockstep-consistency argument (A-F-11) would also force merging the five other adapters — which A does not propose, revealing the inconsistency. C-F-19 opens a forward-looking graduation criterion: **if the two packages ever share > 100 LOC of mutual-utility code, revisit the merge**. Until then, two `package.json` lines a consumer can reason about beats one merged README page.

**Contributor**: B + C. Reject A. Matches critic hybrid §3.3.

### 3.d ADR 9.d — `templates.ts` 651-LOC split strategy

**LOCKED**: **One file per `ModuleName`, alphabetical, plus a centralized `subpath-map.ts` source of truth.** Adopt A §8.2 verbatim including `SUBPATH_MAP` const.

**Rationale**: A's proposal is the sharpest of the three: the `SUBPATH_MAP` const replaces hard-coded template strings (`'harness-one/core'`) with a typed table, and the F-3 build-time parser test (`packages/cli/src/__tests__/subpaths-resolve.test.ts`) reads `harness-one/package.json#exports` + `@harness-one/devkit/package.json#exports` and asserts every value in the map resolves. This closes PRD-v2's new F-3 measure (E-4) with a single test fixture instead of a bespoke regex scanner. **One divergence from A**: do NOT merge `eval` + `evolve` templates into a single `devkit.ts` (A-F-12 — loses information for users who `init --module=eval`). Keep them as separate template files — final count 13 files: `core / prompt / context / tools / guardrails / observe / session / memory / orchestration / rag / eval / evolve / index` — median ~50 LOC, max < 70 LOC, well under F-10's 200-LOC ceiling.

**Contributor**: A (primary). B and C did not specify split granularity at this depth.

### 3.e ADR 9.e — `_internal/` rename target

**LOCKED**: **`infra/`**.

**Rationale**: PRD §9.e recommends `infra/`; all three architects concur; E-1 verifies all 19 importers are intra-`packages/core/src/` so the rename is a mechanical `git mv` + `sed`. Alternative names (`internals/`, `lib/`, `runtime-support/`) considered and rejected — `infra/` is what the Wave-5B ADR already uses as the de-facto name in its prose; matches codebase vocabulary.

**Contributor**: unanimous.

### 3.f ADR 9.f — `HarnessErrorCode` closure pattern

**LOCKED**: **String enum** (TypeScript `enum HarnessErrorCode { ... = '...' }`) with module-prefixed values (`CORE_*`, `TOOL_*`, `GUARD_*`, `SESSION_*`, `MEMORY_*`, `TRACE_*`, `CLI_*`, `ADAPTER_*`, `PROVIDER_*`). Escape hatch: `HarnessErrorCode.ADAPTER_CUSTOM` + `details.adapterCode: string` on the adapter subclass.

**Rationale**: This **departs from the critic's hybrid recommendation** (critic §3.2 proposed "B enum + A string-literal adapter escape", with a lint rule mandating `import { HarnessErrorCode }` value-import to close the B-F-1 footgun). The arbiter **adopts** B's enum and **explicitly rejects** C's tagged-object escape (C-F-3, C-F-11: changing `err.code` from `string` to `string | object` breaks every `err.code === 'X'` check and every log stringifier across the ecosystem — too expensive). The B-F-10 "`details.adapterCode: string` reopens the sink" concern is acknowledged and accepted: the adapter sub-code is by-contract open because third-party adapters must be able to publish their own taxonomies; main-union closure is what matters for core's switch-exhaustiveness. The B-F-1 `import type HarnessErrorCode` footgun is closed by a new lint rule (§5 below). String enums compile to `Object.freeze`-style const objects that tree-shake cleanly (refutes the 2024-era "enums are anti-pattern" critique for *string* enums specifically). **Winner contribution: B (enum shape) + C (prefix taxonomy) + A (ADAPTER_CUSTOM + details.adapterCode pragmatic escape).**

**Contributor**: Hybrid B+C+A. Critic hybrid modified: arbiter disagrees with the critic on the union-shape rationale (critic preferred template-literal + mandate value-import; arbiter prefers enum because runtime introspection is a deliverable, not a convention).

### 3.g ADR 9.g — Stability-tag default policy

**LOCKED as interim for main 5C**: **N/A — api-extractor runs in snapshot-diff-only mode (PD-3/LD-2); stability-tag enforcement is OFF in main 5C.**
**Deferred to Wave-5C.1**: **build-fail on untagged public exports** (per `wave-5c-prd-critique.md` §7 frontrunner, per critic §3.9). Reject A's "untagged = `@stable`" (A-F-5: silently promotes every forgotten internal export to frozen `@stable` — the safest-looking-but-most-dangerous default); reject B's "untagged = `@experimental`" (B-F-13: undermines 1.0-rc quality story).

**Interim policy in main 5C (what the ADR pre-bakes)**: api-extractor config is checked in **with stability-tag enforcement disabled** (option `apiReport.includeForgottenExports: true` so the snapshot records every export, but no build-fail on missing tags). The config flag is a single-line flip for 5C.1 (`"releaseTagPolicy": { "requireReleaseTag": true }` or equivalent). 5C's api-extractor config pre-bakes **the intended strict-mode config in a commented-out block**, so the 5C.1 PR is a diff of `// ` deletions rather than a configuration authoring exercise.

**Contributor**: critic §3.9 + PRD critique §7. Reject A and B.

### 3.h ADR 9.h — Doc-drift CI artifact

**LOCKED as interim for main 5C**: **N/A — deferred to Wave-5C.1.**
**Deferred to Wave-5C.1**: **(iii) TSDoc presence + character threshold** (cheapest of the PRD §10.2 options; lowest ceremony). Rationale: F-11 is P1 not P0; shipping 1.0-rc without `@docs:pending` escape-hatch annotations is acceptable; measurement is deferred until we have *something* to measure against. The 5C.1 PR establishes baseline, lists un-docced symbols, and gates new exports.

**Interim policy in main 5C**: no doc-drift CI job exists; existing hand-written `docs/architecture/*.md` continues to be updated via the per-wave `doc-updater` step (`decisions.md` §每 wave 固定流水线).

**Contributor**: critic + PRD v2 §10.2. Arbiter picks option (iii) over (i)/(ii) because it requires zero new manifest files.

### 3.i ADR 9.i — `essentials.ts` fate

**LOCKED**: **DELETE.** Remove `harness-one/essentials` subpath from `packages/core/package.json#exports`, delete `packages/core/src/essentials.ts`, delete `dist/essentials.*` build outputs.

**Rationale**: All three architects concur (closed axis per critique §preface). The `./essentials` entry is the third redundant entry for the same symbols (PRD §2.1); grep across `packages/` + `examples/` confirms zero consumer references (A §ADR-5C-A-07 spot-check). A-F-16 acknowledges absence of docs/README content scanning — arbiter adds one explicit audit before delete: `grep -rn "harness-one/essentials" docs/ README.md CHANGELOG.md` + `grep -rn "essentials" .github/` must return zero hits.

**Contributor**: unanimous (A, B, C).

### 3.j Additional locked decision — `architecture-checker` placement (critic's biggest miss for A)

**LOCKED**: **`architecture-checker` stays in `harness-one` (core runtime) at subpath `harness-one/evolve-check`.** Only `component-registry.ts`, `drift-detector.ts`, `taste-coding.ts`, `generator-evaluator.ts`, `flywheel.ts` (and the `eval/*` tree) move to `@harness-one/devkit`.

**Rationale**: A-F-1 (FATAL) caught that A silently moved architecture-checker to devkit, breaking any runtime consumer that invokes `checkArchitecture()` during `initialize()`. C §2.1 correctly argues architecture-checker is runtime-invocable (Stripe analogy: `webhooks.constructEvent` ships runtime; CLI fixtures ship in separate devkit). Wave-5A's `createSecurePreset` potential future "verify architecture on boot" path (A-F-17) depends on it being runtime-reachable. **New runtime-purity acceptance test** (closes critic open-question #4): a new test `packages/core/src/evolve/__tests__/architecture-checker-runtime-purity.test.ts` asserts that `import('harness-one/evolve-check')` resolves with zero `devDependencies`-only transitive imports — implementation: parse `dist/evolve/architecture-checker.js` for `require`/`import` specifiers and assert every one resolves through `harness-one`'s own `dependencies` (no `devDependencies`, no unresolved).

**Contributor**: C. Reject A. Critic's §3.5 concur.

### 3.k Additional locked decision — `@harness-one/devkit` scope

**LOCKED**: **Devkit contains only `eval/*` + the non-runtime `evolve/*` modules.** Explicitly: `component-registry`, `drift-detector`, `taste-coding`, `generator-evaluator`, `flywheel`, all `eval/*` (runner, scorers, datasets). Explicitly NOT: `architecture-checker` (stays in core — §3.j). Dependency on `harness-one`: **regular `dependency` with `workspace:*`** (reject C's peerDep — C-F-5: a consumer running `pnpm add -D @harness-one/devkit` alone should work; C's vitest-peerDeps-vite precedent doesn't fit because an evaluation-only consumer may legitimately not have `harness-one` installed; regular dep keeps the install story clean).

**Rationale**: Aligns with C's package-map shape minus the peerDep relationship. Regular dep picks B's answer (B §2 row for cli parallels devkit). F-13 examples migration must update `from 'harness-one/eval'` → `'@harness-one/devkit'` and `from 'harness-one/evolve'` → `'@harness-one/devkit'` or `'@harness-one/devkit/evolve'`.

**Contributor**: B (dep kind) + C (contents and scope) hybrid.

### 3.l Additional locked decision — Sequence as one PR or three

**LOCKED**: **Three PRs on `wave-5/production-grade`, landing in order.** Adopts critic §3.7 hybrid.

- **PR-1 (mechanical)**: F-2 (`_internal/` → `infra/` rename + ESLint barrier) + F-5 (delete `packages/full/` + decision on ajv/tiktoken = keep separate) + F-9 (delete `eventBus`) + F-10 (`templates.ts` split — in anticipation, but only if `packages/cli/` exists; otherwise defer split to PR-2) + F-12 (workspace-deps verify script). **No API-surface changes.** api-extractor snapshots committed as baseline.
- **PR-2 (extractions)**: F-3 (`@harness-one/cli` extract, incl. F-10 templates split) + F-4 (`@harness-one/devkit` extract, incl. architecture-checker stays in core at `./evolve-check`) + F-13 (examples migration — **blocks F-4 acceptance**). api-extractor snapshots regenerated across 3 packages (`harness-one`, `cli`, `devkit`).
- **PR-3 (surface lock)**: F-1 (root barrel trim to 20 value symbols — §5) + F-6 (`HarnessErrorCode` enum closure — §6) + F-8 (api-extractor CI gate activation across all packages) + F-14 (defensive `@harness-one/core` placeholder reservation — §3.a). api-extractor snapshots regenerated across all 11 packages.

**Rationale**: B §10 proposed atomic landing; B-F-11 (CRITICAL) correctly identifies that a mega-PR's review cost is severe. Three PRs keep each `api-extractor` diff human-reviewable; each PR is independently revertable per `decisions.md` §风险与回滚. PR-1 is ~hour-scale. PR-2 is the extraction-heavy PR that blocks on F-13 green. PR-3 is the surface-lock PR.

**Contributor**: critic §3.7 + A §3 (implicitly sequenced) + C §3 (implicitly sequenced). Reject B's atomic landing.

---

## 4. Final package map

All paths absolute. "LOC" is post-5C target. Reject A's merge → 11 packages total.

| Package | Role | LOC (target) | dependencies | peerDependencies | devDep-only? | Publish? (main 5C) |
|---|---|---|---|---|---|---|
| `harness-one` | Runtime core: agent loop, tools, prompt, context, guardrails, observe, session, memory, orchestration, rag, **+ `evolve-check` subpath** (architecture-checker only), **+ `infra/`** (lint-walled) | ~19,200 (−cli ~1,100; −eval+evolve minus architecture-checker ~3,000) | (none) | (none) | No | No (NG-2) |
| `@harness-one/cli` | `init` / `audit` CLI binary. Owns `bin`. Owns `templates.ts` split into 13 files. | ~1,200 | `harness-one: workspace:*`, `commander` (or existing parser) | (none) | No | No (NG-2) |
| `@harness-one/devkit` | `eval/*` + non-runtime `evolve/*` (component-registry, drift-detector, taste-coding, generator-evaluator, flywheel). Architecture-checker NOT here (§3.j). | ~3,000 | `harness-one: workspace:*` | (none) | **Yes** (installed as devDep) | No |
| `@harness-one/preset` | `createHarness` + `createSecurePreset` (Wave-5A). `eventBus` deleted. | unchanged minus ~60 LOC (eventBus Proxy + flag) | `harness-one`, `@harness-one/openai`, `@harness-one/anthropic`, `@harness-one/redis`, `@harness-one/langfuse`, `@harness-one/opentelemetry`, `@harness-one/ajv`, `@harness-one/tiktoken` (all `workspace:*`) | (none) | No | No |
| `@harness-one/openai` | OpenAI adapter | unchanged | `harness-one: workspace:*` | `openai` | No | No |
| `@harness-one/anthropic` | Anthropic adapter | unchanged | `harness-one: workspace:*` | `@anthropic-ai/sdk` | No | No |
| `@harness-one/redis` | Redis session/memory store | unchanged | `harness-one: workspace:*` | `ioredis` | No | No |
| `@harness-one/langfuse` | Langfuse exporter (auxiliary; OTel is canonical per Wave-5 invariant §3) | unchanged | `harness-one: workspace:*` | `langfuse` | No | No |
| `@harness-one/opentelemetry` | Canonical OTel bridge | unchanged | `harness-one: workspace:*` | `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` | No | No |
| `@harness-one/ajv` | Ajv validator shim — KEPT SEPARATE (§3.c) | unchanged | `harness-one: workspace:*` | `ajv`, `ajv-formats` | No | No |
| `@harness-one/tiktoken` | Tiktoken tokenizer shim — KEPT SEPARATE (§3.c) | unchanged | `harness-one: workspace:*` | `tiktoken` | No | No |
| `@harness-one/core` (npm **placeholder only**) | Defensive name reservation under 9.a keep-marquee decision | README-only | (none) | (none) | N/A | **Yes — publish `0.0.0-reserved`** (F-14) |
| ~~`packages/full/`~~ | **DELETE** (§3.b) | — | — | — | — | — |

**Net**: 11 workspace packages + 1 defensive npm reservation (`@harness-one/core@0.0.0-reserved`) + also reserve `@harness-one/{runtime,sdk,framework}` by publishing README-only placeholders under same flow.

---

## 5. Final root barrel (`harness-one/src/index.ts`)

**Target**: **20 value symbols** + unbounded type-only re-exports (PRD F-1 E-8 correction).

Adopts A's 18-symbol minimalist list and **re-adds** 2 symbols per critic §3.4 hybrid: `createResilientLoop` (B-F-6 + C-F-10 concur — canonical retry-wrap is day-1 material) and `createCostTracker` (A-F-14: Wave-5D `MetricsPort` lives here; demoting forces a barrel churn in 5D).

### 5.1 Value exports (20)

```ts
// ── CORE LOOP (UJ-1) ──────────────────────────────────────────────────────
export { createAgentLoop } from './core/index.js';          // 1  primary factory
export { AgentLoop } from './core/index.js';                // 2  class for `new` + instanceof narrowing
export { createResilientLoop } from './core/index.js';      // 3  canonical retry-wrap (re-added per critic §3.4)
export { createMiddlewareChain } from './core/index.js';    // 4  middleware composition (preset + custom both use)

// ── ERRORS (UJ-1 — every consumer catches these) ──────────────────────────
export { HarnessError } from './core/errors.js';            // 5  base
export { MaxIterationsError } from './core/errors.js';      // 6  common catch target
export { AbortedError } from './core/errors.js';            // 7  AbortController path
export { GuardrailBlockedError } from './core/errors.js';   // 8  guardrail pipeline verdict
export { ToolValidationError } from './core/errors.js';     // 9  tool-call schema miss
export { TokenBudgetExceededError } from './core/errors.js';// 10 budget ceiling
export { HarnessErrorCode } from './core/errors.js';        // 11 enum — runtime-introspectable (adopts B pattern)

// ── TOOLS (UJ-1) ──────────────────────────────────────────────────────────
export { defineTool } from './tools/index.js';              // 12 DSL
export { createRegistry } from './tools/index.js';          // 13 registry

// ── GUARDRAILS (UJ-1 + Wave-5A fail-closed) ───────────────────────────────
export { createPipeline } from './guardrails/index.js';     // 14 composition

// ── OBSERVABILITY (UJ-1 + Wave-5 OTel invariant §3) ───────────────────────
export { createTraceManager } from './observe/index.js';    // 15 OTel bridge entry
export { createLogger } from './observe/index.js';          // 16 structured logger
export { createCostTracker } from './observe/index.js';     // 17 Wave-5D MetricsPort (re-added per critic §3.4)

// ── SESSION (UJ-1; Wave-5E multi-tenant gateway) ──────────────────────────
export { createSessionManager } from './session/index.js';  // 18 primitive

// ── PRESET BRIDGE (UJ-1: Wave-5A fail-closed default) ─────────────────────
export { createSecurePreset } from '@harness-one/preset';   // 19 convenience re-export

// ── LIFECYCLE (ARCH-005 Disposable contract) ──────────────────────────────
export { disposeAll } from './infra/disposable.js';         // 20 public helper
```

**Total: 20 value symbols.** 5 slots of headroom (under F-1's ≤ 25 ceiling). Each symbol carries a one-line `// UJ-N:` justification comment.

### 5.2 Type-only re-exports

**Unbounded** (PRD F-1 E-8 correction; zero runtime bundle cost). Verbatim transplant of every type from the pre-5C root barrel that still has a home post-5C (excludes types whose owning symbol moved to `@harness-one/devkit` — e.g., `EvalResult`, `ComponentRegistry`). Explicit type families:
- From `./core`: `Role`, `Message`, `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `AgentAdapter`, `AgentLoopConfig`, `AgentLoopHook`, `AgentLoopTraceManager`, `ChatParams`, `ChatResponse`, `StreamChunk`, `ToolCallRequest`, `ToolSchema`, `TokenUsage`, `JsonSchema`, `LLMConfig`, `ResponseFormat`, `AgentEvent`, `DoneReason`, `MiddlewareChain`, `PruneResult`, `ResilientLoopConfig`.
- From `./tools`: `ToolDefinition`, `ToolMiddleware`, `ToolResult`, `ToolFeedback`, `ToolCall`, `ToolRegistry`, `SchemaValidator`, `ValidationError`.
- From `./guardrails`: `Guardrail`, `GuardrailContext`, `GuardrailVerdict`, `GuardrailPipeline`.
- From `./observe`: `Trace`, `Span`, `SpanEvent`, `SpanAttributes`, `SpanAttributeValue`, `TraceExporter`, `TraceManager`, `InstrumentationPort`, `CostTracker`, `ModelPricing`, `TokenUsageRecord`, `CostAlert`, `Logger`, `LogLevel`, `FailureMode`, `FailureClassification`, `CacheMetrics`, `CacheMonitor`.
- From `./session`: `Session`, `SessionEvent`, `SessionManager`, `ConversationStore`, `ConversationStoreCapabilities`, `AuthContext`.
- From `./memory`: `MemoryEntry`, `MemoryFilter`, `MemoryStore`, `MemoryStoreCapabilities`, `MemoryGrade`.
- From `./infra/disposable`: `Disposable`, `DisposeAggregateError` (type-only — the class is not exported as a value at root; throwing code lives inside `disposeAll`).

### 5.3 Removals from current barrel (justifications per removed symbol)

Verified against `packages/core/src/index.ts:14-216` at HEAD:
- `createJsonOutputParser`, `parseWithRetry` → `./core` subpath (niche — 2 in-repo consumers).
- `createEventBus`, `EventBus` → **DELETED** (F-9 dead-stub).
- `createSequentialStrategy`, `createParallelStrategy` → `./orchestration` subpath.
- `categorizeAdapterError` → `./core` subpath (advanced; 3 consumers).
- `pruneConversation` → `./core` subpath.
- `toSSEStream`, `formatSSE` → `./core` subpath (transport concern, not every consumer).
- `assertNever` → **DELETED** (TS idiom; 2-liner consumers can inline; reject C-F-9).
- `StreamAggregator` → `./core` subpath.
- `createFallbackAdapter` → `./core` subpath (advanced composition; 0.x consumer grep shows light usage).
- `toolSuccess`, `toolError`, `validateToolCall` → `./tools` subpath.
- `createInjectionDetector`, `createPIIDetector`, `createContentFilter`, `createRateLimiter`, `createSchemaValidator`, `withSelfHealing` → `./guardrails` subpath (preset consumes directly).
- `runInput`, `runOutput`, `runToolOutput` → `./guardrails` subpath (reject B's `export * as guardrails` namespace — B-F-7: namespace re-export defeats tree-shaking in some bundler configs; three flat subpath imports is cleaner).
- All prompt factories (`createPromptBuilder` et al.) → `./prompt` subpath.
- All context factories → `./context` subpath.
- `createConsoleExporter`, `createNoOpExporter`, `createFailureTaxonomy`, `createCacheMonitor`, `createDatasetExporter` → `./observe` subpath.
- `createInMemoryConversationStore`, `createAuthContext` → `./session` subpath (A-F-15: Wave-5E re-promotes if needed).
- All memory factories → `./memory` subpath.
- `createAgentPool`, `createHandoff`, `createContextBoundary`, `MessageQueue`, `createOrchestrator` → `./orchestration` subpath.
- `createEvalRunner`, `createRelevanceScorer`, `createComponentRegistry` → **MOVED** to `@harness-one/devkit`.
- `createRAGPipeline` → `./rag` subpath.

**Adapter factories** (`createOpenAIAdapter`, `createAnthropicAdapter`): NOT re-exported at root. They live on `@harness-one/openai` / `@harness-one/anthropic`. No discoverability loss — `pnpm why` and IDE autocomplete against scoped installs surfaces them.

### 5.4 Final `harness-one/package.json#exports` (post-5C)

12 entries:

```json
{
  "exports": {
    ".":               "./dist/index.js",
    "./core":          "./dist/core/index.js",
    "./prompt":        "./dist/prompt/index.js",
    "./context":       "./dist/context/index.js",
    "./tools":         "./dist/tools/index.js",
    "./guardrails":    "./dist/guardrails/index.js",
    "./observe":       "./dist/observe/index.js",
    "./session":       "./dist/session/index.js",
    "./memory":        "./dist/memory/index.js",
    "./orchestration": "./dist/orchestration/index.js",
    "./rag":           "./dist/rag/index.js",
    "./evolve-check":  "./dist/evolve/architecture-checker.js"
  }
}
```

Dual ESM/CJS; each entry actually expands to `{ types, import, require }` triplet (omitted above for brevity). This is the post-F-1/F-3/F-4 map (PRD §9.k artifact). **Deleted vs HEAD**: `./essentials`, `./cli`, `./eval`, `./evolve`.

---

## 6. `HarnessErrorCode` closed type — exact declaration

```ts
// packages/core/src/core/errors.ts

/**
 * @stable (5C.1 tagging)
 * Closed namespaced error-code enumeration. String enum so `Object.values(HarnessErrorCode)`
 * yields the introspectable list at runtime.
 *
 * IMPORTANT: Import as a VALUE (`import { HarnessErrorCode } from 'harness-one'`).
 * `import type { HarnessErrorCode }` silently drops the runtime object — caught by ESLint
 * rule `harness-one/no-type-only-harness-error-code` (see §7.2 of this ADR).
 */
export enum HarnessErrorCode {
  // ── CORE_* — runtime invariants + loop exits ─────────────────────────
  CORE_UNKNOWN                = 'CORE_UNKNOWN',
  CORE_INVALID_CONFIG         = 'CORE_INVALID_CONFIG',
  CORE_INVALID_STATE          = 'CORE_INVALID_STATE',
  CORE_INTERNAL_ERROR         = 'CORE_INTERNAL_ERROR',
  CORE_MAX_ITERATIONS         = 'CORE_MAX_ITERATIONS',
  CORE_ABORTED                = 'CORE_ABORTED',
  CORE_TOKEN_BUDGET_EXCEEDED  = 'CORE_TOKEN_BUDGET_EXCEEDED',

  // ── TOOL_* ────────────────────────────────────────────────────────────
  TOOL_VALIDATION             = 'TOOL_VALIDATION',
  TOOL_INVALID_SCHEMA         = 'TOOL_INVALID_SCHEMA',
  TOOL_CAPABILITY_DENIED      = 'TOOL_CAPABILITY_DENIED',

  // ── GUARD_* ───────────────────────────────────────────────────────────
  GUARD_BLOCKED               = 'GUARD_BLOCKED',
  GUARD_VIOLATION             = 'GUARD_VIOLATION',
  GUARD_INVALID_PIPELINE      = 'GUARD_INVALID_PIPELINE',

  // ── SESSION_* ─────────────────────────────────────────────────────────
  SESSION_NOT_FOUND           = 'SESSION_NOT_FOUND',
  SESSION_LIMIT               = 'SESSION_LIMIT',
  SESSION_LOCKED              = 'SESSION_LOCKED',
  SESSION_EXPIRED             = 'SESSION_EXPIRED',

  // ── MEMORY_* ──────────────────────────────────────────────────────────
  MEMORY_CORRUPT              = 'MEMORY_CORRUPT',
  MEMORY_STORE_CORRUPTION     = 'MEMORY_STORE_CORRUPTION',

  // ── TRACE_* ───────────────────────────────────────────────────────────
  TRACE_NOT_FOUND             = 'TRACE_NOT_FOUND',
  TRACE_SPAN_NOT_FOUND        = 'TRACE_SPAN_NOT_FOUND',

  // ── CLI_* ─────────────────────────────────────────────────────────────
  CLI_PARSE_ERROR             = 'CLI_PARSE_ERROR',

  // ── ADAPTER_* (escape hatch lives here) ───────────────────────────────
  ADAPTER_INVALID_EXTRA       = 'ADAPTER_INVALID_EXTRA',
  /**
   * Escape mechanism: third-party adapter subclasses (`@harness-one/openai`,
   * `@harness-one/anthropic`, etc.) throw with `code = ADAPTER_CUSTOM` and
   * populate `details.adapterCode: string` with their own sub-code.
   * Adapter sub-codes are by-contract OPEN — adapter packages document their
   * taxonomy in their own READMEs. Core's union closure is what matters for
   * switch-exhaustiveness in consumer code.
   */
  ADAPTER_CUSTOM              = 'ADAPTER_CUSTOM',

  // ── PROVIDER_* ────────────────────────────────────────────────────────
  PROVIDER_REGISTRY_SEALED    = 'PROVIDER_REGISTRY_SEALED',
}

/**
 * Base error. `code` is closed to the enum (no more `(string & {})`).
 * `details.adapterCode` is the one by-contract-open field, populated only
 * when `code === HarnessErrorCode.ADAPTER_CUSTOM`.
 */
export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly code: HarnessErrorCode,
    public readonly suggestion?: string,
    public override readonly cause?: Error,
    public readonly details?: Readonly<{
      adapterCode?: string;
      [k: string]: unknown;
    }>,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
```

**Exhaustiveness test** (closes F-6 measure):

```ts
// packages/core/src/core/__tests__/error-code-exhaustive.test-d.ts
import { HarnessErrorCode } from '../errors.js';

function _exhaustive(code: HarnessErrorCode): string {
  switch (code) {
    case HarnessErrorCode.CORE_UNKNOWN:              return 'unknown';
    case HarnessErrorCode.CORE_INVALID_CONFIG:       return 'invalid config';
    // ... every enum member (25 cases total) ...
    case HarnessErrorCode.ADAPTER_CUSTOM:            return 'adapter-custom';
    case HarnessErrorCode.PROVIDER_REGISTRY_SEALED:  return 'registry sealed';
    default: {
      const _never: never = code;
      return _never;
    }
  }
}
```

Adding a new enum member without a `case` branch fails `tsc`.

**Adapter migration example** (goes into CHANGELOG):

```ts
// Before (0.4.x, open string):
throw new HarnessError('OpenAI rate limit hit', 'OPENAI_RATE_LIMIT', ...);

// After (1.0-rc, closed enum + escape):
throw new HarnessError(
  'OpenAI rate limit hit',
  HarnessErrorCode.ADAPTER_CUSTOM,
  'Retry with exponential backoff',
  /* cause */ undefined,
  { adapterCode: 'OPENAI_RATE_LIMIT' },
);

// Consumer narrowing:
if (err.code === HarnessErrorCode.ADAPTER_CUSTOM && err.details?.adapterCode === 'OPENAI_RATE_LIMIT') {
  // adapter-specific path
}
```

---

## 7. Migration plan (three PRs, in order)

### PR-1: Mechanical cleanup (~2-3 days)

**Scope**: zero public-API-surface semantic change except `eventBus` deletion.

1. `git mv packages/core/src/_internal packages/core/src/infra`; `sed` update 19 intra-package importers.
2. Add ESLint `no-internal-modules` rule (via `eslint-plugin-import` — C §6.2) forbidding `harness-one/infra/**` and `harness-one/dist/infra/**` from any file outside `packages/core/src/` and outside `**/__tests__/**`. Seed lint-fixture in `packages/openai/src/__lint-fixtures__/bad-reach-in.ts` with `@ts-expect-error`.
3. Delete `packages/full/` after one-shot audit (`grep -r "packages/full" .github/ pnpm-workspace.yaml tsconfig*.json examples/` returns zero).
4. Delete `Harness.eventBus` Proxy in `packages/preset/src/index.ts:170-230, 370-410`; delete `EventBus` type reference.
5. Delete `packages/core/src/essentials.ts`; remove `./essentials` subpath from `harness-one/package.json#exports`.
6. Add `tools/verify-deps.ts` CI script (~80 LOC, pure Node); wire `pnpm verify:deps` into `api-check` CI job.
7. Install api-extractor, create per-package `api-extractor.json` configs with stability-tag enforcement DISABLED (§3.g interim); generate baseline `*.api.md` for all 10 current packages + the new placeholder-reserved package entries; commit snapshots.
8. Close `HarnessErrorCode` by flipping `(string & {})` to the enum shape — BUT: **do not** rename existing values yet (defer value renames to PR-3 together with root barrel trim to keep one big consumer-facing codemod). In PR-1, enum members are the 24 current string-literal codes plus `ADAPTER_CUSTOM` (new). `HarnessError.code` type changes from `HarnessErrorCode | (string & {})` to `HarnessErrorCode`. Internal throw sites still use the un-prefixed strings (enum member values match current strings 1:1 for PR-1).

**Gates**: typecheck + lint + test green; api-extractor snapshots committed; `pnpm verify:deps` green; seed fixture confirms lint rule fires.

### PR-2: Package extractions (~1-1.5 weeks; blocks on F-13)

**Scope**: F-3 + F-4 + F-10 + F-13.

1. Create `packages/cli/`. Move `packages/core/src/cli/*` content. Split `templates.ts` per §3.d into 13 files with `subpath-map.ts`. Declare `harness-one: workspace:*` as regular `dependency`. Move `bin` field.
2. Create `packages/devkit/`. Move `packages/core/src/eval/*` + non-runtime `evolve/*` content (everything except `architecture-checker.ts`). Declare `harness-one: workspace:*` as regular `dependency`.
3. Keep `architecture-checker.ts` in `packages/core/src/evolve/`; add `./evolve-check` subpath export in `harness-one/package.json#exports`. Add runtime-purity test per §3.j.
4. Remove `./cli`, `./eval`, `./evolve` subpath exports from `harness-one/package.json#exports`. Remove `bin` from `harness-one/package.json`.
5. F-13: migrate `examples/` — `from 'harness-one/eval'` → `'@harness-one/devkit'`, `from 'harness-one/evolve'` → `'@harness-one/devkit'`. Create `examples/package.json` declaring `@harness-one/devkit` as devDep. Wire `pnpm -C examples typecheck` into CI.
6. F-3 parser test: `packages/cli/src/__tests__/subpaths-resolve.test.ts` reads `harness-one/package.json` + `@harness-one/devkit/package.json`, asserts every value in `SUBPATH_MAP` resolves.
7. Regenerate api-extractor snapshots for `harness-one`, `@harness-one/cli`, `@harness-one/devkit`.
8. Decide `dist/infra` narrowing (belt-and-suspenders per critic §3.6): both (a) tsup `noExternal` + post-build `rm -rf dist/infra` AND (b) narrow `files` in `harness-one/package.json` from `["dist"]` to explicit list of surviving dirs. Add source-map step-into test (A-F-2 mitigation) — a test case that invokes a symbol transiting `infra/*` under `--enable-source-maps` and asserts no "cannot find source" stderr.

**Gates**: typecheck + lint + test green; `pnpm -C examples typecheck` green (F-13 blocks PR-2 merge); api-extractor snapshots match; F-3 parser test green; source-map step-into test green.

### PR-3: Surface lock (~3-5 days)

**Scope**: F-1 + F-6 (final form) + F-8 + F-14 + CHANGELOG authoring.

1. Trim `packages/core/src/index.ts` to the 20 value exports per §5. Remove every dropped symbol; add `// UJ-N:` justification comments.
2. Rename `HarnessErrorCode` members from current un-prefixed strings to module-prefixed (`UNKNOWN` → `CORE_UNKNOWN`, etc.) per §6. Codemod all 152 throw sites across 47 files in one sweep (jscodeshift or `ts-morph`). Update every internal `catch`/`switch` that narrows on the old code values.
3. Activate api-extractor CI gate in snapshot-diff mode across all 11 packages. CI must include both (a) snapshot-diff check, (b) `## API change rationale` regex check on PR descriptions (per PRD F-8).
4. Add lint rule `harness-one/no-type-only-harness-error-code` (custom ESLint rule, ~30 LOC) that flags `import type { HarnessErrorCode }` in consumer code — closes B-F-1 footgun (§3.f).
5. F-14 (defensive placeholder): publish README-only `@harness-one/core@0.0.0-reserved`, `@harness-one/runtime@0.0.0-reserved`, `@harness-one/sdk@0.0.0-reserved`, `@harness-one/framework@0.0.0-reserved` to npm. This is the sole wave-5C `npm publish` action (NG-2 exception); everything else waits for Wave-5G.
6. CHANGELOG: author the full B-1..B-13 breaking-change entries per PRD §8 inventory, each with a sed-style 1-liner. Include adapter-migration example from §6.
7. Regenerate api-extractor snapshots for all 11 packages. This PR's review surface is the `.api.md` diffs + barrel trim.

**Gates**: typecheck + lint + test green; api-extractor snapshots match; `## API change rationale` section present in PR-3 description; seed PR that adds an untagged export still passes (stability-tag enforcement is OFF in 5C — verified by not adding any tag to anything in PR-3); seed PR that adds `import type { HarnessErrorCode }` fails the new lint rule; `npm view @harness-one/core` returns the placeholder.

### Cross-PR invariants

- Every PR independently revertable (per `decisions.md` §风险与回滚).
- Changeset `linked` lockstep: PR-1, PR-2, PR-3 each ship a `.changeset/*.md` file covering all packages in the linked group.
- No `npm publish` of real artifacts — all real publishes land in Wave-5G (NG-2). PR-3 exception: README-only placeholders.

---

## 8. Wave-5C.1 deferral note

**Deferred items** (from PRD v2 §10 + lead LD-1):
- **F-7** — JSDoc stability tag required on every public export (`@stable` / `@beta` / `@alpha` / `@experimental`, optionally `@deprecated` with removal version per E-6).
- **F-11** — Doc-drift CI with format-option (iii) TSDoc presence + character threshold (§3.h locked).
- **api-extractor gate tightening** — flip snapshot-diff mode into snapshot-diff + stability-tag enforcement.
- **ADR 9.g resolved** — untagged = build-fail (§3.g locked).
- **ADR 9.h resolved** — option (iii) (§3.h locked).

**What main 5C pre-bakes for Wave-5C.1** (so 5C.1 is a small diff, not a design exercise):
1. api-extractor configs in main 5C include a commented-out strict-mode block:
   ```jsonc
   // "releaseTagPolicy": { "requireReleaseTag": true, "untaggedPolicy": "error" }
   ```
   5C.1 un-comments this across all 11 packages.
2. The 7 pre-existing `@deprecated` tags (E-6 verified at `packages/preset/src/index.ts` + `packages/core/src/core/event-bus.ts` + `packages/core/src/core/index.ts`) are preserved through main 5C. 5C.1 adds a matching stability tag on each (`@deprecated @beta` or similar) per the removal-version policy.
3. `decisions.md` follow-up line: "Wave-5C.1 opens within 1 week of main 5C merge; if it drags past 2 weeks, circuit-breaker per `decisions.md` §门禁条件."

**Estimated wall-clock for 5C.1**: ~1 week (F-7 tagging sweep ≈ 10-12h per skeptic §6.1 item 4, + F-11 ≈ 1-2 days, + config flip ≈ 0.5 day).

---

## 9. Risks accepted by this ADR

| # | Risk | Severity | Mitigation / Acceptance |
|---|---|---|---|
| R-1 | `HarnessErrorCode` value renames (e.g., `UNKNOWN` → `CORE_UNKNOWN`) land in PR-3 as a single large codemod; review noise is high. | Medium | Accepted. Mitigation: codemod is automated (`ts-morph`), 152 sites in 47 files, produces a deterministic diff; PR-3 description enumerates renames as a table. |
| R-2 | `import type { HarnessErrorCode }` silent runtime-introspection footgun (B-F-1). | Medium | Mitigated by new custom ESLint rule `harness-one/no-type-only-harness-error-code` (PR-3 item 4). Accepted residual: consumer projects that don't run our lint rule hit the footgun; documented prominently in CHANGELOG migration entry. |
| R-3 | `details.adapterCode: string` remains by-contract open (B-F-10). | Low | Accepted. Rationale: adapter authors must be able to emit their own taxonomies; closing `details.adapterCode` to a union would force every adapter package to declare its codes in `@harness-one/core`, which defeats the purpose of third-party adapter autonomy. Adapter packages document their sub-codes in their own READMEs. |
| R-4 | `rm dist/infra` post-build may break source-map step-into (A-F-2). | Medium | Mitigated in PR-2 item 8: belt-and-suspenders — both `rm dist/infra` AND narrow `files: [...]` — plus a source-map step-into CI test. If the test fails, fall back to `files`-narrowing only (drop `rm`). |
| R-5 | `@harness-one/devkit` regular `dependency` on `harness-one` doubles-install if consumer also installs `harness-one` directly (C-F-5 inverse). | Low | Accepted. `workspace:*` in dev; once published, pnpm de-dupes identical versions under lockstep. |
| R-6 | PD-2 linked lockstep publishes all 11 packages on every `changeset publish` (A-F-19). | Medium | Accepted per `decisions.md` §执行顺序 + LD-3. Measure on first real Wave-5G publish: `time pnpm changeset publish`; if > 5 min, re-open versioning strategy as a Wave-5G question. |
| R-7 | `packages/full/` deletion may break an undiscovered CI path. | Low | Mitigated by pre-delete audit (PR-1 step 3). |
| R-8 | `@harness-one/core` + `/runtime` + `/sdk` + `/framework` placeholder publishes signal "future rename" to the community (§3.a). | Low | Accepted. Mitigation: placeholder README states explicitly "reserved for future use; current runtime is the unscoped `harness-one` package. See MIGRATION.md." |
| R-9 | 5C.1 follow-up drags past the 1-week target. | Medium | `decisions.md` §门禁条件 circuit-breaker: if 2× estimate (≥ 2 weeks) without gate green, stop and report. |
| R-10 | Keeping `harness-one` unscoped means `0.x` → `1.0-rc.1` is a 10x major bump on an installed caret range (C-F-6). | Medium-High | Accepted. Mitigation: Wave-5G performs the explicit npm deprecation dance on `harness-one@0.4.x` with a pointer to `1.0.0` migration guide; 5C-phase releases are `1.0.0-rc.N` pre-releases which npm does NOT auto-install under caret ranges. |
| R-11 | 11 `*.api.md` files in main 5C mean every types-touching PR produces cross-package snapshot diff-noise (B-F-8). | Medium | Accepted. Mitigation: `pnpm api:update` is one command; `## API change rationale` section in PR description is the override ceremony. Measured in Wave-5D — if PR count with trivial snapshot churn > 30% of PRs, re-open gate design. |
| R-12 | Runtime-purity test for architecture-checker (§3.j) may be fragile if `harness-one`'s `dependencies` include anything transitively dev-only. | Low | Mitigated by test design: scan `dist/evolve/architecture-checker.js` resolved specifiers against declared `dependencies` in `harness-one/package.json`; any discrepancy fails fast with file:line. |

---

## 10. Defence against expected execution-stage challenges

Pre-empting the three most likely "this won't work" findings from spec-reviewer / red-team-attacker during the implementation review gate.

### 10.1 Expected challenge: "The enum `HarnessErrorCode` violates the 2024 TS community consensus that enums are anti-pattern; red-team will call this out."

**Defence**: The 2024-era "enums are anti-pattern" consensus applies specifically to **numeric enums** (reverse-mapping footguns, tree-shaking failures, `const enum` + `isolatedModules` incompatibility). **String enums** compile to a single `Object.freeze`-style const object; they tree-shake in esbuild / tsup / Rollup; they don't suffer the numeric-reverse-mapping issue; and they do not require `const enum`. The deliberate choice of string enum (every member = `'NAME' = 'NAME'`) produces an inlined pattern indistinguishable from A's `HARNESS_ERROR_CODES` array at runtime size, with one additional property: `Object.values()` gives the introspectable list, which is the B-DX win. Citation: TypeScript handbook "Enums at runtime" section; TS 5.0 `verbatimModuleSyntax` release notes confirming string-enum value-import preserves the runtime object.

**Compensating control**: the new ESLint rule `harness-one/no-type-only-harness-error-code` (PR-3 item 4) catches the one remaining enum footgun (`import type` silently dropping runtime).

### 10.2 Expected challenge: "F-6 enum-member rename (`UNKNOWN` → `CORE_UNKNOWN`) + PR-3 barrel trim is a breaking-change tsunami for adapter packages — spec-reviewer will say adapters don't have time."

**Defence**: Adapter packages (`@harness-one/openai`, `/anthropic`, `/redis`, `/langfuse`, `/opentelemetry`) are in-repo; they are touched by the same PR-3 codemod; there is no external adapter author to coordinate with pre-1.0 (PRD §2.3 "no known external consumers"). The 152 throw-site codemod is deterministic (`ts-morph` AST rewrite, not regex); the diff per file is 1-3 lines. Acceptance-reviewer can spot-check the generated diff; red-team-attacker can run the negative test (raw string `'UNKNOWN'` in a throw site must fail tsc post-codemod).

**Compensating control**: PR-3 CHANGELOG ships a rename-mapping table — 24 old values → 25 new values (adds `ADAPTER_CUSTOM`) — as a copy-paste sed script for any future adapter author.

### 10.3 Expected challenge: "`architecture-checker` runtime-purity test is brittle; spec-reviewer will say it's a test that will flake the first time `harness-one` adds any tool transitive dep."

**Defence**: The test does not check "zero transitive deps." It checks "every resolved specifier from `dist/evolve/architecture-checker.js` resolves through `harness-one/package.json#dependencies` (not `devDependencies`)." This is a static `require.resolve` walk, not a dependency-tree scan. Adding any new runtime dep to `harness-one/package.json#dependencies` keeps the test green; adding a devDep-only dep and then importing it from `architecture-checker.ts` fails the test — which is the intended fail-fast. The test is ~40 LOC, deterministic, and runs in < 2s.

**Compensating control**: If the test does flake in practice (e.g., Node resolution quirks across Node 18 vs 20), we pin Node version in CI to 20.x (already pinned per `decisions.md` Wave-5A) and add a `--experimental-vm-modules=false` guard. Test author has full freedom to refine the assertion shape without touching any runtime code, because it is pure reflection.

---

## 11. Eliminated alternatives (record for future reference)

| Decision | Rejected option | Rationale | Revisit if... |
|---|---|---|---|
| 9.a | Rename `harness-one` → `@harness-one/core` (B) | SEO/family value speculative; double mechanical sweep with 9.f enum rename; silent 0.x caret upgrade risk. | Post-1.0 support tickets demonstrate consumer confusion (e.g., ≥ 5 tickets mentioning wrong package name); revisit as 2.0 question. |
| 9.c | Merge into `@harness-one/native-deps` (A) | Asymmetric peer stories (Ajv sync, tiktoken WASM-async); merged error message quality worse; maintainer-cost saving minimal. | Both packages share > 100 LOC of mutual-utility code (C-F-19 graduation criterion). |
| 9.f | Template-literal union + `as const` tuples (A) | Loses `Object.values()` runtime introspection; longer error messages on exhaustive-switch failures (A-F-8). | TypeScript adds first-class runtime introspection for type-only unions (not on the roadmap). |
| 9.f | Tagged-object `ADAPTER_CUSTOM` (C) | Changes `err.code` from `string` to `string \| object`; breaks every logger/telemetry stringifier; breaks generic `HarnessErrorCode extends string` patterns (C-F-11). | Type-safe logger libraries become universal; re-open in 3.0. |
| 9.j | Move architecture-checker to devkit (A) | Breaks runtime `initialize()` consumers; Wave-5A preset cannot call it. | Evidence shows zero in-tree or external runtime callers for ≥ 6 months. |
| Sequence | One atomic mega-PR (B) | Review surface ≥ 30-60 files + all examples + all snapshots; review cost severe (B-F-11). | Never — three-PR sequence is the acceptable structure per `decisions.md`. |
| Lint | Custom `no-restricted-imports` glob (A) | Works but harder to read; `eslint-plugin-import`'s `no-internal-modules` is the de-facto standard (C §6.2). | Plugin is deprecated or unmaintained. |
| Barrel | 22-symbol barrel with `createFallbackAdapter` + `withSelfHealing` (C) | Day-1 user doesn't need these; promotes advanced-composition symbols to marquee (C-F-10). | Wave-5D usage telemetry shows ≥ 30% of new users call these in the first hour. |
| Barrel | `export * as guardrails` namespace (B) | Defeats tree-shaking in some bundler configs (B-F-7); reduces IDE autocomplete discoverability. | Bundler ecosystem universally supports strict namespace re-export tree-shaking. |
| Barrel | `assertNever` at root (C) | Not a library responsibility; consumer 2-liner (C-F-9). | — |
| 9.g | Untagged = `@stable` (A) | Silently promotes forgotten internals (A-F-5). | — |
| 9.g | Untagged = `@experimental` (B) | Undermines 1.0-rc quality bar (B-F-13). | — |
| Changeset | `fixed` mode (C) | Publishes every package on doc-only PRs (C-F-8); inflationary over 10-wave cycle. | 10-package fan-out grows to ≥ 20 packages — fixed becomes cheaper than linked-group enumeration. |
| Devkit dep | peerDep on `harness-one` (C) | Breaks `pnpm add -D @harness-one/devkit` standalone flow (C-F-5). | Devkit grows to contain non-harness-one-dependent tooling and starts serving non-harness-one consumers. |
| F-8 | CODEOWNERS `@api-stewards` 2-approver gate | Per LD-2: avoid over-gating during rc. | Wave-5G release-readiness — open at that time. |

---

## 12. Acceptance checklist (hand-off to task-planner)

**Main 5C accepted when**:
- [ ] PR-1 + PR-2 + PR-3 all merged to `wave-5/production-grade`, each independently revertable.
- [ ] Every `F-1..F-6, F-8..F-10, F-12..F-14` measure in PRD v2 §6 met.
- [ ] All 11 packages have a checked-in `<pkg>.api.md`; api-extractor CI in snapshot-diff mode green.
- [ ] `pnpm verify:deps` green.
- [ ] `pnpm -C examples typecheck` green.
- [ ] F-3 `SUBPATH_MAP` parser test green.
- [ ] Architecture-checker runtime-purity test green.
- [ ] `dist/infra` reach-in seed fixture fails lint.
- [ ] Source-map step-into test green.
- [ ] `no-type-only-harness-error-code` lint rule fires on seed fixture.
- [ ] Four placeholder packages (`@harness-one/core`, `/runtime`, `/sdk`, `/framework`) at `0.0.0-reserved` visible via `npm view`.
- [ ] Full CHANGELOG authored with adapter-migration example and rename-mapping table.
- [ ] Every decision in §3 cross-referenced to its ADR entry in CHANGELOG "Decisions" section.
- [ ] `docs/architecture/` updated per user memory rule.

**Wave-5C.1 accepted when** (per PRD v2 §14):
- [ ] F-7 stability tags present on every public export.
- [ ] F-11 doc-drift CI green with option (iii).
- [ ] api-extractor strict mode (stability-tag enforcement) active across all 11 packages.
- [ ] ADR 9.g + 9.h formally resolved in a Wave-5C.1 ADR addendum.

---

**End of Wave-5C ADR. Hand off to task-planner.**
