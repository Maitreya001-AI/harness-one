# Wave-5C Risk Decisions (Lead)

**Date**: 2026-04-15 · **Lead**: @XRenSiu · **Amends**: `wave-5c-task-plan.md` + `wave-5c-adr.md`

Decisions applied to the risk-assessor's 18-risk matrix (`wave-5c-risk-assessment.md`). Implementers must treat these as authoritative amendments to the task plan.

## HIGH-severity resolutions

### R-01 · Drop barrel slot 19 (`createSecurePreset` subpath-only)
- **Decision**: Remove `createSecurePreset` from the root barrel. Consumers import it from `@harness-one/preset` directly.
- **Rationale**: A re-export from `harness-one` → `@harness-one/preset` → `harness-one` is a real cycle; drop-the-slot beats wrapper-indirection at zero consumer cost (preset users already ship `@harness-one/preset`).
- **Amendment**: ADR §5.1 barrel list shrinks to **19 value symbols** (still under the ≤25 ceiling). Update `docs/forge-fix/wave-5/wave-5c-adr.md` barrel list accordingly at PR-3. Wave-5A `createSecurePreset` consumers import from `@harness-one/preset` verbatim; the CHANGELOG rename-mapping entry documents this.
- **Task impact**: T-3.1 (barrel narrow) reduced by 1 symbol + 1 regression-test required ("`import { createSecurePreset } from '@harness-one/preset'` still passes Wave-5A secure-preset.test.ts").

### R-02 · Enum codemod sweeps error-class `super()` calls
- **Decision**: T-3.2 codemod scope is extended to include literal strings inside `packages/core/src/core/errors.ts` (e.g., `MaxIterationsError` line 95's `'MAX_ITERATIONS'` literal). Every `super('X', ...)` inside error-class constructors must use the renamed enum member.
- **Amendment**: T-3.2a acceptance adds: "`grep -rn "'UNKNOWN'\|'MAX_ITERATIONS'\|'RATE_LIMIT'\|..." packages/*/src/` returns 0 hits across all packages (openai, anthropic, redis, langfuse, preset included, not just core)". Ecosystem-package sweep is part of T-3.2, not deferred.

### R-03 · T-1.1 acceptance fix (9 files, not 3)
- **Decision**: T-1.1 acceptance criterion 3 reads: "`packages/core/src/infra/` contains all 9 files previously in `_internal/` — `async-lock.ts`, `disposable.ts`, `ids.ts`, `json-schema.ts`, `lazy-async.ts`, `lru-cache.ts`, `redact.ts`, `safe-log.ts`, `token-estimator.ts`. `find packages/core/src/infra -type f | wc -l` = 9."

### R-04 · npm credentials (DEFERRED to pre-PR-3)
- **Decision**: **PR-1 and PR-2 proceed WITHOUT touching npm.** T-3.4 (placeholder publish of `@harness-one/{core,runtime,sdk,framework}@0.0.0-reserved`) is gated by a lead checkpoint at PR-3 start where the user (XRenSiu, npm org admin) confirms:
  - `@harness-one` npm org 2FA-enforced (all publishers)
  - `NPM_TOKEN` stored as GitHub Actions secret with `repo`-scope only
  - T-3.4 uses `npm publish --provenance --access public`
  - Each placeholder `package.json` has `"publishConfig": {"access": "public"}`
- **Amendment**: T-3.4 blocks on a pre-PR-3 lead sign-off (checkbox in the PR-3 description). No implementer proceeds past T-3.3 until signed. If the user has not yet created the `@harness-one` npm org, defer placeholder publish entirely to Wave-5G and drop F-14 from 5C; document the defer in the CHANGELOG as "F-14 moved to Wave-5G pending org provisioning".

### R-05 · Scaffold `examples/` as a workspace package pre-migration
- **Decision**: Add **T-2.11b** (~1h, before T-2.12): scaffold `examples/package.json` with `"private": true`, add `"examples"` to `pnpm-workspace.yaml`, scaffold `examples/tsconfig.json` extending the root config, run `pnpm -C examples typecheck` on HEAD to capture baseline. Baseline must be green before F-13 migration begins.
- **Amendment**: T-2.11b becomes dependency of T-2.12. PR-2 critical path adds ~1h (re-estimate below reconciles).

## MEDIUM-severity resolutions

### R-06 · Re-estimate T-2.6 XL (12h) + keep single task
- **Decision**: T-2.6 estimate changes from L (8h) to XL (12h); keep as single task (splitting creates two cross-cutting DAG nodes with overlapping file ownership, not worth it).
- **Amendment**: PR-2 critical path stretches to ~3-3.5 days.

### R-07 · T-2.6 dangling-exports acceptance
- **Decision**: T-2.6 acceptance adds: "`packages/core/src/index.ts` has zero re-exports from `./evolve/index.js` referencing symbols that moved to devkit (`createComponentRegistry`, etc.); `pnpm -C packages/core typecheck` green."

### R-08 · Keep tiktoken as `optionalDependencies`
- **Decision**: tiktoken stays in `packages/preset/package.json`'s `optionalDependencies` (not `peerDependencies`). Rationale: tiktoken's native dep has known install-failure modes on unsupported platforms; `optionalDependencies` lets install succeed without it and the preset's token-estimator gracefully falls back to char-count heuristic.
- **Amendment**: ADR §4 Package Map table row for preset adds a footnote: "`tiktoken` is an `optionalDependencies` entry (not peer) per R-08 lead call; preset degrades gracefully when tiktoken is absent". T-1.8 `verify-deps.ts` inspects all three dep fields (`dependencies`, `peerDependencies`, `optionalDependencies`) and has a tiktoken-specific rule allowing the optional classification.

### R-09 · Initial cli + devkit versions at 1.0.0-rc.X lockstep
- **Decision**: T-2.15 changeset entries for new `@harness-one/cli` and `@harness-one/devkit` declare them at the **prevailing major** `1.0.0-rc.X` (whatever rc-increment PR-1 bumped to). Not 0.x.

### R-10 · T-2.14 runs source-map test FIRST
- **Decision**: T-2.14 acceptance reorders: run source-map step-into test on current HEAD (dry-run) BEFORE committing any `tsup.config.ts` change. If `files`-narrowing alone excludes `dist/infra` from the tarball, skip the `rm dist/infra` post-build step.

### R-11 · `createSecurePreset` regression test covers R-01 drop
- **Decision**: T-3.1 adds a smoke test in `packages/preset/src/__tests__/secure-preset-import.test.ts` asserting `import { createSecurePreset } from '@harness-one/preset'` resolves and the fail-closed invariants run. Not a duplicate of existing suite — a focused module-resolution test.

### R-12 · T-1.10 notes expected infra-prefix diff
- **Decision**: T-1.10 acceptance appends: "`grep -l 'infra/' packages/*/etc/*.api.md` — if any found, T-1.10 PR description notes 'expected diff in PR-2 T-2.14'."

## LOW-severity resolutions

### R-13 · Add T-1.0 (devDep install + scripts)
- **Decision**: T-1.0 created as the first PR-1 task (~30min): install `eslint-plugin-import`, `@microsoft/api-extractor`, wire `verify:deps` + `api:update` scripts in root `package.json`. T-1.3, T-1.8, T-1.9 all depend on T-1.0.

### R-14 · T-2.12 sweeps docs prose
- **Decision**: T-2.12 acceptance adds: "`grep -rn 'harness-one/eval\|harness-one/evolve\|harness-one/cli' docs/ README.md examples/README.md` returns 0 runtime-import hits (prose mentions in historical ADRs are fine; flag interactively)."

### R-15 · Merge-guard in T-1.8
- **Decision**: T-1.8 acceptance adds: "`packages/ajv/package.json` AND `packages/tiktoken/package.json` exist; `find packages -maxdepth 2 -name 'package.json' | wc -l` ≥ 10 (the merge-guard fires if ajv+tiktoken ever get merged without an ADR amendment)."

### R-16 · T-3.5 log-hygiene review
- **Decision**: T-3.5 code review acceptance adds: "the script never logs `prBody` verbatim; it only emits a boolean `has_rationale` + line-number."

### R-17 · Editorial fix in task plan
- **Decision**: Fixed inline when the implementer gets there — non-blocking.

### R-18 · Windows path-sep in verify-deps
- **Decision**: T-1.8 acceptance adds: "`tools/verify-deps.ts` uses `node:path` consistently; CI's `windows-latest` job passes."

## Ancillary resolution

### Gap #3 · Two-step enum flip kept
- **Decision**: Keep the two-step enum conversion (PR-1 value-equivalence flip in T-1.3, PR-3 rename-to-prefixed-form codemod in T-3.2). Rationale: isolates risk — PR-1 catches any adapter subclass breakage before PR-3's mechanical rename cascade lands.

## PR Go/No-Go (amended)

| PR | Verdict | Status |
|---|---|---|
| **PR-1** | GO | All mitigations foldable into acceptance criteria; no lead checkpoint needed mid-PR. |
| **PR-2** | GO | T-2.11b pre-scaffolds examples/. T-2.6 XL estimate. Critical path ~3-3.5 days. |
| **PR-3** | CONDITIONAL GO | Pre-PR-3 lead checkpoint: confirm npm org + token per R-04. If not provisioned by PR-2 merge, drop F-14 to Wave-5G (document in CHANGELOG). |

## Implementer notes

- Treat this doc as delta over `wave-5c-task-plan.md`. When acceptance criteria conflict, **this doc wins**.
- If a mitigation turns out to be unneeded during implementation (e.g., R-10 source-map test passes on HEAD with `files`-narrowing alone), proceed per the lighter path and note the deviation in the commit message.
- Do not re-open ADR decisions. If implementation surfaces a true blocker, stop and ask the lead rather than re-deciding.
