# Wave-5C Risk Assessment Report

**Plan Version**: wave-5c-task-plan.md (2026-04-15)
**Assessor**: risk-assessor
**Assessed At**: 2026-04-15
**Overall Risk Level**: **MEDIUM-HIGH** → PROCEED-WITH-MITIGATIONS

---

## Executive Summary

**Total Risks**: 18 (5 HIGH, 9 MEDIUM, 4 LOW)
**Blocking**: 3 (circular barrel re-export, npm publish credentials, T-1.1 acceptance-criteria under-count)
**Advisory**: 15

Three of the 8 planner-flagged gaps are true blockers that must be resolved before implementation begins; four can be deferred safely.

---

## 1. Top Risks Ranked

| ID | Dim | Likelihood × Impact = Severity | Evidence | Mitigation | Owner |
|---|---|---|---|---|---|
| **R-01** | INT | High × High = **HIGH** | ADR §5.1 slot 19 re-exports `createSecurePreset` from `@harness-one/preset`; `packages/preset/package.json:26` declares `"harness-one": "workspace:*"`. Cycle: `harness-one/index` → `@harness-one/preset` → `harness-one/core`. ESM evaluation works lazily but tsup bundler + api-extractor frequently choke. Planner flagged as Gap #6. | RESOLVE NOW: inline-wrapper in `packages/core/src/preset-bridge.ts` that dynamically imports `@harness-one/preset` **or** drop slot 19 — make `createSecurePreset` a subpath-only export (`@harness-one/preset` direct). Preferred: drop slot 19, add README 1-liner. Saves 30 LOC of wrapper + removes cycle risk entirely. | team-lead → T-3.1 |
| **R-02** | TECH | Med × High = **HIGH** | Plan T-3.2 claims "152 throw sites / 47 files"; actual Grep across repo: `throw new HarnessError\|throw new MaxIterationsError\|...` matches hundreds. Also enum member renames (UNKNOWN→CORE_UNKNOWN etc.) **break every adapter subclass** that passes a bare string as 2nd arg (e.g., `MaxIterationsError` line 95 in `packages/core/src/core/errors.ts` passes `'MAX_ITERATIONS'` literal). Codemod must sweep error-class internals too, not just throw sites. | Pre-flight: `tools/codemods/prefix-error-codes.ts` must include the error-class `super()` calls. Add negative test: `grep "'UNKNOWN'\|'MAX_ITERATIONS'\|..."` across src returns 0 hits. Also add a literal-union grep sweep of `catch`/`switch`/`err.code === 'X'` across ecosystem packages (openai, anthropic, redis, langfuse, preset) — planner's T-3.2k list looks thin at ~5 files. | T-3.2 owner + acceptance-reviewer |
| **R-03** | DEP | High × Med = **HIGH** | T-1.1 acceptance lists only 3 files in `_internal/` (`async-lock.ts`, `lru-cache.ts`, `disposable.ts`). Actual contents: **9 files** (`json-schema.ts`, `redact.ts`, `token-estimator.ts`, `async-lock.ts`, `disposable.ts`, `ids.ts`, `lazy-async.ts`, `lru-cache.ts`, `safe-log.ts`). `git mv` will still work, but the acceptance check is under-specified — reviewer may miss that `token-estimator.ts` / `redact.ts` did not move. | Update T-1.1 acceptance criterion 3: "`packages/core/src/infra/` contains all 9 files previously in `_internal/`". Add a `find packages/core/src/infra -type f \| wc -l` check = 9. | T-1.1 owner |
| **R-04** | SEC | Med × High = **HIGH** | T-3.4 publishes 4 real npm packages under `@harness-one/*` scope but plan has no statement about org ownership, 2FA enforcement, automation-token scope, or provenance (`npm publish --provenance`). Gap #4 + #7 acknowledge this but leave unresolved. Supply-chain attack vector: if token is lifted, attacker publishes `@harness-one/core@1.0.0` with malware; existing `harness-one` users running `pnpm add @harness-one/core` (typo) pull it. | BLOCK until team-lead confirms: (a) org admin identity; (b) 2FA-enforced automation token stored in `NPM_TOKEN` secret; (c) placeholder publish uses `--provenance` + `--access public`; (d) `publishConfig.access: "public"` in each placeholder package.json. | team-lead (before T-3.4) |
| **R-05** | INT | Med × High = **HIGH** | `examples/` has **no `package.json` and no `tsconfig.json`** at HEAD (verified via Glob). T-2.12 assumes `pnpm -C examples typecheck` works after migration; T-2.13 wires it to CI. But the package must first be **created** — this is not a pre-existing target. Task plan does not call out bootstrapping `examples/package.json` + `examples/tsconfig.json`. F-13 acceptance is an F-4 blocker — if examples doesn't typecheck at ALL today, we cannot "verify" migration preserves green. | Add pre-task `T-2.11b` (or fold into T-2.12): scaffold `examples/package.json` + `examples/tsconfig.json` + run baseline `pnpm -C examples typecheck` on HEAD **before** the migration diff. Capture the baseline error-count (likely 0 because they're just `.ts` files with external imports; but we must confirm). | T-2.12 owner |
| R-06 | EST | Med × Med = MEDIUM | PR-2 critical path "18-20h ≈ 2-3 days" underestimates T-2.6 (L, 8h). Moving `eval/**` + 5 `evolve/*` files + rewriting imports across ~25 source files + 5 test files is closer to 12h. N=4 team hides this because devkit chain is a single-owner chain. | Re-estimate T-2.6 as XL (~12h) OR split into T-2.6a (`eval/**` move) + T-2.6b (`evolve/*` non-arch-checker move). | task-planner |
| R-07 | DEP | Med × Med = MEDIUM | T-2.6 acceptance says "`packages/core/src/evolve/` contains ONLY `architecture-checker.ts`" — but `packages/core/src/evolve/index.ts` currently re-exports `createComponentRegistry` (`packages/core/src/index.ts:211`). After T-2.6 moves it to devkit, `core/src/index.ts:211` becomes a dangling import. Not caught until T-2.9 or T-3.1. | Add T-2.6 acceptance: "`packages/core/src/index.ts` dangling re-exports from `./evolve/index.js` removed or re-pointed; `pnpm -C packages/core typecheck` green". | T-2.6 owner |
| R-08 | INT | Med × Med = MEDIUM | `@harness-one/tiktoken` is in preset's **`optionalDependencies`** (`packages/preset/package.json:35`), NOT `dependencies`. Plan T-1.8 `verify-deps.ts` scope lists tiktoken as in-scope, but the verifier must also check `optionalDependencies` — if it only checks `dependencies`/`peerDependencies` it will false-fail (or worse, false-pass because tiktoken is optional at runtime). ADR §4 table shows tiktoken as peer — mismatch with actual. | T-1.8 must inspect the three fields (`dependencies`, `peerDependencies`, `optionalDependencies`). Clarify ADR §4 intent for tiktoken (optional vs peer vs regular). | T-1.8 owner + team-lead |
| R-09 | INT | Low × High = MEDIUM | At npm publish (Wave-5G, not 5C) `workspace:*` must resolve to real versions. Changesets handles this, but PR-2 introduces `@harness-one/cli` and `@harness-one/devkit` as new workspace packages — their first real publish (future) will need special treatment (initial `1.0.0-rc.1` bumped via lockstep). Planner's T-2.15 says "minor/initial" but linked lockstep forces MAJOR — internal contradiction. | Clarify T-2.15: since PR-1 bumped everyone to major (eventBus delete + enum), PR-2 adds new packages AT the prevailing major. `@harness-one/cli@1.0.0-rc.X` and `@harness-one/devkit@1.0.0-rc.X` initial, NOT 0.x. | T-2.15 owner |
| R-10 | TECH | Low × High = MEDIUM | T-2.14 `rm dist/infra` risks breaking source-map step-into (critic A-F-2 + A-F-6). Plan has a fallback but fallback path (drop `rm`, keep `files` narrowing) is only tested *after* failure. | Run source-map test FIRST on current HEAD as a dry-run fixture before committing `tsup.config.ts` change. If HEAD already satisfies `files`-narrowing with `dist/infra` absent from tarball via `files` alone, consider skipping `rm dist/infra` entirely. | T-2.14 owner |
| R-11 | SEC | Low × High = MEDIUM | Wave-5A `createSecurePreset` fail-closed invariants are unit-tested in `packages/preset/src/__tests__/secure-preset.test.ts`. Slot 19 re-export (R-01) or the preset rename to subpath-only needs a smoke test proving `createSecurePreset` still runs fail-closed after the shuffle. | T-3.1 must add regression test: `import { createSecurePreset } from 'harness-one'` → existing Wave-5A suite re-runs and passes. | T-3.1 owner |
| R-12 | INT | Med × Med = MEDIUM | Plan T-1.10 commits 10 api-extractor snapshots in baseline mode but does not gate against **currently-leaking `dist/infra` symbols** (T-2.14 fixes later). The baseline snapshot will capture `dist/infra`-sourced types; PR-2 will then show unrelated-looking diffs when narrowing fires. Reviewer noise. | T-1.10 acceptance should grep snapshots for `infra/` references. If found, T-1.10 notes "expected diff in PR-2 T-2.14". | T-1.10 owner |
| R-13 | EST | Med × Low = LOW | PR-1 critical path assumes T-1.9 (M, 6h) happens after T-1.2; but T-1.9 installs api-extractor devDep → root `package.json` SHARED with T-1.3/T-1.8 (planner flagged R-1.A). The recommended T-1.0 extraction is a 30-min task that planner listed but did not number — add it. | Add T-1.0 explicitly (~30min, adds `eslint-plugin-import`, `@microsoft/api-extractor`, `verify:deps`/`api:update` scripts). Make T-1.3/T-1.8/T-1.9 depend on T-1.0. | task-planner |
| R-14 | DEP | Low × Med = LOW | T-2.9 removes `./cli`, `./eval`, `./evolve` from exports. Any `README.md`, `docs/architecture/*.md`, or `examples/README.md` that references these subpaths in prose becomes stale. Grep shows `examples/README.md:54` references `harness-one/eval`. | T-2.12 should sweep docs prose too: `grep -rn "harness-one/eval\|harness-one/evolve\|harness-one/cli" docs/ README.md examples/README.md`. | T-2.12 owner |
| R-15 | TECH | Low × Med = LOW | ADR §3.c keeps ajv/tiktoken separate — Gap #8 asks if a task is needed. Correct answer: **no task**, because state already matches decision. But the verify-deps script in T-1.8 should include a "merge-guard" smoke: assert `packages/ajv/` and `packages/tiktoken/` both exist as separate dirs with their own `package.json`. | Add T-1.8 acceptance line: "test: `packages/ajv/package.json` AND `packages/tiktoken/package.json` exist (merge-guard per ADR §3.c)". | T-1.8 owner |
| R-16 | SEC | Low × Med = LOW | No secrets in new CI workflows confirmed, but T-3.5 `check-api-rationale.ts` reads `GITHUB_EVENT_PATH` — ensure it doesn't echo PR body content (which might include secrets) into CI logs. | Code review T-3.5 for no `console.log(prBody)`. | T-3.5 owner |
| R-17 | EST | Low × Low = LOW | PR-1 DAG shows T-1.9 appearing twice (lines 242 and 248 of plan). Visual bug only; doesn't affect execution. | Editorial fix in plan. | task-planner |
| R-18 | TECH | Low × Low = LOW | Windows CI matrix in `.github/workflows/ci.yml` (`os: [ubuntu-latest, macos-latest, windows-latest]`). `git mv` in T-1.1 and path-separator handling in `tools/verify-deps.ts` (T-1.8) must work on Windows. Current verify-deps.ts doesn't exist yet; write it path.sep-aware. | T-1.8 acceptance: "uses `path.posix.sep` or Node `path.sep` consistently; CI passes on windows-latest". | T-1.8 owner |

---

## 2. Gap Arbitrations (8 gaps × 3-option matrix)

| # | Gap | Verdict | Rationale |
|---|---|---|---|
| 1 | PR-1 vs PR-2 placement of `templates.ts` split | **DEFER TO IMPLEMENTATION (ADR wins)** | Plan correctly honors ADR §3.l (PR-2 because `packages/cli/` is created in PR-2). No functional impact. Close. |
| 2 | `essentials.ts` delete placement (PR-1 vs PR-3) | **DEFER TO IMPLEMENTATION (ADR wins)** | Same: ADR §7 PR-1 step 5 is authoritative. T-1.7 is correctly placed. |
| 3 | F-6 two-step enum flip (PR-1 interim + PR-3 rename) vs single-shot in PR-3 | **PUSH TO ARBITER/LEAD** | Two-step adds complexity but isolates risk (PR-1 value-equivalence lets us measure adapter-package breakage separately from rename codemod). Single-shot concentrates review effort but bigger blast radius. Non-reversible choice — lead calls. Recommend sticking with two-step. |
| 4 | T-3.4 npm publish credentials | **PUSH TO ARBITER/LEAD (BLOCKING)** | R-04 HIGH. Lead must name org admin + token owner + 2FA policy BEFORE T-3.4 starts. Non-negotiable. |
| 5 | ESLint rule packaging (internal-only vs shippable plugin) | **RESOLVE NOW: internal-only** | 5C main scope is the monorepo; shipping `eslint-plugin-harness-one` as a public package is out of scope (NG-2) and compounds Wave-5G release planning. Defer to a later wave if consumer demand appears. Mark T-3.3 as internal. |
| 6 | `createSecurePreset` barrel-slot-19 circular import | **RESOLVE NOW: drop slot 19** | See R-01 HIGH. Preferred fix: expose only via `@harness-one/preset` import path; remove from root barrel. Saves cycle risk + wrapper LOC. 5.1 slot count becomes 19 value symbols (still ≤ 25 ceiling, even better headroom). Update CHANGELOG rename-mapping. |
| 7 | F-14 placeholder 2FA / automation-token | **PUSH TO ARBITER/LEAD (BLOCKING)** | Same as gap #4 — conflated. One answer covers both. |
| 8 | ADR §3.c ajv/tiktoken keep-separate = no task needed | **RESOLVE NOW: confirmed no-op + add guard** | See R-15. No code change. Add one-line guard to T-1.8 verify-deps (merge-guard assertion) so we don't silently regress. |

---

## 3. Tasks that MUST be re-scoped

1. **T-1.1** — acceptance file-count wrong (3 → 9). Not a re-scope, but an acceptance-criterion fix. Blocking for reviewer green.
2. **T-2.6** — re-estimate L→XL (8h→12h) OR split into T-2.6a/T-2.6b. PR-2 critical path stretches 3→3.5 days.
3. **T-3.2** — enum member rename must sweep *inside* error-class `super()` calls (errors.ts lines 95, etc.), not just external throw sites. T-3.2a scope **includes** errors.ts itself but plan doesn't call out the super-call sweep. Add explicit acceptance.
4. **T-2.12** — must include pre-step scaffolding `examples/package.json` + `examples/tsconfig.json` (R-05). Currently assumes they exist.
5. **T-1.0** — add as new task (planner implicitly described it — R-13). Make T-1.3/T-1.8/T-1.9 depend on it.

---

## 4. Go/No-Go per PR

| PR | Verdict | Conditions |
|---|---|---|
| **PR-1** | **GO with mitigations** | Fix T-1.1 acceptance (9 files); add T-1.0 for root package.json SHARED serialization; clarify T-1.8 scope incl. `optionalDependencies`. |
| **PR-2** | **GO with mitigations** | Scaffold `examples/package.json` before T-2.12; re-estimate T-2.6; add T-2.6 acceptance for dangling `core/src/index.ts` re-exports. |
| **PR-3** | **CONDITIONAL GO — BLOCKED pending npm-credentials answer + cycle-resolution** | R-01 (barrel slot 19 cycle) and R-04 (npm token ownership) MUST be resolved before PR-3 starts. T-3.2 codemod must sweep error-class `super()` calls. |

---

## 5. Wave-5C Aggregate Verdict

**PROCEED-WITH-MITIGATIONS**

The plan is structurally sound and the three-PR decomposition is correct. Five HIGH risks are all *planning* gaps, not code-level unknowns — they can be closed with acceptance-criterion edits and one team-lead decision (npm credentials). No risk suggests the fundamental ADR/PRD/plan trajectory is wrong.

**Pre-P4 checklist** (must be answered in writing by team-lead before implementers start):
1. R-04/Gaps 4+7: who holds the `@harness-one` npm org admin token? Is it 2FA-enforced?
2. R-01/Gap 6: drop slot 19 or insert `preset-bridge.ts` wrapper?
3. R-03/R-05: update T-1.1 + T-2.12 acceptance criteria per §3 above.
4. R-02: commit to codemod scope that includes error-class `super()` calls, not just external throws.
5. R-08: clarify tiktoken's intended dep classification in ADR §4.
