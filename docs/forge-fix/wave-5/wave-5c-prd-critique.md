# Wave-5C PRD Critique (technical-skeptic)

**Reviewer**: technical-skeptic
**Date**: 2026-04-15
**Target**: `docs/forge-fix/wave-5/wave-5c-prd.md` (v1.0, product-advocate)
**Method**: every claim traced back to a file path + line range in the working tree at HEAD (`wave-5/production-grade`).

---

## 1. Verdict

**ACCEPT-WITH-PRD-EDITS**

The PRD is structurally sound and the goals (G-1..G-5) survive scrutiny. However, it rests on several **verifiably false or misleading** factual claims that, if left in place, will mislead the ADR authors and let the scope creep outside what the codebase actually demands. Edits are mandatory, not cosmetic. Four **new functional requirements** (F-12..F-15) are missing and are on the critical path.

The "2-3 weeks" estimate is **not defensible** at current scope — see Section 6.

---

## 2. Critical PRD edits (required before ADR hand-off)

### E-1 — "19 external importers of `_internal/`" is false. They are all intra-`packages/core/src`.

- **PRD claim** (§ 2.1, § 3 reality-check row 2, § 4 F-2): "19 files across `tools`, `observe`, `rag`, `session`, `memory`, `prompt`, `guardrails`, `context`, `orchestration` import from `_internal/`" — framed as "external importers" that must be migrated.
- **Evidence**: `grep -l "_internal" packages/` returns 21 files, of which 19 have `from '…_internal…'` imports. **All 19 live in `packages/core/src/`** (verified at `packages/core/src/tools/registry.ts`, `…/observe/trace-manager.ts`, `…/context/compress.ts`, etc.). The only non-`packages/core/` hits are `packages/langfuse/src/index.ts` (a *comment* at line 30-38 mirroring `_internal/redact.ts` constants — it does **not** import from `_internal/`) and `packages/core/src/orchestration/handoff.ts:150` (a comment, not an import). Confirmed by `rg "from ['\"].*\.\./\.\./\.\./_internal|from ['\"]harness-one/_internal"` returning zero hits.
- **Why this matters**: F-2's ESLint rule permits intra-package imports. If all 19 importers are already intra-`packages/core/`, then **no migration is required for F-2 beyond renaming `_internal/` → `infra/` and adding the lint rule**. The PRD currently frames F-2 as a large cross-package refactor; it is actually a mechanical `sed` + ESLint rule. This flips F-2 from "multi-day" to "hour-scale" work.
- **Required edit**: § 2.1 bullet 3, § 3 row 2, and § 4 F-2 measure must say "**19 intra-package importers in `packages/core/src/`** — no cross-package surgery required. The lint rule's job is to *prevent future* external reach-in, not to clean up existing ones." Remove the implication that `packages/openai/`, `packages/anthropic/`, or `packages/preset/` are affected.

### E-2 — `HarnessErrorCode` declares **24**, not 25. The (string & {}) escape is documented, not accidental.

- **PRD claim** (§ 2.1, § 3 row 3): "25 declared codes; 27 raw-string code literals".
- **Evidence**: `packages/core/src/core/errors.ts:31-55` declares **24** string-literal codes (counted: UNKNOWN, INVALID_CONFIG, INVALID_STATE, INTERNAL_ERROR, CLI_PARSE_ERROR, MEMORY_CORRUPT, STORE_CORRUPTION, MAX_ITERATIONS, ABORTED, GUARDRAIL_BLOCKED, GUARDRAIL_VIOLATION, INVALID_PIPELINE, ADAPTER_INVALID_EXTRA, TOOL_VALIDATION, INVALID_TOOL_SCHEMA, TOOL_CAPABILITY_DENIED, TOKEN_BUDGET_EXCEEDED, SESSION_NOT_FOUND, SESSION_LIMIT, SESSION_LOCKED, SESSION_EXPIRED, TRACE_NOT_FOUND, SPAN_NOT_FOUND, PROVIDER_REGISTRY_SEALED). Further, `packages/core/src/core/errors.ts:68-71` has an explicit comment justifying `(string & {})` — "accepts any string for forward compatibility, but callers are encouraged to use values from HarnessErrorCode". The union is **deliberately open for third-party subclasses**, per the comment. F-6 must acknowledge this and define the third-party migration.
- **Required edit**: correct the count to 24. Section 9.f MUST include an ADR question: "What do third-party error subclasses in `@harness-one/anthropic`, `@harness-one/openai`, `@harness-one/redis` do for codes? Do they get an `ADAPTER_CUSTOM` generic slot, or do they extend the union?" The grep count of `throw new HarnessError*` is **152 across 47 files** (PRD says 130/42) — the underestimate understates the mechanical migration F-6 implies.

### E-3 — `packages/full/` is not "abandoned" — it has a live `node_modules/` and a populated `dist/`.

- **PRD claim** (§ 3 row 7, F-5 measure, B-11): "`packages/full/` has a `dist/` but NO `package.json`, NO `src/` — it is an abandoned build artifact. Delete it."
- **Evidence**: `ls packages/full/` shows `dist/` + `node_modules/` (with `@harness-one` + `harness-one` + `tsup` + `typescript` + `vitest` installed). No `package.json` confirmed, no `src/` confirmed. But the presence of a populated `node_modules/` suggests it was installed from a prior `package.json` at some point — either the `package.json` was **deleted in-flight without cleaning up**, or the `dist/` was copied from elsewhere. `grep -r packages/full` in the tree (excluding .md) returns zero references. It IS safe to delete, but call the state accurately.
- **Required edit**: § 3 row 7: "`packages/full/` has no `package.json` and no `src/` at HEAD, but retains a `dist/` and a `node_modules/`. It is referenced nowhere in the workspace (pnpm-workspace.yaml matches `packages/*` but pnpm skips entries without `package.json`). Safe to remove. B-11 stands." Also add a task: "verify no CI job references `packages/full`" before deletion.

### E-4 — `packages/core/src/cli/templates.ts` already imports from `'harness-one/core'` — the CLI is **not** free-standing.

- **PRD claim** (§ 6 F-3): "Move `packages/core/src/cli/*` into `packages/cli/` … the measure is: `harness-one`'s own test/lint does not import from `cli/`."
- **Evidence**: `packages/core/src/cli/templates.ts:15` emits string templates that say `import type { AgentAdapter, Message } from 'harness-one/core';` — the templates themselves reference subpath exports of `harness-one`. Similarly at line 100 and line 511 (`harness-one/rag`). This means **after F-3, `@harness-one/cli` has a runtime/dependency on `harness-one` (or at minimum its subpath exports must survive the F-1 barrel narrowing)**. PRD does not enumerate which subpaths the CLI-emitted templates need, and F-1 might trim them.
- **Required edit**: § 6 F-3 must add a measure: "The CLI-generated templates' import specifiers (`harness-one/core`, `harness-one/rag`, and any others enumerated in `cli/templates.ts`) must all survive the F-1 barrel narrowing. A test parses `templates.ts` at build time, extracts every `from 'harness-one/*'`, and asserts each subpath resolves to a real export in the post-trim `harness-one/package.json`." Also: cli's `package.json` must declare `harness-one` as a `dependency` (not just peer) because the scaffolded code assumes the consumer installs `harness-one`.

### E-5 — PRD's F-3 measure is self-contradictory (and the PRD says so in-line).

- **PRD claim** (§ 6 F-3 measure, line: "Running `pnpm dlx @harness-one/cli --help` works in a scratch project that does not install `harness-one` transitively… **(correction)**… actually it will install `harness-one` because the CLI depends on it.").
- **Evidence**: the PRD author caught this mid-sentence but left the contradiction in the document.
- **Required edit**: delete the crossed-out measure entirely; keep only "`harness-one`'s own test/lint does not import from `cli/`" as the F-3 measure. Add a separate measure: "`@harness-one/cli` declares `harness-one` as a *regular dependency* (not `peerDependency`) so `pnpm dlx` resolves it automatically."

### E-6 — Stability-tag policy for `@deprecated` is ambiguous. Five `@deprecated` tags already exist and PRD ignores them.

- **PRD claim** (§ 3 row 5): "**Zero** `@experimental`/`@alpha`/`@beta`/`@stable` annotations in `packages/`. Starting from zero."
- **Evidence**: `grep -c "@stable|@beta|@alpha|@experimental"` returns **0**, confirming the narrow claim. But `grep "@deprecated"` returns 7 pre-existing tags in `packages/preset/src/index.ts` (eventBus), `packages/core/src/core/event-bus.ts` (the real bus), and `packages/core/src/core/index.ts`. F-7 says every symbol "carries exactly one of: @stable / @beta / @alpha / @experimental / @deprecated". So pre-existing `@deprecated` tags count — but what happens to symbols that are `@deprecated` **and** should also signal their previous stability (e.g., "this was @stable, now @deprecated, removed in 0.5")?
- **Required edit**: § 6 F-7 must state: "A symbol carries a stability tag from {@stable, @beta, @alpha, @experimental} **and optionally** also @deprecated with a removal-version string. The `eventBus` field (F-9) is deleted outright in this wave, so it has no tag requirement post-landing." Section 9.g must add: "deprecated items that are scheduled for removal in this wave do not need a new stability tag."

### E-7 — api-extractor override path (PD-3) needs scope + reviewer-gate spec.

- **PRD claim** (§ 0 PD-3, § 6 F-8): `pnpm api:update` regenerates `*.api.md`; committing it unblocks merge.
- **Evidence**: nothing in the PRD says **who** decides "yes, this API break is intentional". If a contributor can regenerate + commit + self-approve, PD-3 is ornamental. The PRD mentions "human reviewer now has one file showing every API delta" but does not specify a CODEOWNERS gate, a required second approver, or a minimum diff-age.
- **Required edit**: § 6 F-8 measure adds: "Every `*.api.md` diff requires a CODEOWNERS approval from `@harness-one/api-stewards` (a new GH team to create). The CI check for `*.api.md` drift is separate from the merge gate; the merge gate requires both checks green AND CODEOWNERS sign-off." Also: "The override command is `pnpm api:update`; its output must be pure (no timestamps, no machine-specific paths) so diffs are reviewable."

### E-8 — F-1 "25 symbols" without list is not measurable. Barrel re-export aliases must be counted.

- **PRD claim** (§ 6 F-1): "≤ 25 exported names (counted by api-extractor)".
- **Evidence**: `packages/core/src/index.ts` currently has **21 `export` statements** totaling ~**90 named symbols** (value exports + type exports). Walking § 12-2 of the PRD ("7 families × 3-4 symbols each"): AgentLoop/createAgentLoop (2) + HarnessError + 3 subclasses (4) + defineTool/createRegistry (2) + createTraceManager/createLogger (2) + createSessionManager (1) + createPipeline (1) + createMiddlewareChain (1) = **13 value symbols** — which **does not leave room for type aliases** like `Message`, `ToolCall`, `AgentEvent`, `ChatParams`, `Role`, `Guardrail`, `Session`, `MemoryEntry`, `Trace`, `Span`, `AgentAdapter`, `AgentLoopConfig`, `TokenUsage` — all of which today's consumers (including the CLI's emitted templates!) reach via the root or subpath. If types count, 25 is **too tight**. If types do not count, the PRD must say so and the `.api.md` output must reflect a types-excluded convention.
- **Required edit**: § 6 F-1 must (a) specify whether types count toward the 25, (b) list the **candidate 25** by name in the PRD (as an appendix), and (c) promote the "one-line justification" requirement from "nice to have" to "blocks merge". Without a concrete list, three architect candidates will produce three incompatible designs and design-arbiter has nothing to arbitrate.

---

## 3. Verified claims (confirmed against HEAD)

- ✅ `packages/core/src/cli/templates.ts` = **651 LOC** exactly. (`wc -l`)
- ✅ `packages/core/src/index.ts` = 216 lines, 21 `export` statements, ~90 named symbols. (manual count matches PRD.)
- ✅ `@harness-one/ajv` and `@harness-one/tiktoken` each have a single `src/index.ts` with no sibling `.ts` files (both have `__tests__/` subdirs only).
- ✅ `packages/preset/src/index.ts:170-230` + `:370-410` — `eventBus` is a `Proxy` that warns on first access and throws `HarnessError('DEPRECATED_EVENT_BUS', …)` on any method call. F-9 deletion target verified.
- ✅ Zero `@stable`/`@beta`/`@alpha`/`@experimental` tags in `packages/`. (Only `@deprecated` present, 7 occurrences.)
- ✅ `packages/core/src/evolve/*` imports only from `../core/errors.js` — no cross-deps with `eval/` or `cli/`. F-4 extraction is technically clean; no circular risk.
- ✅ `packages/core/src/eval/*` imports only from `../core/errors.js`. No dep on `evolve/` or `cli/`. F-4 clean.
- ✅ `declarationMap: true` is set in `tsconfig.base.json:13`. api-extractor will get `.d.ts.map` for free.

---

## 4. Disputed claims (evidence differs from PRD)

- ❌ PRD § 3 row 2: "19 external importers of `_internal/`" — **all 19 are intra-`packages/core/`**. (See E-1.)
- ❌ PRD § 2.1 bullet 3: "A reckless consumer can depend on `packages/core/src/_internal/lru-cache.ts` today" — **actually** they can only reach `harness-one/dist/_internal/lru-cache.js` **if** it ends up in the `files` field of `package.json` **and** tsup emits it. `files: ["dist"]` is broad enough to ship `_internal/` artifacts. Separate but real concern: verify whether `tsup` bundles `_internal/` into subpath entries or ships it as standalone files. The `exports` map does NOT expose `./infra` or `./_internal`, so today reach-in requires **dist-relative deep import**, which is non-standard. The PRD should distinguish "reachable via TS imports" (no, today) from "reachable via deep path" (yes, but lint can't catch this — only the `exports` map gate can). F-2's lint rule does nothing for the deep-path vector.
- ❌ PRD § 3 row 3: "27 raw-string throws" — my grep returns **152 total `throw new HarnessError*` occurrences across 47 files**. Separating "uses a declared code" vs "uses a raw literal not in the union" requires semantic scan (not regex). The 27 may be correct; I could not verify the breakdown without parsing.
- ❌ PRD § 2.3 security bullet: "CVE in `cli/templates.ts` becomes a CVE in the prod runtime". `cli/templates.ts` contains **string constants** (verified — it's 651 LOC of template source code). No executable parsing. The attack-surface argument is weaker than stated. (It is still a bundle-size argument — valid — but not a CVE argument.)
- ❌ PRD § 3 (baseline LOC): "65,299 LOC" vs "19,842 LOC pre-Wave-5B". I did not verify this number. The magnitude does not change the argument.

---

## 5. New functional requirements PRD missed (F-12..F-15)

### F-12 — Workspace dependency consistency between packages

- **Priority**: P0 (release blocker)
- **Ask**: Every `@harness-one/*` package that imports from `harness-one` (today: `ajv`, `tiktoken`, `anthropic`, `openai`, `langfuse`, `opentelemetry`, `redis`, `preset`, and the new `cli` + `devkit`) must declare `harness-one` (or `@harness-one/core` if 9.a picks rename) in `dependencies` or `peerDependencies` with a consistent version range. A CI script enumerates `import 'harness-one` vs `package.json` deps and fails on mismatch.
- **Measure**: CI script passes; any package that `import`s from `harness-one` without declaring the dep fails the `pnpm -r build` topo check.

### F-13 — Examples directory import audit

- **Priority**: P0 (documentation-correctness blocker)
- **Ask**: The `examples/` directory (20 files, 52 `from 'harness-one*'` occurrences, including `from 'harness-one/eval'` at `examples/full-stack-demo.ts:15,20` and `examples/eval/llm-judge-scorer.ts:8,119`) must be migrated in lockstep with F-4 (devkit extraction) and F-1 (barrel trim). Either update every example to the new import paths or delete the examples the PRD makes obsolete. Every example must typecheck in CI.
- **Measure**: `pnpm -C examples typecheck` is green post-landing. No example imports `harness-one/eval` or `harness-one/evolve` after F-4.

### F-14 — Publish-config safety (`harness-one` deprecation entry, npm-scope reservation)

- **Priority**: P0 (release blocker — ties to PD-1)
- **Ask**: Before 1.0-rc goes public:
  - (i) The name `harness-one` on npm must either be claimed (publish 1.0.0 first-party) or reserved (publish a placeholder 1.0.0-rc.0 under our org). Otherwise squatter risk.
  - (ii) If 9.a picks rename to `@harness-one/core`, the `harness-one` name's 1.0 entry must include a `"deprecated"` field pointing at `@harness-one/core` with a migration link. Otherwise existing `0.x` installers get a silent rug-pull.
  - (iii) Every new `@harness-one/*` package (`cli`, `devkit`, and an implicit one if `full/` is revived) needs its npm name reserved under the scope owner before any 1.0-rc publish.
- **Measure**: a publish-dry-run checklist in `CONTRIBUTING.md` with tick-box items for each of (i)/(ii)/(iii); CI runs `pnpm publish --dry-run -r` against 1.0-rc and asserts no naming collisions.

### F-15 — CHANGELOG migration codemod bundle

- **Priority**: P1 (UX for 0.x→1.0-rc upgraders, even if "no known external consumers", the monorepo's own `examples/` + `packages/preset` are consumers)
- **Ask**: Every breaking-change row in Section 8 with "Codemod? Yes" must ship an executable codemod (jscodeshift or tsmod) shipped in `@harness-one/devkit/codemods/wave-5c-*` and documented in the CHANGELOG. The wave-5C CHANGELOG entry lists each codemod with a one-line invocation example.
- **Measure**: `pnpm dlx @harness-one/devkit codemod wave-5c` transforms a seed fixture project from 0.4.x import paths to 1.0-rc import paths with zero manual edits.

---

## 6. Estimate challenge — "2-3 weeks" is NOT defensible

### 6.1 Critical path (sequential, not parallel)

The brief says "6 implementers parallel"; PRD keeps the optimism. Sequential gates below:

1. **ADR decisions (9.a..9.i)** — these are *inputs* to F-1, F-2, F-6, F-7, F-11. 9 open questions × solution-architect×3 × design-arbiter ≈ **3-5 days** before any implementer starts.
2. **F-3 (cli extract) + F-4 (devkit extract)** — partially parallel, but both must land *before* F-1 (barrel trim), because the barrel's surviving 25 symbols is a function of what stays in `harness-one`. Sequential with F-1.
3. **F-1 (barrel trim)** — must land before F-7 (stability tags), because you tag symbols in their final home. Sequential.
4. **F-7 (stability tags on every public export)** — tagging ≈ 90 root symbols + ~200 subpath symbols + cross-package exports. Even at 1 tag/2min, that's **~10-12h** of careful judgment work per human. Need at least one pair review per tag. Parallelizable across humans but not automatable.
5. **F-6 (HarnessErrorCode closure)** — 152 throw sites across 47 files. Cannot parallelize beyond ~4-5 humans without merge-conflict thrashing. At 10min/site (read code, pick code, update taxonomy if needed), ≈ **25h wall-clock for one pair; 6-8h with 4 parallel pairs**.
6. **F-8 (api-extractor CI gate)** — installing, configuring, running baseline, committing `*.api.md` for **every** package (core + 7 existing + 2 new = 10 packages), wiring CI, writing override docs. **2-3 days** solo.
7. **F-11 (doc-drift CI)** — 9.h undecided; implementation cannot start until ADR picks. Then **1-2 days** of CI work per chosen shape.

### 6.2 Realistic estimate

- **Week 1**: ADR (9.a..9.i) + F-2 rename + F-9 eventBus deletion + F-5 ajv/tiktoken decision.
- **Week 2**: F-3 + F-4 (package extractions, parallel) + F-12 (workspace consistency) + F-13 (examples migration).
- **Week 3**: F-1 (barrel trim) + F-7 (stability tags) + F-6 (error-code closure).
- **Week 4**: F-8 (api-extractor strict gate) + F-11 (doc-drift) + F-10 (templates split) + F-14 (publish safety) + F-15 (codemods).
- **Week 5 buffer**: review synthesis, acceptance, doc-updater, changeset.

**Realistic estimate: 4-5 weeks**, not 2-3. The PRD's estimate is achievable only if (a) we skip F-12/F-13/F-14/F-15 (loss-of-quality path), or (b) we defer F-7 (stability tags) to a follow-up wave (breaks the 1.0-rc quality story — an untagged 1.0 surface is not a 1.0 surface).

**Recommendation to lead**: either extend the estimate to 4-5 weeks or split F-7/F-11 into a Wave-5C.1 follow-up PR inside the wave-5 branch.

---

## 7. Open questions for ADR phase (additions to § 9)

- **9.j (new)** — `harness-one/essentials.ts` fate: the PRD's NG-5 defers; make this a §9 decision instead. If `essentials.ts` mirrors the root barrel ±5 symbols, deleting it is trivial. If it is a separately-curated "starter" surface, the ADR must state which symbols are there and why.
- **9.k (new)** — Which subpath exports in `harness-one/package.json` survive? Today there are 14 subpaths. F-3 drops `./cli`. F-4 drops `./eval` + `./evolve`. That leaves 11. F-1 might force more (e.g., `./rag` may merge into `./context`). The ADR must emit the post-trim `exports` map as an artifact.
- **9.l (new)** — CODEOWNERS for `*.api.md` files. Who has sign-off authority? Proposed: create a `@harness-one/api-stewards` team; minimum 2 members; PR cannot land without 1 approval from that team when `*.api.md` changes.
- **9.m (new)** — `packages/full/` deletion vs resurrection (PRD § 9.b). Make this binary. If resurrect, F-5 measure changes (no longer "delete orphaned dist/").
- **Sharpen 9.g** (stability-tag default): PRD frames as build-fail vs default-@stable. I side with **build-fail** — a 1.0-rc that silently assumes @stable for every un-annotated symbol defeats the entire F-7 purpose. The contributor friction PRD worries about (§ 9.g) is ≤ 2 minutes per symbol; the cost of an accidentally-locked-in half-baked API is a full major version. Choose build-fail.
- **Sharpen 9.f** (`HarnessErrorCode` closure): prefer **template-literal union** (`${Module}_${Suffix}`) over bare string-literal union. It preserves namespace hygiene (adapters cannot define `FOO` that collides with `FOO` somewhere else; they must use `ADAPTER_FOO`), and it composes with the `ADAPTER_CUSTOM` + `details.adapterCode` escape hatch the PRD already proposed in § 12-8.

---

## 8. Summary (250 words)

**Verdict**: ACCEPT-WITH-PRD-EDITS. The PRD's goals survive scrutiny; its facts do not, and its estimate is optimistic.

**Top 3 critical edits**:
1. **E-1**: The "19 external importers of `_internal/`" claim is false. All 19 are intra-`packages/core/`. No cross-package surgery for F-2 — it is a `sed` rename plus a lint rule. Fix § 2.1 / § 3 / § 4 F-2 accordingly.
2. **E-4**: `packages/core/src/cli/templates.ts` emits code that imports from `harness-one/core` and `harness-one/rag` — meaning the F-1 barrel trim must preserve every subpath the CLI-emitted templates reach, or else F-3 ships broken scaffolds. Add a build-time test that parses templates.ts and validates every embedded `from 'harness-one/*'`.
3. **E-8**: F-1 "≤25 symbols" is unmeasurable without a concrete candidate list. Three architect candidates will diverge if PRD does not name the ≤25 or declare the types-counting convention. Require a named appendix.

**Top 2 new requirements added**:
- **F-13**: Examples directory migration (20 files, 52 `harness-one*` imports, including `harness-one/eval`) is a P0 blocker for F-4; PRD omits it entirely.
- **F-14**: Publish-config safety (npm name reservation, `harness-one` deprecation entry if 9.a picks rename) — without this, 1.0-rc is a squatter-risk and silent-rug-pull candidate.

**Estimate verdict**: "2-3 weeks" is **not defensible**. Sequential gates (ADR → F-3/F-4 → F-1 → F-7 → F-8) plus the missing F-12..F-15 work push realistic wall-clock to **4-5 weeks**. Recommend extending or splitting F-7/F-11 to a Wave-5C.1 follow-up.
