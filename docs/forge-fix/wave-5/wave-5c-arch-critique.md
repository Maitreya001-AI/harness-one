# Wave-5C Architecture Critique (technical-critic)

**Reviewer**: technical-critic (Phase 2, adversarial design)
**Date**: 2026-04-15
**Branch**: `wave-5/production-grade` @ HEAD
**Targets**:
- `docs/forge-fix/wave-5/wave-5c-arch-A-minimalist.md` (Architect A)
- `docs/forge-fix/wave-5/wave-5c-arch-B-ergonomic.md` (Architect B)
- `docs/forge-fix/wave-5/wave-5c-arch-C-ecosystem.md` (Architect C)
**Method**: six-dimension challenge per architect (scalability, SPOF, cost, complexity, tech risk, migration) + PRD-v2 compliance + Wave-5 invariant compliance + spot-check verification against HEAD.
**Locked constraints honored**: scope `@harness-one/*`; changeset `linked` lockstep; api-extractor snapshot-diff-only in main 5C; F-7/F-11 → 5C.1; F-14 conditional.

> Pre-decided axes intentionally untouched: scope-level publish under `@harness-one`, `linked` lockstep, api-extractor snapshot-diff mode, F-7/F-11 split, F-14 conditional. All three proposals accept these.

Divergence axes analyzed (per brief):
1. **Top package name** — A keep / B rename to `@harness-one/core` / C keep (with marquee-vs-scoped precedent).
2. **`ajv` + `tiktoken`** — A merge into `@harness-one/native-deps` / B keep / C keep.
3. **`HarnessErrorCode` pattern** — A template-literal-as-const tuples / B string enum / C branded string union w/ tagged-object `ADAPTER_CUSTOM`.

Secondary axes: root barrel size (A 18 / B 22 / C 22); `essentials.ts` fate (all three delete — closed); CJS for devkit (A ESM-only / B+C dual); 5C.1 stability default (A @stable / B @experimental / C neutral).

---

## 1. Per-architect attack

### 1.A — Architect A ("Minimalist Purist"): 20 findings

**Sharpest first**: A claims `architecture-checker` is not specified. Spot-check disproves: `packages/core/src/evolve/architecture-checker.ts` exists at HEAD, is re-exported from `packages/core/src/evolve/index.ts`, and has `__tests__/architecture-checker.test.ts` (verified by Grep). A's proposal silently drops architecture-checker into `@harness-one/devkit` with no runtime-vs-dev-time analysis — a SIGNIFICANT regression flag that C catches and A misses.

#### A-F-1 (FATAL) — Architecture-checker mis-classification
A lists `architecture-checker` under devkit (§2, table row for `@harness-one/devkit`). C correctly identifies (§2.1) that architecture-checker is a runtime-checkable concern callable from `initialize()`. If A moves it to a devDep-only package, any runtime consumer that invokes `checkArchitecture()` at boot crashes on `MODULE_NOT_FOUND` in production images that skip devDeps. A does not address this and does not run a grep of consumers of `architecture-checker`. **Evidence**: `packages/core/src/evolve/architecture-checker.ts` HEAD; `packages/core/src/evolve/index.ts:*` re-exports it; A's §2 table puts whole `evolve/` → devkit.

#### A-F-2 (CRITICAL) — `rimraf dist/infra` post-build breaks source-map step-into
A §3.1 proposes post-build `rm -rf dist/infra` to close the deep-dist reach-in gap. The runtime-emitted bundles (`dist/core/index.js` etc.) bundle `infra/*` internals; if source maps reference the deleted files, consumers hit "cannot find source" errors when debuggers step into the infra layer. B explicitly identifies this trade-off (B-6.3) and chose the softer `package.json#files` narrowing. A's choice is cheaper but has a real DX bite; not flagged in §11 risks.

#### A-F-3 (SIGNIFICANT) — Merged `@harness-one/native-deps` forces peerDep asymmetry under one flag
A §3.4 declares both peers `peerDependenciesMeta.optional`. Consumer installs `@harness-one/native-deps` + `ajv`; they never use tiktoken. The tiktoken subpath's module-level `import` of tiktoken will still be parsed (if the subpath is imported at all, which it isn't for this consumer — so this is fine). But consumers who DO touch `createTiktokenRegistry` without `tiktoken` installed get an **opaque** module-resolve error, not the nice "install tiktoken to use this" message B and C produce via per-package `peerDependencies` (non-optional). A's merge costs a better failure-mode message.

#### A-F-4 (SIGNIFICANT) — Scope asymmetry `harness-one` + 6 × `@harness-one/*` is already a readability smell
A §2 honestly flags the asymmetry as R-A2 "low impact". For a 1.0-rc surface this is the ONE chance to fix. A's "pure ceremony cost, zero user value pre-1.0" argument (§1 position + R-A2) ignores B's SEO argument and C's own concession that the split is "visually jarring" (C §R-C1). A treats the rename as pure cost; the value is on the other side of the ledger and A does not weigh it.

#### A-F-5 (SIGNIFICANT) — "Untagged = `@stable`" default (ADR-5C-A-09) contradicts 1.0-rc quality bar
A §1 position statement and ADR-09 say: "If you exported it, you signed up to support it — no untagged `@stable`". A's own risk R-A4 admits "every existing export becomes a frozen contract when tags land" and rates it Medium/Medium. PRD v2 §9.g frontrunner is **build-fail on untagged** per skeptic critique §7. A chose the *opposite* of the skeptic-recommended default. Given Wave-5 invariant "1.0-rc quality accepts breaking changes but does NOT compromise contract honesty", A's default silently promotes every forgotten internal export to `@stable`. This is the safest-looking-but-most-dangerous stability-tag policy.

#### A-F-6 (CRITICAL) — Build-time `rm dist/infra` breaks CJS consumers using `require('harness-one/dist/...')`
A §11 R-A6 catalogues this risk as Low/Low. A CJS consumer that reaches into `harness-one/dist/core/index.cjs` is within-exports-map-contract. If the CJS bundle internally `require`s an inlined-then-deleted path (depends on tsup output config A didn't specify), the bundle breaks at runtime. A's proposal §3.1 notes "slightly larger `dist/*.js` files because infra gets inlined" — but does not produce a test fixture to prove inlining works for both ESM+CJS.

#### A-F-7 (SIGNIFICANT) — 18-symbol barrel forces preset + examples churn
A R-A3 calls this "High probability / Low impact"; A's own §4 deletes `createResilientLoop` from root which B (B §4) and C (C §4) both preserve. `createResilientLoop` is the canonical way to wrap AgentLoop with retries; demoting it to subpath is a genuine DX regression. Probability it bites users is high; impact is a subpath import every caller rewrites — that's Medium impact, not Low.

#### A-F-8 (ADVISORY) — `HARNESS_ERROR_CODES` grouped tuples add build-step indirection
A §5.1 uses `(typeof CORE_CODES)[number]` × 9 prefix arrays merged into one union. TypeScript's type-inference produces the correct union but error messages from `never`-branch failures in exhaustive switches will surface as "Type '...' is not assignable to type '(typeof CORE_CODES)[number] | (typeof LOOP_CODES)[number] | ...'" — much longer than a flat string-literal union. Minor ergonomic cost.

#### A-F-9 (SIGNIFICANT) — `ADAPTER_CUSTOM` escape makes every adapter error narrow through `details.adapterCode`
A §5.2 shows `if (err.code === 'ADAPTER_CUSTOM' && err.details?.adapterCode === 'OPENAI_RATE_LIMIT')`. Every existing `@harness-one/openai` error-narrowing site needs this two-condition rewrite. A lists 152 throw sites (§5.3) but does not enumerate the adapter-package throw sites separately, nor the consumer-side catch sites. **Estimate**: at least 20+ consumer-side narrowing rewrites across `packages/openai`, `packages/anthropic`, `packages/redis` — NOT "mechanical `sed`".

#### A-F-10 (CRITICAL) — No CJS for devkit (ADR-5C-A-08) breaks Jest-CJS consumers silently
A ADR-08 claims "modern Jest speaks ESM". Jest's ESM support (as of Jest 29) requires `NODE_OPTIONS=--experimental-vm-modules` and has known issues with module mocking. Many production monorepos still run Jest 27 or 28 in CJS mode. A's R-A5 rates this Low/Low with no evidence.

#### A-F-11 (SIGNIFICANT) — Native-deps merge removes independent version signal under PD-2 `linked`
A §12.1 sharpest-counter claims "a package whose version never moves independently under PD-2 lockstep is not a package — it is a subpath with extra ceremony". This is rhetorically strong but self-defeating: by this logic, `@harness-one/langfuse` and `@harness-one/opentelemetry` should ALSO merge (both version-move only under lockstep). A arbitrarily applies "merge if lockstep" to ajv+tiktoken but not to the five other adapters. Inconsistency.

#### A-F-12 (CRITICAL) — F-10 template split claims "~55 LOC median" without LOC verification
A §8.2 lists 12 files at ~55 LOC each. Current `templates.ts` = 651 LOC total across 12 module entries = ~54 LOC avg ✅. But: `eval` + `evolve` are merged into one `devkit.ts` at ~50 LOC (A §8.2) — the current two contribute ~110 LOC combined per sampling of `templates.ts`. Merging halves the template size, which drops scaffolded code quality for users who `init --module=eval`. A loses information.

#### A-F-13 (ADVISORY) — `disposeAll` + `DisposeAggregateError` at root barrel (§4.1) is premature
A adds `DisposeAggregateError` to the 18-symbol barrel. Grep of consumer code would probably show zero catches of this error today. Premature addition to the 1.0 surface.

#### A-F-14 (SIGNIFICANT) — Wave-5D friendliness: A's `./observe` subpath survives but A deletes `createCostTracker` from root
Wave-5D introduces `MetricsPort` per `decisions.md`. `createCostTracker` is the Wave-5D port entry. Demoting it to subpath-only (A §4.3 line 132-138) forces Wave-5D to re-promote it — or tacitly decide the port lives at subpath. A does not discuss this.

#### A-F-15 (SIGNIFICANT) — Wave-5E friendliness: no `createAuthContext` at root either (A §4.3)
Wave-5E introduces branded types + multi-tenant `AuthContext`. A demotes to subpath. Each Wave-5E PR now changes the root barrel AND the subpath — two api-extractor diffs per tenant-safety addition. B keeps `createSessionManager` at root but also demotes `createAuthContext`; C does the same. All three architects treat `AuthContext` as non-marquee. This is a shared miss but A's minimalist bar forces the miss harder.

#### A-F-16 (ADVISORY) — ADR-5C-A-07 asserts zero `harness-one/essentials` consumers
A grepped `packages/` + `examples/` but not docs/README/blog content. Claim is likely true but evidence is under-specified.

#### A-F-17 (SIGNIFICANT) — Architecture-checker in devkit means `@harness-one/preset` can't call it during `createSecurePreset`
If Wave-5A's `createSecurePreset` ever wants to assert "all guardrails wired" via architecture-checker in production, it can't — preset is a runtime package, devkit is dev-time. C catches this (§2.1); A does not.

#### A-F-18 (ADVISORY) — Risk R-A9 claims zero consumers of `harness-one/essentials`
Consistent with spot-check (no in-repo hits). Acceptable.

#### A-F-19 (CRITICAL) — Linked-group publish of 10 packages on every change (A R-A8) is real cost ignored
A §9.1 puts all 10 packages in one `linked` group, including `harness-one`. Every patch-level change triggers 10 × `npm publish`. At ~4-5s each = ~45s wall-clock. More importantly: 10 × GitHub release notes entries, 10 × CHANGELOG.md updates. A frames this as "intentional cost" but does not quantify the cumulative 10-wave release burden.

#### A-F-20 (SIGNIFICANT) — Defense §12.1 undercuts ajv+tiktoken *merge* argument
A §12.1 argues "the real weight is the peer dep"; consumers install `ajv` as peer. Therefore merging saves no consumer bytes. The only saving is monorepo maintenance. A's own argument reduces the merge to a maintainer-cost optimization that trades away the peerDep message quality (A-F-3). Net value is close to zero for consumers.

---

### 1.B — Architect B ("Consumer Ergonomics First"): 20 findings

**Sharpest first**: B claims `HarnessErrorCode` enum gives `Object.values()` runtime introspectability (B §5 table) and uses this as the *deciding* argument against template-literal unions. This is **conditionally true** — `Object.values(HarnessErrorCode)` works *only* when the consumer uses a **value import** (`import { HarnessErrorCode }`). TypeScript 5.x best practice with `verbatimModuleSyntax: true` requires `import type` for type-only uses. A consumer who writes `import type { HarnessErrorCode }` gets the type but loses runtime introspection silently — exactly the footgun B attacks template-literal for. B's table is misleading: it compares approaches without stating "requires value-import" constraint on the enum row.

#### B-F-1 (CRITICAL) — Enum + `import type` silent-introspection-loss
As stated above. Under modern TS `verbatimModuleSyntax`/`isolatedModules` configurations (Vite, tsup, SWC all default on), `import { HarnessErrorCode }` as a value import bundles the enum runtime object; `import type { HarnessErrorCode }` does not. B's proposal gives *two code patterns that look nearly identical* with radically different runtime behavior. Template-literal union does not have this cliff (no runtime presence either way). **Evidence**: TypeScript handbook "Enums at runtime"; TS 5.0 `verbatimModuleSyntax` release notes. This is a significant tech-risk that B's position statement sells as the chief advantage.

#### B-F-2 (FATAL) — Enum code rename cascades through adapter packages without a migration table
B §5 renames every existing code (e.g., `UNKNOWN` → `CORE_UNKNOWN`, `INVALID_PIPELINE` → `GUARD_INVALID_PIPELINE`, `SPAN_NOT_FOUND` → `TRACE_SPAN_NOT_FOUND`). Spot-check of `packages/core/src/core/errors.ts:31-55` confirms current codes are un-prefixed strings. Adapter packages throw `new HarnessError(..., 'CUSTOM_OPENAI_CODE', ...)` today (open via `(string & {})`). B closes the union but the codemod is hand-waved as "152 throw sites update mechanically". Rename-mapping table absent from the proposal. A produces an explicit mapping table (A §5.3); B does not. This is an implementation-readiness gap.

#### B-F-3 (CRITICAL) — Rename `harness-one` → `@harness-one/core` compounds with enum value imports in every consumer
B requires BOTH (a) import path rewrite `harness-one` → `@harness-one/core` and (b) enum value import for the `Object.values` use case. For every consumer: two mechanical sweeps, not one, and if the second is missed the symptom is silent `undefined` from `Object.values`.

#### B-F-4 (SIGNIFICANT) — `@harness-one/core` rename's npm SEO argument is partly wrong
B §12.2 claims "scoped names rank lower in npm search" — true *when* the marquee unscoped name exists. But post-rename B orphans the unscoped name anyway (LD-3 placeholder-only). The SEO comparison is not "scoped vs unscoped" but "scoped (1.0-rc) vs historic 0.x unscoped artifact" — where the 0.x has zero organic traffic (pre-release). C's SEO argument (§12.2) is sharper but also dated to "pre-1.0 we're building Google history" — equally unverified.

#### B-F-5 (CRITICAL) — F-14 placeholder publish adds release-path coupling
B §9.4 step 2: publish `@harness-one/core@1.0.0-placeholder.0` BEFORE the changeset merge. This introduces a manual step *outside* the `pnpm changeset publish` flow. Release engineering risk: forgotten placeholder → first real publish collides with squatter. B does not propose automating the placeholder.

#### B-F-6 (SIGNIFICANT) — 22 symbols + `createResilientLoop` + `createPromptBuilder` is not the minimum viable set
B §4 keeps `createResilientLoop` AND `createPromptBuilder` at root. A demoted both. Neither is Day-1 UJ-1 material per PRD UJ-1 criterion ("runtime-only consumer gets `AgentLoop`, `defineTool`, `createTraceManager`"). B's prose says "30-minute-README symbols"; `createPromptBuilder` is not a 30-minute symbol. Barrel inflates against stated criterion.

#### B-F-7 (ADVISORY) — `guardrails.run*` namespace (B §4) hides discoverability
B folds `runInput`, `runOutput`, `runToolOutput` into `export * as guardrails`. Saves 2 slots but IDE autocomplete for `guardrails.` is less discoverable than three top-level names. Mild DX loss for a slot-count win. Namespace-reexport also defeats tree-shaking in some bundler configs (Webpack 5 is fine; esbuild with strict flags can over-include).

#### B-F-8 (SIGNIFICANT) — Subpath count 11 for `@harness-one/core` matches A and C but B keeps `./orchestration` while A+C keep it too — consistent; however B's api-extractor story is 11 invocations + per-package → ~11 additional `.api.md` files, NOT reduced
B R-B4 says "~11 invocations add ~30s CI". Plus `@harness-one/devkit/eval` + `/evolve` each need snapshots (B §3.3). Total `.api.md` files: 11 (core) + 4 (devkit root + 2 subs + cli + preset + 5 adapters + 2 native-deps) = ~22 checked-in `.api.md`. Every PR that touches types produces diff-noise across many of these. Maintenance cost underestimated.

#### B-F-9 (SIGNIFICANT) — `@harness-one/devkit` as `peerDependency` on `@harness-one/core` (which B §2 says "depends on `@harness-one/core` as a regular dep so `pnpm dlx` resolves" — WRONG ref)
Re-read B §2 row for cli vs row for devkit. CLI is `dependency`; devkit is `devDependency (or pnpm dlx)`. But if devkit peerDeps core (C §3.3 does this; B does not explicitly specify core-dep kind for devkit), a consumer who installs `@harness-one/devkit` without `@harness-one/core` gets a peer-unmet warning. If devkit declares `@harness-one/core` as regular `dependency`, every `pnpm add -D @harness-one/devkit` doubles-installs core. B §2 doesn't pick. Ambiguity.

#### B-F-10 (FATAL) — `AdapterErrorCode.ADAPTER_CUSTOM` with `details.adapterCode: string` reopens the enum closure
B's enum has `ADAPTER_CUSTOM` as a single member. Runtime adapter uses `code: HarnessErrorCode.ADAPTER_CUSTOM`, `details.adapterCode: 'OPENAI_RATE_LIMIT'`. The union is "closed" for `code` but `details.adapterCode` is typed `string` — same open sink the PRD F-6 closes, just relocated. C's branded-object escape attempts to close this (C §5.2), at the cost of making `err.code` non-string sometimes. Neither A nor B close `details.adapterCode`. **Question for arbiter**: is "open adapter sub-code" an acceptable escape, or must it also be closed via adapter-owned unions? PRD §9.f is silent on this.

#### B-F-11 (CRITICAL) — F-4 "atomic single commit" requires same-PR F-1 + F-3 + F-4 + F-13 landing
B §10 "land atomically with F-3 + F-4 + F-1". This is a mega-PR ~30-60 files changed + all examples migrated + all api-extractor snapshots regenerated. PR-review cost is severe. A and C do not prescribe atomic landing; they sequence via the changeset. B's atomicity is a revision-control risk during review.

#### B-F-12 (SIGNIFICANT) — "Every @harness-one/* package as its own install" forces prod consumers to install ≥2 packages (core + openai)
B §12.1 counter to A: "runtime consumer installs 2 packages, not 11" — true, but today's HEAD already matches this (`harness-one` + `@harness-one/openai`). B's rename just converts the left side to `@harness-one/core`. The consumer-install-count argument doesn't favor B over A.

#### B-F-13 (SIGNIFICANT) — Default `@experimental` for untagged (5C.1) undercuts 1.0-rc promise
B §7.3 comment + R-B8 propose `@experimental` as the untagged default. PRD §9.g frontrunner is build-fail. Shipping 1.0-rc with most exports silently `@experimental` tells consumers "this is still an incubator" — which contradicts the Wave-5 decision "1.0-rc quality". B's ergonomics-friendly default is the *weakest* of the three on 1.0-rc quality bar.

#### B-F-14 (ADVISORY) — `HarnessErrorCode` enum + renaming codes increases the 1.0-rc breaking-change B-7 scope by 24 × consumer
B adds enum naming prefix churn on top of union closure. A+C also rename but keep strings. Under a 1.0-rc "breaking OK" invariant this is tolerable, but the churn is larger than A's.

#### B-F-15 (SIGNIFICANT) — "Fixed" changeset mode (C uses it) vs "linked" (B uses it) — B inconsistent with own claim
B §9.2 uses `linked`, not `fixed`. B's §9.2 paragraph "linked bumps every package ... highest bump level" is correct. But B also says "every release cycle the whole set bumps" — that's `fixed` semantics. Conceptual confusion between linked and fixed.

#### B-F-16 (SIGNIFICANT) — F-12 `verify:deps` CI script has no owner file path specified
B §9.3 references `scripts/verify-deps.ts`; A §9.3 references `tools/verify-deps.ts`. Trivial but reveals that neither architect nor the PRD picked the canonical script location. Risk: two implementers produce two different scripts.

#### B-F-17 (ADVISORY) — `dist/infra` narrowed via `files` list (B §6.3) requires enumerating every surviving dir
B lists 11 dist dirs explicitly. Adding a new subpath requires updating `files`. Maintenance cost + bus-factor risk. A's `rm dist/infra` is simpler (but has A-F-2 source-map risk).

#### B-F-18 (CRITICAL) — Rename means `harness-one@0.4.x` on npm becomes a permanent orphan
B LD-3 + §9.4 keep `harness-one@0.4.x` untouched on npm. Consumer on 0.4.x with no migration guide runs `npm outdated` and sees no updates. Silent obsolescence until Wave-5G full deprecation. Not catastrophic but ethically dubious.

#### B-F-19 (SIGNIFICANT) — `@harness-one/devkit` sub-exports `./eval` + `./evolve` (B §3.3) duplicates the root barrel
Root `@harness-one/devkit` re-exports `createEvalRunner, createRelevanceScorer, createComponentRegistry`. Subpaths `./eval` + `./evolve` also export them. Two entry points for the same symbols — the exact anti-pattern PRD §2.1 ("three entries") rails against. Reduced, not eliminated.

#### B-F-20 (ADVISORY) — `createHarness` via preset remains at preset; `createSecurePreset` is re-exported at core root (A does this; B does it via "re-export from `@harness-one/preset`")
Both A and B re-export `createSecurePreset` at core root. Creates a cycle-risk: `@harness-one/core` depends on `@harness-one/preset` depends on `@harness-one/core`. B does not address cycle (A §4.1 doesn't either). Should be explicitly a type-only re-export or moved to preset-only.

---

### 1.C — Architect C ("Ecosystem Alignment"): 20 findings

**Sharpest first**: C cites `react` + `@types/react` as an analogy for `harness-one` + `@harness-one/{cli,devkit}`. The analogy **breaks**: `@types/react` is community-maintained (publisher: `@types`, DefinitelyTyped), NOT a publisher-scope-mate of `react`. The true scope-mate pattern (next + `@next/*`, vite + `@vitejs/*`, stripe + `@stripe/*`) exists but at the cost of the "marquee unscoped name + own-scope supplementaries" being less universal than C implies. C's precedent citation is load-bearing for the keep-unscoped decision and it is partly inaccurate.

#### C-F-1 (CRITICAL) — `react + @types/react` analogy is false in the way C uses it
As above. `@types/react` is DefinitelyTyped, published under the `@types` scope controlled by Microsoft. `react` publisher is `react` / Facebook. They are not "the same org split between marquee + supplementaries". C §1 uses this as a top-line argument. Retain C's claim only for `vite`, `next`, `stripe` — drop `react`. If C drops the weak citation, the argument remains but is noticeably thinner.

#### C-F-2 (SIGNIFICANT) — `vitest` + `@vitest/*` is *not* the pattern C claims either
`vitest` (marquee) uses `@vitest/*` for internal packages (`@vitest/runner`, `@vitest/utils`), which are runtime deps of `vitest`, not consumer-facing supplementaries. Our `@harness-one/cli` and `@harness-one/devkit` are **consumer-facing** packages. The precedent fit is imperfect; C overstates.

#### C-F-3 (FATAL) — Tagged-object `ADAPTER_CUSTOM` breaks every existing `switch (err.code)` site
C §5.2 declares `HarnessErrorCode` includes `{ readonly tag: 'ADAPTER_CUSTOM'; readonly adapterCode: string }` as a *union member*. This means `err.code` is sometimes a string, sometimes an object. Consumer code today (spot-check `packages/preset/src/index.ts` lines around eventBus area would show this pattern) assumes `err.code: string`. Every `err.code === 'X'`, every `err.code.startsWith('X_')`, every `String(err.code)` in logs becomes wrong or noisy. C R-C5 acknowledges this as "Low — verbosity is load-bearing". It is NOT low: it is a Type change that flips `.code` from `string` to `string | object`. Every logger and every analytics pipeline that stringifies errors is affected.

#### C-F-4 (CRITICAL) — `architecture-checker` stays in core (C §2.1) is RIGHT but un-analyzed
C's decision is correct per spot-check (`evolve/architecture-checker.ts` is runtime-invocable) but C does not propose a test that *proves* architecture-checker has no devDep-only deps and is therefore safely in `harness-one` runtime. C invents a new subpath `./evolve-check` — a 13th subpath — and does not justify against F-1's "≤11 subpaths" implicit ceiling from post-trim state (11 after cli+eval+evolve removed). The net is 12 with evolve-check added. Minor scope expansion flagged but not quantified.

#### C-F-5 (SIGNIFICANT) — `@harness-one/devkit` peerDep on `harness-one` (C §3.3) breaks `pnpm dlx` / `npx` story
peerDeps do not auto-install; pnpm emits warnings, npm 7+ auto-installs but with ambiguous versioning. A consumer `pnpm add -D @harness-one/devkit` needs a companion `pnpm add harness-one` (or devDep). C §3.3 cites `vitest peerDeps vite` precedent but vite is usually already present in a vite-using project. In our case a pure-evaluation consumer might not want `harness-one` runtime at all — in which case devkit's architectural fit is wrong. C does not analyze.

#### C-F-6 (CRITICAL) — Keeping `harness-one` unscoped (C §1) inherits the existing `harness-one@0.1.0` on npm (package.json spot-check: version `0.1.0`)
Spot-check `packages/core/package.json:3` shows `"version": "0.1.0"`. If we keep the name and bump to `1.0.0-rc.1`, anyone with `harness-one@^0.1` in their lockfile gets silently upgraded across a 10x major version jump by `npm install` with caret ranges. B's rename avoids this via a net-new name; A+C inherit it. Wave-5G deprecation of `harness-one@0.4.x` (per PRD LD-3) is explicitly deferred. Rc-to-1.0 upgrade path is nonetheless surprising.

#### C-F-7 (SIGNIFICANT) — `no-internal-modules` from `eslint-plugin-import` (C §6.2) is already the de facto convention but C does not verify it's installed
Spot-check: root `.eslintrc` install not verified by C. If the plugin is not yet installed, F-2 now has an implicit dependency-add. A uses core eslint's `no-restricted-imports` (native, no dep add). C's choice adds one devDep for readability. Minor.

#### C-F-8 (ADVISORY) — `fixed` changeset mode (C §9.2) publishes every package even without changes
C R-C6 admits this and calls it "inflationary in rc, cheap in practice". But every rc publish burns one version number across all 10 packages even for doc-only PRs. Over 10-wave release cycle that's ~10-20 unnecessary version bumps per package. Cost non-trivial over time.

#### C-F-9 (SIGNIFICANT) — C's root barrel includes `assertNever` (§4)
B and A both drop `assertNever` from the barrel (A deletes it as "TS idiom; 2-liner"). C keeps it. `assertNever` is not a library responsibility; it's a consumer utility. Slot-inflation for zero UJ value.

#### C-F-10 (SIGNIFICANT) — C's root barrel includes `createFallbackAdapter`, `createResilientLoop` (§4 line "Core loop (5)")
These are advanced-composition symbols for error-recovery patterns. Day-1 user does not need them. B also keeps `createResilientLoop` but drops `createFallbackAdapter`. A drops both. C's "what first-time user types" justification (§4) doesn't fit advanced fallback composition.

#### C-F-11 (CRITICAL) — `AdapterErrorCode.ADAPTER_CUSTOM` as object member reopens the type union in a new way
See C-F-3. The union `HarnessErrorCode = CoreErrorCode | ... | AdapterErrorCode` where `AdapterErrorCode` includes an object means `HarnessErrorCode` itself is no longer a string-literal type. Tests that do `type X = keyof { [K in HarnessErrorCode]: ... }` now fail because object types can't be keys. This breaks generic code patterns that assume `HarnessErrorCode extends string`.

#### C-F-12 (ADVISORY) — `@harness-one/core/evolve-check` subpath (C §3.1) — what's the api-extractor story for a single-file subpath?
A single-file module needs its own api-extractor config. C §7.3 says "12 invocations for harness-one" but post-edit with evolve-check added it's 13. Small but un-noted.

#### C-F-13 (SIGNIFICANT) — "LangChain fragmented in 2023, un-fragmented in 2024" cite (C §12.1) is real but mis-applied
LangChain's consolidation was community-driven and focused on LCEL (langchain expression language) unification — not about package count per se. LangChain today still has 40+ scoped packages under `@langchain/*` + the marquee `langchain`. The cautionary tale C cites supports *keeping the marquee*; it does not support *refusing to add scoped supplementaries*. C's argument against B's rename is strong; C's argument against A's native-deps merge is weak using this same citation.

#### C-F-14 (SIGNIFICANT) — `AWS SDK v3` citation (§12.2) is cautionary but C's proposed shape has only 10 packages, not 350
AWS SDK v3 is 350+ packages. Our 10-package fan-out is orders of magnitude smaller and does not share the v3 failure mode. C's "AWS is cautionary" argument proves too much — it would also argue against C's own proposal to have 10 packages. Citation over-applied.

#### C-F-15 (SIGNIFICANT) — `./evolve-check` invents a subpath pattern NOT in any cited SDK
C §1 claims to "copy what works". `./evolve-check` is a novel subpath name. Stripe doesn't have `./webhooks-runtime`; OpenAI doesn't have `./usage-runtime`. C invents a convention here under the banner of "no novelty". Internal inconsistency with C's §1 position.

#### C-F-16 (CRITICAL) — `files: ["dist"]` unchanged (C §6.3) leaves `dist/infra/` shipped
C §6.3 says explicitly "keep `dist/infra/` shipped; block *import* via exports-map + lint". Exports map doesn't list `./infra`, so Node's strict `exports` should reject `import 'harness-one/infra/lru-cache'` — but this is **only** enforced when the consumer's Node version respects strict exports (Node 12.17+ default ON). CJS consumers using `require.resolve('harness-one/dist/infra/lru-cache')` bypass the exports map entirely. C leaves this open as acceptable; A closes it via `rm dist/infra`; B closes it via `files` narrowing. C's "exports-map is enough" claim is partially true and admits a remaining vector.

#### C-F-17 (SIGNIFICANT) — Branded object-code `ADAPTER_CUSTOM` requires adapter packages to import `AdapterErrorCode` type, not string
Current adapter code (spot-check `packages/openai/src/` would show) throws with string code. C forces every adapter to switch to `throw new HarnessError(msg, { tag: 'ADAPTER_CUSTOM', adapterCode: 'OPENAI_RATE_LIMIT' })`. This is MORE breaking than A's template-literal or B's enum for adapter authors. Adapter migration cost: high.

#### C-F-18 (ADVISORY) — C's 22-symbol barrel includes `createSecurePreset` at root (re-export from `@harness-one/preset`)
Same cycle concern as B-F-20. Not flagged by C.

#### C-F-19 (SIGNIFICANT) — Both `@harness-one/ajv` + `@harness-one/tiktoken` kept (C §2) — R-C3 rates this "Low: reviewers will call it clutter"
True assessment. C defers the consolidation question but does not offer a clear graduation criterion ("if both packages have shared utility code > 100 LOC, merge"). No guidance for future maintainers.

#### C-F-20 (ADVISORY) — 5C.1 stability default not proposed (C absent from §9.g)
A proposes `@stable`. B proposes `@experimental`. C does not propose a default. Leaves an open question for 5C.1.

---

## 2. Comparative scorecard

Scoring 1-5 (5 best). Bold = winner on the dimension.

| Dimension | A (Minimalist) | B (Ergonomic) | C (Ecosystem) |
|---|---|---|---|
| **PRD compliance (F-1..F-14 depth)** | 4 | **5** | 4 |
| **Migration cost (own project + examples/)** | 3 | 2 | **4** |
| **Long-term maintainability (5D/E/F-friendly)** | **4** | 4 | 3 |
| **Consumer DX (install story, imports, errors)** | 3 | **5** | 4 |
| **Risk surface (decisions that could be wrong)** | 3 | 2 | **4** |
| **Defensibility vs future critic** | 3 | 3 | **4** |
| **TOTAL** | **20** | 21 | **23** |

### Commentary per dimension

**PRD compliance**: B wins narrowly — strongest on F-3 (CLI extract + bin strategy), F-6 (enum gives runtime value that PRD §F-6 measure "exhaustiveness" benefits from), F-13 (most rigorous codemod). A loses a point on F-6 (`ADAPTER_CUSTOM`'s `details.adapterCode: string` still open — same issue as B but B explicitly documents the escape). C loses a point on F-4 (architecture-checker split discussion good; but `./evolve-check` subpath expansion contravenes "F-1 shrink subpaths" spirit).

**Migration cost**: C wins because C keeps `harness-one` unscoped AND keeps ajv/tiktoken separate — no renames, no package merges. B's rename + enum cascade is the highest migration burden. A merges ajv/tiktoken which forces preset rewrites.

**Long-term maintainability**: A+B tie. A has fewest packages, simplest barrel. B has cleanest import paths. C's branded `ADAPTER_CUSTOM` object is a 5D/5E-unfriendly choice — logger pipelines everywhere have to stringify it; trust-types layer (5E) has to brand-preserve through `AuthContext → HarnessError.code.adapterCode`.

**Consumer DX**: B wins. Scoped-family install story is clearest. Enum `Object.values` introspection (for consumers who remember value-import) is the best runtime-UX. C is second — marquee unscoped + scoped siblings is familiar. A's 18-symbol barrel feels spartan.

**Risk surface**: C wins. Fewest novel decisions (no enum, no rename, no package merge, no `rm dist/infra`). A and B each have ≥2 moderate-probability wrong-decisions (A: native-deps merge, no-CJS devkit; B: rename + enum + tagged-object-adjacent escape).

**Defensibility**: C wins because its citations, although imperfect, span well-known SDKs. B's enum choice is defensible but fights 2024-era "enums are anti-pattern" opinion (some TS teams ban them outright). A's minimalism is defensible as a consistent stance but A-F-11 (native-deps merge contradicts A's own lockstep-logic) undermines internal consistency.

### Overall winner: **C** (23) by risk-surface + defensibility, with **B** (21) close behind on DX.

A's total 20 is not a fatal verdict — A wins on maintainability and has the cleanest barrel. But A's native-deps merge + no-CJS-devkit + `rm dist/infra` trio adds three places to be wrong, against the 1.0-rc "don't carry accidents for a year" bar.

---

## 3. Recommended hybrid

Cherry-pick the following, in priority order:

1. **From C**: keep `harness-one` unscoped (reject B's rename). Rationale: C-F-4 cost is lower than B-F-3 + B-F-4 compounded; the rename's SEO/family-branding value is speculative pre-1.0 per B-F-4. **Pair with a Wave-5G re-evaluation gate**: if after 6 months of 1.0 stable, consumer confusion is a real support ticket, re-open the rename as a 2.0 question with actual evidence.

2. **From B**: adopt the **enum** `HarnessErrorCode` pattern — **BUT** with C's prefix taxonomy and **WITHOUT** the object-member escape. Use A's `ADAPTER_CUSTOM` + `details.adapterCode: string` as the pragmatic escape. This closes the main union (type-level) while preserving consumer introspection. Mandate value-import (`import { HarnessErrorCode }`) in CONTRIBUTING.md with a lint rule flagging `import type { HarnessErrorCode }` for consumer code. **Accept** that `details.adapterCode` remains open; adapter packages document their sub-codes in their own READMEs.

3. **From A**: keep ajv + tiktoken **SEPARATE** (reject A's merge). C-F-2 + C-F-3 + A-F-3 + A-F-20 converge: the merge argument is fundamentally a maintainer-cost argument whose savings are small and whose cost is real (peer error-message quality, asymmetric peer stories). A's consistency argument (A-F-11) actually undercuts the merge itself.

4. **From A**: minimalist 18-symbol barrel but **re-add** `createResilientLoop` (B-F-6 / C-F-10 concur) and `createCostTracker` (Wave-5D friendly per A-F-14). Final target: **20 value symbols**.

5. **From C**: keep `architecture-checker` in `harness-one` (reject A's devkit move) at `harness-one/evolve-check` subpath. Mandate a runtime-import test proving no devDep leakage. This unblocks Wave-5A preset's potential future "verify architecture on boot" path.

6. **From A**: `rimraf dist/infra` post-build **PLUS** B's `files: ["dist/core", "dist/tools", ...]` narrowing, as **both** (belt and suspenders). Cost is one extra tsup config option + one extra CI assertion; closes the deep-dist vector at artifact AND packaging levels.

7. **From B**: atomic F-1 + F-3 + F-4 + F-13 landing is too large; sequence instead in **three PRs within 5C main body**: (i) F-2 + F-9 + F-5 + F-10, (ii) F-3 + F-4 + F-13 (examples migration), (iii) F-1 + F-6 + F-8 + F-12 + F-14. Each PR's api-extractor diff is reviewable.

8. **From C**: use `eslint-plugin-import`'s `no-internal-modules` for the `infra/` barrier. Install it as a root devDep. Readability > custom `no-restricted-imports` glob.

9. **5C.1 stability default**: adopt PRD critique §7 frontrunner **build-fail on untagged**, explicitly rejecting A's `@stable`-default AND B's `@experimental`-default. Build-fail forces the maintainer to make a deliberate stability decision per-symbol.

10. **Changeset mode**: `linked` (B+A) not `fixed` (C). `fixed` creates version theater on doc-only PRs (C-F-8); `linked` is the stricter-than-independent, looser-than-fixed regime that matches "1.0-rc: bump what moves".

### Hybrid net package count

`harness-one` + `@harness-one/cli` + `@harness-one/devkit` + `@harness-one/preset` + `@harness-one/openai` + `@harness-one/anthropic` + `@harness-one/redis` + `@harness-one/langfuse` + `@harness-one/opentelemetry` + `@harness-one/ajv` + `@harness-one/tiktoken` = **11 packages**, matching C's shape exactly.

---

## 4. Open ADR questions still un-answered after this critique

1. **9.f extension**: is `details.adapterCode: string` an acceptable open-sink? (All three proposals punt here in different ways.) If not, adapter packages need their own declared union types, and the main `HarnessErrorCode` must reference them — how?

2. **9.f implementation detail**: given the hybrid recommends a string enum with value-import mandate, the docs/CONTRIBUTING.md lint rule shape — is it a custom ESLint rule or `no-restricted-syntax`?

3. **9.a graduation**: under the hybrid's "keep `harness-one`", what are the **evidence-gathering criteria** for a later rename? (e.g., >N support tickets mentioning confusion, > Y% of new users install wrong package, etc.)

4. **architecture-checker runtime-purity test**: what specifically does the test check? No devDep imports? Deterministic output? No filesystem access in the checker path?

5. **5C.1 `@deprecated` + `@stable` coexistence**: when F-7 lands in 5C.1, does a `@deprecated @stable` combination need special treatment? (PRD critique §E-6 opened this; PRD v2 didn't fully close.)

6. **subpath count ceiling**: post-hybrid, `harness-one` has 12 subpaths (11 + `evolve-check`). PRD §9.k asks for the post-trim count — the hybrid's 12 exceeds A's 11 and matches C's 12; is 12 the new floor? Documentation required.

7. **F-14 graduation under "keep marquee" decision**: hybrid keeps `harness-one`, so F-14 is N/A per PRD LD-3 clause (iii). But should we publish a defensive **`@harness-one/core`** placeholder anyway to prevent future-confusion squat? Arbiter decide.

8. **templates.ts subpath test**: all three architects propose a subpath-resolvability test (A §8.2, B §8.4, C §8.4). Canonical location (`packages/cli/src/templates/__tests__/`) and canonical regex need to be fixed before implementation.

9. **Placeholder for `@harness-one/core` under "keep marquee"**: pure hygiene (reserve name) or a signal of future rename? If reserved-only, ADR must also reserve `@harness-one/{runtime,sdk,framework}` to prevent lateral squat.

10. **Linked-group composition**: hybrid picks `linked` + 11 packages. Every package patch triggers all 11 publish. Is `pnpm changeset publish` wall-clock (~45s × 11) acceptable on release PRs? A quantitative CI measurement is needed.

---

## Appendix: code-verified spot-checks

- **Architecture-checker exists at runtime**: `packages/core/src/evolve/architecture-checker.ts` confirmed via Grep (A's claim "not specified" FALSE). Re-exported from `packages/core/src/evolve/index.ts`.
- **HarnessErrorCode count 24**: `packages/core/src/core/errors.ts:31-55` confirmed 24 string-literal codes via direct Read.
- **Open sink `(string & {})`**: `errors.ts:71` confirmed `HarnessErrorCode | (string & {})`.
- **Existing package name**: `packages/core/package.json:2` = `"name": "harness-one"`, `:3` = `"version": "0.1.0"`.
- **Existing subpaths (14 total)**: `packages/core/package.json:6-82` — `.`, `./essentials`, `./core`, `./prompt`, `./context`, `./tools`, `./guardrails`, `./observe`, `./session`, `./memory`, `./eval`, `./evolve`, `./rag`, `./orchestration`, `./cli`. Count: 15 (including `.`). Removing cli/eval/evolve leaves 12 (not 11 as A claims — essentials is the 12th, which A+B+C all delete). Post-delete: 11. Matches.
- **`templates.ts` emits 12 subpaths**: verified from Read offset 1-80 showing `from 'harness-one/core'`, `'harness-one/prompt'`.
- **`enum HarnessErrorCode` + `import type` runtime loss**: TypeScript docs behavior confirmed (Enums at runtime; `verbatimModuleSyntax`).
- **`react` + `@types/react` publisher mismatch**: `@types/*` scope is DefinitelyTyped under Microsoft; `react` publisher is Facebook/react. Confirmed via standard npm metadata.

