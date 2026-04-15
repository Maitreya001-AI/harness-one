# Wave-5C Task Plan

**Generated**: 2026-04-15
**Planner**: task-planner (Forge P3)
**ADR**: `/Users/xrensiu/development/owner/harness-one/docs/forge-fix/wave-5/wave-5c-adr.md` (LOCKED)
**PRD**: `/Users/xrensiu/development/owner/harness-one/docs/forge-fix/wave-5/wave-5c-prd-v2.md`
**Critique**: `/Users/xrensiu/development/owner/harness-one/docs/forge-fix/wave-5/wave-5c-arch-critique.md`
**Branch**: `wave-5/production-grade`

Three PRs per ADR §3.l. Each PR has its own DAG and parallelism analysis. Tasks IDs: `T-<PR>.<seq>`.

---

## PR-1: Mechanical cleanup

**ADR refs**: §3.b, §3.e, §3.f, §3.i, §7 PR-1 | **Maps to F-N**: F-2, F-5 (partial), F-6 (interim enum flip), F-9, F-10 (deferred-to-PR-2 if cli not extracted yet), F-12, F-8 (baseline only)

**Important scope note**: ADR §7 PR-1 step 1 locates `templates.ts` split in PR-2 (because `packages/cli/` does not yet exist in PR-1). The user brief lists templates split under PR-1 — I honor the ADR (authoritative) and place it in PR-2, keeping PR-1 purely mechanical. The brief mismatch is called out in `## Gaps for arbiter`.

### T-1.1: Rename `_internal/` → `infra/` (mechanical git mv + sed)

- **Owner**: `packages/core/src/infra/**` (new path after move), `packages/core/src/_internal/**` (deleted path)
- **Reads**: `packages/core/src/**` (scan only for existing `_internal` imports)
- **Depends on**: (none)
- **Blocks**: T-1.2, T-1.3
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `git mv packages/core/src/_internal packages/core/src/infra` completed
  - [ ] Zero files remain under `packages/core/src/_internal/`
  - [ ] `packages/core/src/infra/` preserves `async-lock.ts`, `lru-cache.ts`, `disposable.ts` + `__tests__/`
  - [ ] typecheck fails loudly (broken imports) — expected; T-1.2 fixes
- **Parallel-safe with**: none (owns the rename commit)
- **Notes**: PRD E-1 confirms all 19 importers intra-`packages/core/src/`. ADR §3.e locks target name `infra/`. Do NOT update importers yet — T-1.2 is the sed sweep, kept separate so the rename commit is a clean `git mv` reviewable as "pure rename".

### T-1.2: Update 19 intra-package importers (sed sweep)

- **Owner**: 19 files per PRD/Grep audit:
  - `packages/core/src/tools/registry.ts`, `tools/validate.ts`
  - `packages/core/src/observe/trace-manager.ts`, `observe/logger.ts`, `observe/index.ts`
  - `packages/core/src/core/agent-loop.ts`, `core/fallback-adapter.ts`
  - `packages/core/src/session/manager.ts`
  - `packages/core/src/rag/retriever.ts`
  - `packages/core/src/orchestration/orchestrator.ts`
  - `packages/core/src/prompt/builder.ts`
  - `packages/core/src/memory/store.ts`, `memory/fs-store.ts`
  - `packages/core/src/guardrails/schema-validator.ts`
  - `packages/core/src/context/compress.ts`, `context/count-tokens.ts`
  - `packages/core/src/context/__tests__/compress.test.ts`, `__tests__/count-tokens.test.ts`
  - `packages/core/src/index.ts`
- **Reads**: `packages/core/src/infra/**` (resolve targets)
- **Depends on**: T-1.1
- **Blocks**: T-1.3, T-1.4 (T-1.4 needs green typecheck baseline)
- **Estimate**: S (~1-2h) — pure mechanical `sed -i 's|_internal|infra|g'`
- **Acceptance**:
  - [ ] `grep -rn "_internal" packages/core/src/` returns 0 hits
  - [ ] `pnpm -C packages/core typecheck` green
  - [ ] `pnpm -C packages/core test` green (infra unit tests still pass)
- **Parallel-safe with**: T-1.5, T-1.6, T-1.7 (those touch disjoint file sets) — see matrix below
- **Notes**: This is one atomic task (not 19 parallel tasks) because the `sed` pattern is identical and trivial; splitting would cost more coordination than it saves. Running it as one PR-review unit keeps the diff readable.

### T-1.3: Install ESLint `no-internal-modules` rule + seed fixture

- **Owner**: root `.eslintrc.*` (or `eslint.config.js`), `package.json` (add `eslint-plugin-import` devDep), `packages/openai/src/__lint-fixtures__/bad-reach-in.ts` (new seed file)
- **Reads**: `packages/core/src/infra/**` (reference targets in rule config)
- **Depends on**: T-1.2
- **Blocks**: T-1.13 (PR-1 CI gate)
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `eslint-plugin-import` installed as root devDep
  - [ ] Rule forbids `harness-one/infra/**` + `harness-one/dist/infra/**` from any file outside `packages/core/src/` and outside `**/__tests__/**`
  - [ ] Seed fixture at `packages/openai/src/__lint-fixtures__/bad-reach-in.ts` imports `harness-one/infra/lru-cache` with `// eslint-disable-next-line` removed; `pnpm lint` fails on that file
  - [ ] `pnpm lint` green across rest of repo
- **Parallel-safe with**: T-1.4, T-1.5, T-1.6, T-1.7, T-1.8 (disjoint file Owner sets)
- **Notes**: ADR §3 critic-hybrid item 8 locks `eslint-plugin-import`'s `no-internal-modules` (not custom `no-restricted-imports`). Tests in `__tests__/` exempt. PRD F-2 measure.

### T-1.4: `HarnessErrorCode` → string enum (interim shape, PR-1 step 8)

- **Owner**: `packages/core/src/core/errors.ts`
- **Reads**: all 47 throw-site files (to confirm no literal-string drift) — READ only
- **Depends on**: (none — independent of T-1.1/T-1.2)
- **Blocks**: T-3.2 (PR-3 final renames depend on enum shape existing)
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] `HarnessErrorCode` declared as `export enum HarnessErrorCode { ... }` with 24 existing code values 1:1 (un-prefixed) + new `ADAPTER_CUSTOM`
  - [ ] `HarnessError.code` type changes from `HarnessErrorCode | (string & {})` to `HarnessErrorCode`
  - [ ] `details?: Readonly<{ adapterCode?: string; [k: string]: unknown }>` constructor param added
  - [ ] Existing throw sites still compile (because values match strings 1:1) — no throw-site rewrites yet
  - [ ] `pnpm -C packages/core typecheck` green
  - [ ] `pnpm -r typecheck` green across full monorepo (adapter subclasses still compile because enum values are same strings)
  - [ ] New `error-code-exhaustive.test-d.ts` compile-time test per ADR §6 committed
- **Parallel-safe with**: T-1.1, T-1.2, T-1.3, T-1.5, T-1.6, T-1.7, T-1.8 (single owner file; only READS other throw sites)
- **Notes**: **CRITICAL parallelism decision**: ADR §7 PR-1 step 8 keeps enum values as current un-prefixed strings (1:1 match) precisely to avoid touching 152 throw sites in PR-1. The throw-site prefix rename (`UNKNOWN` → `CORE_UNKNOWN`) is a SINGLE large codemod in **PR-3 (T-3.2)**, not PR-1. This is why T-1.4 can be ONE task owned by one file (`errors.ts`) — no throw-site ownership split needed. The user brief's concern about "pre-scope which throw sites each implementer owns" applies to PR-3, not PR-1.

### T-1.5: Delete `packages/full/` after audit

- **Owner**: `packages/full/**` (deletion)
- **Reads**: `.github/**`, `pnpm-workspace.yaml`, `tsconfig*.json`, `packages/*/tsup.config.*`, `examples/**` (audit)
- **Depends on**: (none)
- **Blocks**: T-1.13
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] Audit command `grep -r "packages/full" .github/ pnpm-workspace.yaml tsconfig*.json packages/*/tsup.config.* examples/` returns 0 hits (ADR §3.b)
  - [ ] `rm -rf packages/full/` committed
  - [ ] `pnpm install` green (lockfile regenerated if needed)
  - [ ] `pnpm -r build` green
- **Parallel-safe with**: T-1.1, T-1.2, T-1.3, T-1.4, T-1.6, T-1.7, T-1.8
- **Notes**: PRD E-3 already confirms no `package.json`, no `src/`, no workspace reference. Audit is defensive. Maps to F-5 (the `packages/full/` half; ajv/tiktoken merge decision is LOCKED keep-separate in ADR §3.c — no task needed).

### T-1.6: Delete `Harness.eventBus` dead-stub

- **Owner**: `packages/preset/src/index.ts`
- **Reads**: `packages/preset/src/__tests__/**` (confirm no test asserts on eventBus)
- **Depends on**: (none)
- **Blocks**: T-1.13
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `eventBus` Proxy (lines ~170-230), `eventBusWarnEmitted` flag, and `Harness.eventBus` interface field removed
  - [ ] Lines ~370-410 (Proxy export) removed
  - [ ] `grep -rn 'eventBus' packages/preset/src/` returns 0 hits
  - [ ] `Harness` interface in `packages/preset/src/index.ts` has no `eventBus` field
  - [ ] `pnpm -C packages/preset test` green (tests that asserted on Proxy removed; new smoke test asserting `harness.eventBus === undefined` is NOT added per NG-1 behavior-no-change philosophy)
- **Parallel-safe with**: T-1.1, T-1.2, T-1.3, T-1.4, T-1.5, T-1.7, T-1.8
- **Notes**: Maps to F-9. ADR §7 PR-1 step 4. One of the two behavioral changes allowed in PR-1 (NG-1 exception).

### T-1.7: Delete `essentials.ts` + `./essentials` subpath

- **Owner**: `packages/core/src/essentials.ts` (delete), `packages/core/src/__tests__/essentials.test.ts` (delete), `packages/core/package.json` (remove `./essentials` from `exports`)
- **Reads**: `docs/**`, `README.md`, `CHANGELOG.md`, `.github/**` (audit for residual references)
- **Depends on**: (none)
- **Blocks**: T-1.13
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] Pre-delete audit: `grep -rn "harness-one/essentials" docs/ README.md CHANGELOG.md .github/ packages/ examples/` returns 0 hits (ADR §3.i)
  - [ ] `packages/core/src/essentials.ts` deleted
  - [ ] `packages/core/src/__tests__/essentials.test.ts` deleted
  - [ ] `./essentials` entry removed from `packages/core/package.json#exports`
  - [ ] `dist/essentials.*` removed from build (if present post-build)
  - [ ] `pnpm -C packages/core build` + `test` green
- **Parallel-safe with**: T-1.1, T-1.2, T-1.3, T-1.4, T-1.5, T-1.6, T-1.8
- **Notes**: ADR §3.i LOCKED DELETE. User brief PR-3 section asks to "confirm ADR 9.i" — ADR §3.i is unambiguous DELETE; also ADR §7 PR-1 step 5 places the deletion in PR-1. **Deviation from user brief**: the brief lists `essentials.ts` delete under PR-3; ADR places it in PR-1. I honor the ADR.

### T-1.8: `tools/verify-deps.ts` CI script

- **Owner**: `tools/verify-deps.ts` (new file, ~80 LOC), `package.json` (add `verify:deps` script), `.github/workflows/api-check.yml` (or existing CI config — wire `pnpm verify:deps` into job)
- **Reads**: all `packages/*/package.json`, all `packages/*/src/**/*.ts` (scan `import` / `from` statements)
- **Depends on**: (none)
- **Blocks**: T-1.13
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] `tools/verify-deps.ts` enumerates `from 'harness-one'` / `from 'harness-one/*'` / `from '@harness-one/*'` across workspace packages
  - [ ] Asserts each importing package declares the dependency in `dependencies` / `peerDependencies` with `workspace:*` protocol
  - [ ] In-scope packages per PRD F-12: `ajv`, `tiktoken`, `anthropic`, `openai`, `langfuse`, `opentelemetry`, `redis`, `preset` (cli + devkit added in PR-2)
  - [ ] `pnpm verify:deps` exits 0 on current HEAD
  - [ ] CI job wired to run `pnpm verify:deps` on every PR
  - [ ] Negative test: synthetic "remove harness-one from `packages/openai/package.json`" returns exit 1 with clear message
- **Parallel-safe with**: T-1.1, T-1.2, T-1.3, T-1.4, T-1.5, T-1.6, T-1.7
- **Notes**: Maps to F-12. ADR §7 PR-1 step 6.

### T-1.9: Install + configure api-extractor (baseline snapshot mode)

- **Owner**: root `package.json` (add `@microsoft/api-extractor` devDep + `pnpm api:update` script), `packages/core/api-extractor.json` (new), `packages/preset/api-extractor.json`, `packages/openai/api-extractor.json`, `packages/anthropic/api-extractor.json`, `packages/redis/api-extractor.json`, `packages/langfuse/api-extractor.json`, `packages/opentelemetry/api-extractor.json`, `packages/ajv/api-extractor.json`, `packages/tiktoken/api-extractor.json` (10 configs total — cli + devkit added in PR-2)
- **Reads**: each `packages/*/package.json` (determine main entry)
- **Depends on**: T-1.2, T-1.4 (need green typecheck baseline so extractor succeeds)
- **Blocks**: T-1.10, T-1.13
- **Estimate**: M (~6h)
- **Acceptance**:
  - [ ] Each `api-extractor.json` carries `apiReport.includeForgottenExports: true` per ADR §3.g
  - [ ] Each config contains the commented-out strict-mode block:
    ```jsonc
    // "releaseTagPolicy": { "requireReleaseTag": true, "untaggedPolicy": "error" }
    ```
    verbatim for Wave-5C.1 to uncomment
  - [ ] `pnpm api:update` script regenerates all `*.api.md` snapshots
  - [ ] api-extractor runs deterministic output (no timestamps, no absolute paths)
- **Parallel-safe with**: T-1.5, T-1.6, T-1.7 (disjoint — api-extractor touches separate config files)
- **Notes**: Maps to F-8 (baseline install; CI gate activation is PR-3 T-3.6). ADR §7 PR-1 step 7.

### T-1.10: Generate + commit baseline `*.api.md` snapshots (10 packages)

- **Owner**: `packages/core/etc/harness-one.api.md`, `packages/preset/etc/preset.api.md`, `packages/openai/etc/openai.api.md`, `packages/anthropic/etc/anthropic.api.md`, `packages/redis/etc/redis.api.md`, `packages/langfuse/etc/langfuse.api.md`, `packages/opentelemetry/etc/opentelemetry.api.md`, `packages/ajv/etc/ajv.api.md`, `packages/tiktoken/etc/tiktoken.api.md` (exact paths per api-extractor defaults)
- **Reads**: each package's built `dist/**` (inputs to extractor)
- **Depends on**: T-1.9
- **Blocks**: T-1.13
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `pnpm api:update` run; 10 `*.api.md` files committed
  - [ ] Each snapshot non-empty and reflects current public surface
  - [ ] No `dist/infra` symbols leak into snapshots (if they do — flag to T-2.7's `dist/infra` narrowing)
- **Parallel-safe with**: none (single `pnpm api:update` invocation)
- **Notes**: Baseline snapshots form the diff target for PR-2/PR-3 changes. ADR §7 PR-1 step 7.

### T-1.11: CONTRIBUTING.md — document `pnpm api:update` + rationale workflow

- **Owner**: `CONTRIBUTING.md` (new section or update)
- **Reads**: existing `CONTRIBUTING.md`
- **Depends on**: T-1.9
- **Blocks**: T-1.13
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] Section "API change override workflow" added with worked example: rename a symbol → `pnpm api:update` → commit `.api.md` → add `## API change rationale` PR section
  - [ ] Mention snapshot-diff mode vs stability-tag mode (5C.1 deferral)
- **Parallel-safe with**: all other PR-1 tasks
- **Notes**: PRD §7.4 DX requirement.

### T-1.12: Changeset for PR-1 (linked lockstep)

- **Owner**: `.changeset/pr-1-wave-5c-mechanical.md` (new)
- **Reads**: list of all `@harness-one/*` + `harness-one` packages touched
- **Depends on**: T-1.6, T-1.7 (behavioral changes must be in changeset), T-1.4 (enum shape flip is type-breaking)
- **Blocks**: T-1.13
- **Estimate**: S (~30min)
- **Acceptance**:
  - [ ] Changeset lists `harness-one`, `@harness-one/preset`, and all `@harness-one/*` native packages (linked lockstep per PD-2)
  - [ ] Semver bump: **major** for `harness-one` (enum closure is breaking), **major** for `@harness-one/preset` (eventBus removal)
  - [ ] Summary enumerates: eventBus deletion, essentials deletion, `_internal/→infra/` rename, `HarnessErrorCode` enum flip, `packages/full/` removal
- **Parallel-safe with**: all other PR-1 tasks except T-1.13
- **Notes**: PRD § "Cross-PR invariants". Linked = every package in the set bumps.

### T-1.13: PR-1 integration gate (CI green across all changes)

- **Owner**: (meta-task — verifies composition)
- **Reads**: all PR-1 owned files
- **Depends on**: T-1.2, T-1.3, T-1.4, T-1.5, T-1.6, T-1.7, T-1.8, T-1.10, T-1.11, T-1.12
- **Blocks**: PR-1 merge
- **Estimate**: S (~2h for conflict resolution if parallel merges collide)
- **Acceptance**:
  - [ ] `pnpm -r typecheck` green
  - [ ] `pnpm -r test` green
  - [ ] `pnpm -r build` green
  - [ ] `pnpm lint` green (including new `no-internal-modules` rule + seed fixture expected-fail)
  - [ ] `pnpm verify:deps` green
  - [ ] `pnpm api:update` produces no diff (baseline already committed)
  - [ ] Changeset present
- **Parallel-safe with**: none (gate task)
- **Notes**: This is the reviewer hand-off; acceptance-reviewer picks up here.

### PR-1 DAG

```
T-1.1 ───► T-1.2 ───► T-1.3 ───►                     ┐
                              │                       │
                              ├──► T-1.9 ──► T-1.10 ──┤
T-1.4 ────────────────────────┤                       ├──► T-1.13
                              │                       │
T-1.5 ─────────────────────────┤                      │
T-1.6 ─────────────────────────┤                      │
T-1.7 ─────────────────────────┤                      │
T-1.8 ─────────────────────────┤                      │
T-1.9 ────► T-1.11 ────────────┤                      │
T-1.12 ───────────────────────────────────────────────┘
```

### PR-1 file-ownership matrix (conflict check)

| File                                            | T-1.1 | T-1.2 | T-1.3 | T-1.4 | T-1.5 | T-1.6 | T-1.7 | T-1.8 | T-1.9 | T-1.10 | T-1.11 | T-1.12 | Conflict? |
|-------------------------------------------------|-------|-------|-------|-------|-------|-------|-------|-------|-------|--------|--------|--------|-----------|
| `packages/core/src/infra/**`                    | OWNS  | READS | READS | -     | -     | -     | -     | -     | -     | -      | -      | -      | No (serialized) |
| `packages/core/src/core/errors.ts`              | -     | -     | -     | OWNS  | -     | -     | -     | -     | -     | -      | -      | -      | No |
| `packages/core/package.json` (exports)          | -     | -     | -     | -     | -     | -     | OWNS  | -     | -     | -      | -      | -      | No |
| `packages/preset/src/index.ts`                  | -     | -     | -     | -     | -     | OWNS  | -     | -     | -     | -      | -      | -      | No |
| `packages/full/**`                              | -     | -     | -     | -     | OWNS  | -     | -     | -     | -     | -      | -      | -      | No |
| root `package.json`                             | -     | -     | SHARED| -     | -     | -     | -     | SHARED| SHARED| -      | -      | -      | **YES — 3-way** |
| root `eslint.config.*`                          | -     | -     | OWNS  | -     | -     | -     | -     | -     | -     | -      | -      | -      | No |
| `tools/verify-deps.ts`                          | -     | -     | -     | -     | -     | -     | -     | OWNS  | -     | -      | -      | -      | No |
| `packages/*/api-extractor.json` (9 files)       | -     | -     | -     | -     | -     | -     | -     | -     | OWNS  | READS  | -      | -      | No |
| `packages/*/etc/*.api.md`                       | -     | -     | -     | -     | -     | -     | -     | -     | -     | OWNS   | -      | -      | No |
| `CONTRIBUTING.md`                               | -     | -     | -     | -     | -     | -     | -     | -     | -     | -      | OWNS   | -      | No |
| `.changeset/pr-1-*.md`                          | -     | -     | -     | -     | -     | -     | -     | -     | -     | -      | -      | OWNS   | No |

**SHARED resolution**: Root `package.json` is touched by T-1.3 (add `eslint-plugin-import`), T-1.8 (add `verify:deps` script), T-1.9 (add `api-extractor` devDep + `api:update` script). **Strategy: serialize as `package.json` edit micro-task OR run all three in one implementer's hand.** Recommended: **one implementer owns T-1.3, T-1.8, T-1.9 as a triplet** to eliminate merge friction on `package.json`. Alternative: extract a pre-task `T-1.0 root-package-json-setup` that adds all three devDeps + scripts at once; then T-1.3/T-1.8/T-1.9 only modify other files. For N=4+ teams, T-1.0 extraction is cleaner.

### PR-1 parallelism analysis

- **Critical path**: T-1.1 → T-1.2 → T-1.9 → T-1.10 → T-1.13. Estimate ~S+S+M+S+S = ~13h ≈ 1.5-2 days.
- **Parallel group A (after T-1.2 green)**: T-1.3, T-1.4, T-1.5, T-1.6, T-1.7, T-1.8 (all disjoint Owner sets except root `package.json` SHARED — see above).
- **N=2 team**: critical path dominates; one implementer runs T-1.1→T-1.2→T-1.9→T-1.10, the other fans out T-1.3/T-1.4/T-1.5/T-1.6/T-1.7/T-1.8/T-1.11/T-1.12. **Safe, ~2 days**.
- **N=4 team**: one runs rename chain (T-1.1, T-1.2, T-1.9, T-1.10), one owns enum + changeset (T-1.4, T-1.12), one owns deletes (T-1.5, T-1.6, T-1.7), one owns tooling (T-1.3, T-1.8, T-1.11 — plus the extracted T-1.0 root-package-json setup). **Safe, ~1-1.5 days**.
- **N=6 team**: diminishing returns; T-1.1/T-1.2 serialize 19-file sweep, no further parallelism. N=4 is the sweet spot.

### PR-1 risk notes (for risk-assessor)

- **R-1.A**: Root `package.json` is touched by 3 tasks; recommend T-1.0 extraction or triplet-owner strategy.
- **R-1.B**: T-1.4 enum flip keeps values 1:1 with strings; adapter packages should remain green. Risk: an adapter might rely on `(string & {})` widening for a raw string throw. Mitigation: `pnpm -r typecheck` in T-1.13 catches any such site — would block merge.
- **R-1.C**: T-1.1 + T-1.2 are mechanically separate commits but morally one change; reviewer may ask to squash. Acceptable either way.
- **R-1.D**: The user brief placed `templates.ts` split in PR-1; ADR places it in PR-2. I honor the ADR. If team-lead wants to move the split earlier, **T-1.1 cannot help** — there's no `packages/cli/` destination in PR-1.

---

## PR-2: Extractions + examples migration

**ADR refs**: §3.d, §3.j, §3.k, §7 PR-2 | **Maps to F-N**: F-3, F-4, F-10, F-13

### T-2.1: Scaffold `packages/cli/` (new workspace package)

- **Owner**: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/tsup.config.ts`, `packages/cli/README.md`, `packages/cli/src/index.ts` (empty placeholder), `pnpm-workspace.yaml` (implicit — already matches `packages/*`)
- **Reads**: `packages/core/package.json`, `packages/preset/package.json` (borrow shape)
- **Depends on**: PR-1 merged
- **Blocks**: T-2.2, T-2.3, T-2.4
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `packages/cli/package.json` declares: `name: "@harness-one/cli"`, `bin: { "harness-one": "./dist/bin.js" }`, `dependencies: { "harness-one": "workspace:*" }` (regular, NOT peer — ADR §3.k + PRD E-5)
  - [ ] `api-extractor.json` installed per PR-1 template + commented strict-mode block
  - [ ] `pnpm install` green; new package visible in `pnpm list`
  - [ ] `pnpm -C packages/cli build` green (empty placeholder)
- **Parallel-safe with**: T-2.5, T-2.6 (devkit scaffold + architecture-checker subpath — disjoint packages)
- **Notes**: ADR §4 package map. Maps to F-3.

### T-2.2: Move `cli/*` files from `packages/core/src/cli/` → `packages/cli/src/`

- **Owner**: `packages/cli/src/bin.ts` (from `core/src/cli/index.ts`), `packages/cli/src/audit.ts`, `packages/cli/src/parser.ts`, `packages/cli/src/ui.ts`, `packages/cli/src/__tests__/cli.test.ts`; DELETE `packages/core/src/cli/**`
- **Reads**: `packages/cli/src/**` (self) + `harness-one` public API (imports reshaped to `from 'harness-one/*'`)
- **Depends on**: T-2.1
- **Blocks**: T-2.3 (templates split happens in new home), T-2.9
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] All files under `packages/core/src/cli/` moved via `git mv` to `packages/cli/src/` (exception: `templates.ts` — stays moved but unsplit; T-2.3 splits)
  - [ ] `packages/core/package.json#exports` loses `./cli` entry
  - [ ] `packages/core/package.json` loses `bin` field
  - [ ] `packages/cli/package.json` gains `bin: { "harness-one": "./dist/bin.js" }`
  - [ ] Imports in moved files that were relative (`../core/...`) rewritten to `from 'harness-one/core'`, `from 'harness-one/prompt'`, etc.
  - [ ] `pnpm -C packages/cli typecheck` + `test` green
  - [ ] `pnpm -C packages/core typecheck` green (no residual `cli/` references)
- **Parallel-safe with**: T-2.5, T-2.6 (disjoint packages)
- **Notes**: ADR §7 PR-2 step 1. Maps to F-3.

### T-2.3: Split `templates.ts` → 13 files + `subpath-map.ts`

- **Owner**: `packages/cli/src/templates/core.ts`, `templates/prompt.ts`, `templates/context.ts`, `templates/tools.ts`, `templates/guardrails.ts`, `templates/observe.ts`, `templates/session.ts`, `templates/memory.ts`, `templates/orchestration.ts`, `templates/rag.ts`, `templates/eval.ts`, `templates/evolve.ts`, `templates/index.ts` (13 files); `packages/cli/src/subpath-map.ts` (new const); DELETE old `packages/cli/src/templates.ts`
- **Reads**: old `packages/cli/src/templates.ts` (source to split)
- **Depends on**: T-2.2
- **Blocks**: T-2.4
- **Estimate**: M (~6h)
- **Acceptance**:
  - [ ] 13 template files created, one per `ModuleName`, alphabetical (but `index.ts` last)
  - [ ] Each file ≤ 70 LOC (ADR §3.d target); max < 200 LOC (PRD F-10 ceiling)
  - [ ] `subpath-map.ts` declares `SUBPATH_MAP` const — typed table mapping ModuleName → subpath literal (e.g., `{ core: 'harness-one/core', eval: '@harness-one/devkit', evolve: '@harness-one/devkit' }`)
  - [ ] Each template file imports from `SUBPATH_MAP` rather than hard-coded strings (ADR §3.d A §8.2 verbatim)
  - [ ] Each template file has header comment naming its one consumer (PRD F-10 measure)
  - [ ] `pnpm -C packages/cli typecheck` + `test` green
  - [ ] `eval` + `evolve` templates kept as SEPARATE files (ADR §3.d "one divergence from A")
- **Parallel-safe with**: T-2.5, T-2.6 (disjoint packages)
- **Notes**: Maps to F-10. ADR §3.d LOCKED one-file-per-ModuleName. **Do NOT merge eval+evolve templates** (ADR §3.d).

### T-2.4: Build-time parser test for `SUBPATH_MAP`

- **Owner**: `packages/cli/src/__tests__/subpaths-resolve.test.ts` (new)
- **Reads**: `packages/cli/src/subpath-map.ts`, `packages/core/package.json` (exports), `packages/devkit/package.json` (exports)
- **Depends on**: T-2.3, T-2.5 (devkit scaffold must exist so its `package.json#exports` is resolvable), T-2.9 (harness-one exports updated to drop `./eval`/`./evolve`)
- **Blocks**: T-2.14
- **Estimate**: S (~3h)
- **Acceptance**:
  - [ ] Test reads `harness-one/package.json#exports` + `@harness-one/devkit/package.json#exports`
  - [ ] Asserts every value in `SUBPATH_MAP` resolves (either via Node's `exports` resolver OR by checking the key's presence in the exports map)
  - [ ] Failing case: if a `SUBPATH_MAP` entry points to a dropped subpath (e.g., `harness-one/eval` after T-2.9 removes it), test fails with file:line
  - [ ] Test runs in `< 2s` (static, deterministic)
- **Parallel-safe with**: T-2.6, T-2.10, T-2.11 (disjoint)
- **Notes**: Maps to F-3 measure E-4. ADR §3.d last paragraph.

### T-2.5: Scaffold `packages/devkit/` (new workspace package)

- **Owner**: `packages/devkit/package.json`, `packages/devkit/tsconfig.json`, `packages/devkit/tsup.config.ts`, `packages/devkit/README.md`, `packages/devkit/src/index.ts` (placeholder), `packages/devkit/api-extractor.json`
- **Reads**: `packages/core/package.json`, `packages/cli/package.json` (shape reference)
- **Depends on**: PR-1 merged
- **Blocks**: T-2.6, T-2.7, T-2.8
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `packages/devkit/package.json`: `name: "@harness-one/devkit"`, `dependencies: { "harness-one": "workspace:*" }` (regular — ADR §3.k rejects C's peerDep)
  - [ ] Dual ESM/CJS per ADR §4 (consumer may be on Jest-CJS)
  - [ ] `pnpm install` + `pnpm -C packages/devkit build` green
- **Parallel-safe with**: T-2.1, T-2.2, T-2.3 (disjoint packages)
- **Notes**: ADR §3.k. Maps to F-4.

### T-2.6: Move `eval/*` + non-runtime `evolve/*` into `packages/devkit/src/`

- **Owner**: `packages/devkit/src/eval/**` (from `packages/core/src/eval/**`), `packages/devkit/src/evolve/component-registry.ts`, `evolve/drift-detector.ts`, `evolve/taste-coding.ts`, `evolve/generator-evaluator.ts`, `evolve/flywheel.ts` (from core), `packages/devkit/src/evolve/__tests__/**` (except architecture-checker tests); DELETE corresponding paths in `packages/core/src/` (except `architecture-checker.ts`)
- **Reads**: `harness-one` public API surface (rewrite relative imports to subpath imports)
- **Depends on**: T-2.5
- **Blocks**: T-2.7, T-2.9
- **Estimate**: L (~8h) — many files, requires verifying architecture-checker stays behind
- **Acceptance**:
  - [ ] `packages/core/src/evolve/` contains ONLY `architecture-checker.ts` + `__tests__/architecture-checker.test.ts` + the new runtime-purity test (T-2.7)
  - [ ] `packages/core/src/eval/` deleted entirely
  - [ ] All moved files: relative imports (`../core/...`) rewritten to `from 'harness-one/core'`, `from 'harness-one/observe'`, etc.
  - [ ] `packages/devkit/src/index.ts` re-exports `createEvalRunner`, `createComponentRegistry`, `createRelevanceScorer`, `createDriftDetector`, `createTasteCoding`, `createGeneratorEvaluator`, `createFlywheel` (names per ADR §3.k)
  - [ ] `packages/devkit` typecheck + test green
  - [ ] `packages/core` typecheck green (no dangling imports to moved files)
- **Parallel-safe with**: T-2.2, T-2.3 (disjoint — cli vs devkit)
- **Notes**: ADR §3.j LOCKS architecture-checker stays in core. ADR §3.k LOCKS devkit contents. Maps to F-4.

### T-2.7: `evolve-check` subpath + runtime-purity test

- **Owner**: `packages/core/package.json` (add `./evolve-check` export), `packages/core/src/evolve/index.ts` (re-export architecture-checker only), `packages/core/src/evolve/__tests__/architecture-checker-runtime-purity.test.ts` (new, ~40 LOC)
- **Reads**: `packages/core/src/evolve/architecture-checker.ts`, `packages/core/package.json#dependencies`, `packages/core/dist/evolve/architecture-checker.js` (after build)
- **Depends on**: T-2.5, T-2.6
- **Blocks**: T-2.9
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] `packages/core/package.json#exports` adds:
    ```json
    "./evolve-check": "./dist/evolve/architecture-checker.js"
    ```
    with full `{ types, import, require }` triplet
  - [ ] `packages/core/src/evolve/index.ts` exports ONLY architecture-checker symbols (nothing from moved files — T-2.6 deleted them)
  - [ ] Runtime-purity test: parses `dist/evolve/architecture-checker.js` for `require`/`import` specifiers; asserts every specifier resolves through `harness-one/package.json#dependencies` (not `devDependencies`)
  - [ ] Test passes on HEAD — any dev-only import from `architecture-checker.ts` fails with file:line
  - [ ] Test runs in `< 2s`
- **Parallel-safe with**: T-2.4 (disjoint)
- **Notes**: ADR §3.j locked decision + NEW acceptance test. Maps to F-4 + critique open-question #4 closure.

### T-2.8: `packages/devkit/api-extractor.json` + baseline snapshot

- **Owner**: `packages/devkit/etc/devkit.api.md` (new snapshot)
- **Reads**: `packages/devkit/dist/**`
- **Depends on**: T-2.6
- **Blocks**: T-2.14
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] `pnpm api:update` regenerates `packages/devkit/etc/devkit.api.md`
  - [ ] Snapshot committed
  - [ ] `pnpm -C packages/devkit` api-extractor green
- **Parallel-safe with**: T-2.4, T-2.11
- **Notes**: Part of F-8 snapshot coverage.

### T-2.9: Remove `./cli`, `./eval`, `./evolve` subpath exports from `harness-one/package.json`

- **Owner**: `packages/core/package.json` (exports map trim)
- **Reads**: (none)
- **Depends on**: T-2.2, T-2.6, T-2.7 (all moves must complete first)
- **Blocks**: T-2.4 (parser test expects the trimmed shape), T-2.10, T-2.14
- **Estimate**: S (~30min)
- **Acceptance**:
  - [ ] `packages/core/package.json#exports` matches ADR §5.4 (12 entries: `.`, `./core`, `./prompt`, `./context`, `./tools`, `./guardrails`, `./observe`, `./session`, `./memory`, `./orchestration`, `./rag`, `./evolve-check`)
  - [ ] `./cli` removed; `./eval` removed; `./evolve` removed
  - [ ] `./evolve-check` present (from T-2.7)
  - [ ] `bin` field absent from `packages/core/package.json` (moved to cli in T-2.2)
- **Parallel-safe with**: T-2.11, T-2.12
- **Notes**: ADR §5.4. Maps to F-3 + F-4.

### T-2.10: Regenerate `harness-one/etc/harness-one.api.md` snapshot

- **Owner**: `packages/core/etc/harness-one.api.md`
- **Reads**: `packages/core/dist/**`
- **Depends on**: T-2.9 (exports map must be final)
- **Blocks**: T-2.14
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] Snapshot regenerated via `pnpm api:update --filter harness-one`
  - [ ] Diff shows: removed symbols from `./cli`, `./eval`, `./evolve` + new `./evolve-check` entries
  - [ ] Root barrel unchanged at this PR (that's PR-3)
- **Parallel-safe with**: T-2.8, T-2.11
- **Notes**: F-8 snapshot maintenance.

### T-2.11: `packages/cli/etc/cli.api.md` baseline

- **Owner**: `packages/cli/etc/cli.api.md`
- **Reads**: `packages/cli/dist/**`
- **Depends on**: T-2.3 (templates split green)
- **Blocks**: T-2.14
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] Snapshot committed
- **Parallel-safe with**: T-2.8, T-2.10
- **Notes**: F-8 snapshot coverage for new package.

### T-2.12: Migrate `examples/` — swap `harness-one/eval` + `harness-one/evolve` → `@harness-one/devkit`

- **Owner**: `examples/full-stack-demo.ts`, `examples/eval/llm-judge-scorer.ts`, `examples/package.json` (new or update), plus any of the 20 files that touch `harness-one/eval` or `harness-one/evolve` (full enumeration via grep at task start)
- **Reads**: `packages/devkit/src/index.ts` (confirm export names), post-F-1 `harness-one` barrel (not yet trimmed in PR-2; barrel trim is PR-3)
- **Depends on**: T-2.6 (devkit must have symbols), T-2.9 (subpath removal invalidates old imports)
- **Blocks**: T-2.13
- **Estimate**: M (~4-6h)
- **Acceptance**:
  - [ ] PRD-explicit sites migrated:
    - `examples/full-stack-demo.ts:15` — `import type { Scorer } from 'harness-one/eval'` → `'@harness-one/devkit'`
    - `examples/full-stack-demo.ts:20` — `import { createEvalRunner } from 'harness-one/eval'` → `'@harness-one/devkit'`
    - `examples/eval/llm-judge-scorer.ts:8,119` — `from 'harness-one/eval'` → `'@harness-one/devkit'`
  - [ ] Any `from 'harness-one/evolve'` sites migrated to `'@harness-one/devkit'`
  - [ ] `examples/package.json` declares `@harness-one/devkit: workspace:*` as **devDependency**
  - [ ] `grep -rn "harness-one/eval\|harness-one/evolve\|harness-one/cli" examples/` returns 0 hits
  - [ ] `pnpm -C examples typecheck` green
- **Parallel-safe with**: T-2.10, T-2.11 (disjoint dirs)
- **Notes**: Maps to F-13. **P0 BLOCKER for F-4 acceptance** (ADR §3.l + PRD F-13 header).

### T-2.13: Wire `pnpm -C examples typecheck` into CI

- **Owner**: `.github/workflows/ci.yml` (or existing workflow)
- **Reads**: `examples/package.json`, `examples/tsconfig.json`
- **Depends on**: T-2.12
- **Blocks**: T-2.14
- **Estimate**: S (~1h)
- **Acceptance**:
  - [ ] CI job runs `pnpm -C examples typecheck` on every PR
  - [ ] Seed "break examples" commit fails CI (verified by pushing a throwaway branch)
  - [ ] Job runtime `< 90s`
- **Parallel-safe with**: T-2.10, T-2.11
- **Notes**: Maps to UJ-6 + F-13 measure.

### T-2.14: `dist/infra` narrowing (belt-and-suspenders)

- **Owner**: `packages/core/tsup.config.ts` (add `noExternal` for infra), `packages/core/package.json` (narrow `files` from `["dist"]` to explicit list per ADR §5.4), `packages/core/src/__tests__/infra-sourcemap.test.ts` (new — A-F-2 mitigation)
- **Reads**: current `packages/core/tsup.config.ts`, current `packages/core/package.json`
- **Depends on**: T-2.9 (exports map stable)
- **Blocks**: T-2.15
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] `tsup.config.ts` bundles `infra/*` inline into `dist/core/index.js` etc.; post-build step removes `dist/infra/` **IF source-map test (below) passes**
  - [ ] `packages/core/package.json#files` narrowed to explicit list: `["dist/index.js", "dist/core", "dist/prompt", "dist/context", "dist/tools", "dist/guardrails", "dist/observe", "dist/session", "dist/memory", "dist/orchestration", "dist/rag", "dist/evolve/architecture-checker.*"]` (exact list per ADR §5.4)
  - [ ] Source-map step-into test: invokes a symbol that transits `infra/*` under `--enable-source-maps`; asserts no "cannot find source" stderr
  - [ ] If source-map test fails: fall back to `files`-narrowing only (drop `rm dist/infra`) per ADR §7 PR-2 step 8
  - [ ] `pnpm -C packages/core build` + `test` green
  - [ ] `pnpm pack --dry-run` (on `packages/core`) shows tarball NOT containing `dist/infra/**`
- **Parallel-safe with**: T-2.12, T-2.13
- **Notes**: ADR §7 PR-2 step 8 + ADR §3 critic-hybrid item 6. Risk R-4 mitigation.

### T-2.15: Changeset for PR-2

- **Owner**: `.changeset/pr-2-wave-5c-extractions.md`
- **Reads**: package list
- **Depends on**: T-2.12, T-2.14
- **Blocks**: T-2.16
- **Estimate**: S (~30min)
- **Acceptance**:
  - [ ] Changeset covers `harness-one` (major — subpath removals), `@harness-one/cli` (minor/initial), `@harness-one/devkit` (minor/initial), and the linked lockstep bump propagates to all other `@harness-one/*` packages
  - [ ] Summary enumerates: F-3 cli extract, F-4 devkit extract, F-10 templates split, F-13 examples migration
- **Parallel-safe with**: T-2.13

### T-2.16: PR-2 integration gate

- **Owner**: (meta)
- **Reads**: all PR-2 owned files
- **Depends on**: T-2.4, T-2.7, T-2.8, T-2.10, T-2.11, T-2.13, T-2.14, T-2.15
- **Blocks**: PR-2 merge
- **Estimate**: S (~2h)
- **Acceptance**:
  - [ ] `pnpm -r typecheck` + `build` + `test` + `lint` green
  - [ ] `pnpm verify:deps` green (includes new cli + devkit)
  - [ ] `pnpm api:update` produces no diff (all 3 snapshots committed)
  - [ ] `pnpm -C examples typecheck` green (**hard blocker per F-13**)
  - [ ] `packages/cli/src/__tests__/subpaths-resolve.test.ts` green
  - [ ] Runtime-purity test green
  - [ ] Source-map step-into test green
  - [ ] Changeset present
- **Parallel-safe with**: none
- **Notes**: F-13 green is the hard gate on F-4.

### PR-2 DAG

```
PR-1 ► T-2.1 ─► T-2.2 ─► T-2.3 ─┐
                              │  │
                              │  └─► T-2.11 ─┐
                              │              │
       T-2.5 ─► T-2.6 ─► T-2.7 ──► T-2.8 ───►│
                      │                      │
                      └► T-2.9 ─► T-2.10 ───►│
                            │                │
                            ├► T-2.4 ────────►│
                            │                │
                            └► T-2.12 ─► T-2.13 ─► T-2.16
                                   │
                                   T-2.14 ────►│
                                               T-2.15 ─►│
```

### PR-2 file-ownership matrix

| File                                          | T-2.1 | T-2.2 | T-2.3 | T-2.4 | T-2.5 | T-2.6 | T-2.7 | T-2.8 | T-2.9 | T-2.10 | T-2.11 | T-2.12 | T-2.13 | T-2.14 |
|-----------------------------------------------|-------|-------|-------|-------|-------|-------|-------|-------|-------|--------|--------|--------|--------|--------|
| `packages/cli/**`                             | OWNS  | OWNS  | OWNS  | OWNS  | -     | -     | -     | -     | -     | -      | OWNS   | -      | -      | -      |
| `packages/core/src/cli/**`                    | -     | OWNS (delete) | - | - | - | - | - | - | - | - | - | - | - | - |
| `packages/devkit/**`                          | -     | -     | -     | -     | OWNS  | OWNS  | -     | OWNS  | -     | -      | -      | -      | -      | -      |
| `packages/core/src/eval/**`                   | -     | -     | -     | -     | -     | OWNS (delete) | - | - | - | - | - | - | - | - |
| `packages/core/src/evolve/**`                 | -     | -     | -     | -     | -     | OWNS (partial delete) | OWNS (add test; keep arch-checker) | - | - | - | - | - | - | - |
| `packages/core/package.json`                  | -     | SHARED (remove bin + ./cli) | - | - | - | - | SHARED (add ./evolve-check) | - | SHARED (remove ./eval, ./evolve) | - | - | - | - | SHARED (narrow files) |
| `packages/core/etc/harness-one.api.md`        | -     | -     | -     | -     | -     | -     | -     | -     | -     | OWNS   | -      | -      | -      | -      |
| `examples/**`                                 | -     | -     | -     | -     | -     | -     | -     | -     | -     | -      | -      | OWNS   | -      | -      |
| `.github/workflows/ci.yml`                    | -     | -     | -     | -     | -     | -     | -     | -     | -     | -      | -      | -      | OWNS   | -      |
| `packages/core/tsup.config.ts`                | -     | -     | -     | -     | -     | -     | -     | -     | -     | -      | -      | -      | -      | OWNS   |

**SHARED resolution — `packages/core/package.json`**: 4 tasks (T-2.2, T-2.7, T-2.9, T-2.14) modify it. **Strategy: serialize on the dependency chain already enforced**. T-2.2 writes first (remove bin + `./cli`), T-2.7 writes next (add `./evolve-check` — depends on T-2.6), T-2.9 writes next (remove `./eval`, `./evolve` — depends on T-2.6 + T-2.7 via DAG), T-2.14 writes last (narrow `files` — depends on T-2.9). Each writes a disjoint section of the JSON; DAG enforces order; no conflict. **Recommended**: same implementer owns T-2.2, T-2.9, T-2.14 to avoid cross-implementer rebase churn on `package.json`. T-2.7 can be different since it adds a new entry, non-conflicting with removals.

### PR-2 parallelism analysis

- **Critical path**: T-2.1 → T-2.2 → T-2.3 → T-2.4 → T-2.16 OR T-2.5 → T-2.6 → T-2.9 → T-2.10 → T-2.16. Estimate: critical = ~S+M+M+S+S+S = ~18-20h ≈ 2-3 days.
- **Two independent chains**: CLI chain (T-2.1→T-2.2→T-2.3→T-2.11) and devkit chain (T-2.5→T-2.6→T-2.7→T-2.8) are fully parallel — they touch disjoint packages.
- **N=2 team**: one runs CLI chain, one runs devkit chain. They converge at T-2.9 (both need it) → T-2.10 → T-2.12. Safe, ~3 days.
- **N=4 team**: CLI chain owner + devkit chain owner + examples-migration owner (T-2.12 blocks on T-2.6, can start warm with pre-migration scan) + tooling owner (T-2.14 belt-and-suspenders + T-2.13 CI wiring). Safe, ~2 days.
- **N=6 team**: diminishing returns — T-2.2 + T-2.3 are sequential within CLI chain, same for devkit. Adding 2 more hands only helps T-2.12's 20-file sweep if split by directory (`examples/eval/` + `examples/full-stack-demo.ts` + others). N=4 is sweet spot.

### PR-2 risk notes

- **R-2.A**: T-2.12 **blocks** T-2.16 (F-13 is F-4 acceptance blocker). If examples migration discovers a symbol the F-1 barrel trim will also remove, PR-2 green state may break when PR-3 ships. Mitigation: T-2.12 should use subpath imports for any removed-from-root symbol NOW (don't rely on root barrel for anything except the 20 core symbols — preview PR-3's barrel).
- **R-2.B**: ADR §3.k locks architecture-checker in core. T-2.6 must **NOT** move `packages/core/src/evolve/architecture-checker.ts` or its tests. Critical regression risk if an implementer misreads ADR.
- **R-2.C**: T-2.14 `rm dist/infra` may break source-map step-into. Test-first design mitigates but adds wall-clock if fallback needed.
- **R-2.D**: CLI's new `bin.ts` must have correct shebang + executable bit. Frequent miss in monorepo extractions.
- **R-2.E**: `packages/core/package.json` SHARED across 4 tasks but DAG-serialized — **no parallelism risk** if DAG respected. Risk Medium if implementer parallelizes T-2.2 and T-2.7 without respecting T-2.6 blocker.

---

## PR-3: Barrel + api-extractor + placeholder publish

**ADR refs**: §3.a (F-14 defensive), §5 (barrel), §6 (error-code renames), §7 PR-3 | **Maps to F-N**: F-1, F-6 (final), F-8 (gate activation), F-14

### T-3.1: Trim root barrel to 20 value symbols

- **Owner**: `packages/core/src/index.ts`
- **Reads**: ADR §5.1 + §5.2 + §5.3 (final spec)
- **Depends on**: PR-2 merged
- **Blocks**: T-3.2, T-3.7
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] `packages/core/src/index.ts` exports EXACTLY 20 value symbols per ADR §5.1
  - [ ] Each value export carries a `// UJ-N:` justification comment (ADR §5.1 + PRD F-1)
  - [ ] Type-only re-exports match ADR §5.2 exactly (unbounded, but enumerated)
  - [ ] All symbols listed in ADR §5.3 "removals" are deleted from the barrel (they remain accessible via subpath)
  - [ ] `createSecurePreset` re-exported from `@harness-one/preset` (slot 19 per ADR §5.1)
  - [ ] `assertNever` DELETED (ADR §5.3 rejects C-F-9)
  - [ ] `createEventBus`, `EventBus` DELETED (already done in PR-1 T-1.6; verify absent)
  - [ ] api-extractor re-run; `harness-one.api.md` shows ≤ 25 value exports (headroom 5)
  - [ ] `pnpm -r typecheck` green (monorepo internals unaffected because they all use subpath imports)
  - [ ] `pnpm -C examples typecheck` green (F-13 preview done in PR-2 kept us safe)
- **Parallel-safe with**: T-3.4 (disjoint owner), T-3.5 (disjoint owner)
- **Notes**: Maps to F-1. ADR §5 authoritative.

### T-3.2: `HarnessErrorCode` prefix rename codemod (152 throw sites, 47 files)

- **Owner**: `packages/core/src/core/errors.ts` (rename enum members from bare `UNKNOWN` to `CORE_UNKNOWN`, etc.), **+ all 47 throw-site files** (scoped below)
- **Reads**: `packages/core/src/core/__tests__/error-code-exhaustive.test-d.ts` (update cases)
- **Depends on**: T-3.1 (barrel trim green — so one doesn't chase moving targets)
- **Blocks**: T-3.3, T-3.7
- **Estimate**: L (~1 day) — automated codemod, but review + catch sites are substantial

- **Pre-scoped throw-site ownership** (for N≥2 team split — CRITICAL for parallelism):

  | Sub-task     | Owner path scope                               | Files | Throws | Owner (N=4) |
  |--------------|------------------------------------------------|-------|--------|-------------|
  | T-3.2a       | `packages/core/src/core/**`                    | 8     | ~16    | impl-1 |
  | T-3.2b       | `packages/core/src/observe/**`                 | 3     | ~13    | impl-2 |
  | T-3.2c       | `packages/core/src/session/**` + `memory/**`   | 7     | ~20    | impl-2 |
  | T-3.2d       | `packages/core/src/tools/**` + `guardrails/**` | 8     | ~15    | impl-3 |
  | T-3.2e       | `packages/core/src/prompt/**` + `context/**`   | 7     | ~21    | impl-3 |
  | T-3.2f       | `packages/core/src/rag/**` + `orchestration/**`| 7     | ~22    | impl-4 |
  | T-3.2g       | `packages/core/src/infra/**`                   | 2     | ~2     | impl-1 |
  | T-3.2h       | `packages/core/src/evolve/**` (architecture-checker only — eval + other evolve moved to devkit in PR-2) | 1 | ~1 | impl-1 |
  | T-3.2i       | `packages/devkit/**` (moved evolve + eval throws) | ~5  | ~10    | impl-4 |
  | T-3.2j       | `packages/cli/**`                              | 1     | ~1     | impl-4 |
  | T-3.2k       | `packages/openai/**` + `anthropic/**` + `redis/**` + `langfuse/**` + `preset/**` (adapter throws) | ~5 | ~24 | impl-2 |

  Total: ~47 files, ~145 throws (rough — actual sweep re-counts).

- **Acceptance**:
  - [ ] `packages/core/src/core/errors.ts` enum members renamed per ADR §6 (`UNKNOWN` → `CORE_UNKNOWN`, `TOOL_VALIDATION` stays, `GUARD_BLOCKED` stays, adapter_custom stays, new `CORE_MAX_ITERATIONS`, `CORE_ABORTED`, `CORE_TOKEN_BUDGET_EXCEEDED`, `CORE_INVALID_CONFIG`, `CORE_INVALID_STATE`, `CORE_INTERNAL_ERROR`, `CORE_UNKNOWN`, `TOOL_INVALID_SCHEMA`, `TOOL_CAPABILITY_DENIED`, `GUARD_VIOLATION`, `GUARD_INVALID_PIPELINE`, `SESSION_*`, `MEMORY_*`, `TRACE_*`, `CLI_PARSE_ERROR`, `ADAPTER_INVALID_EXTRA`, `ADAPTER_CUSTOM`, `PROVIDER_REGISTRY_SEALED` — full list ADR §6 lines 314-365)
  - [ ] Every throw site in its sub-task scope uses `HarnessErrorCode.<MEMBER>` value (not raw string)
  - [ ] `ts-morph` (or `jscodeshift`) codemod script committed at `tools/codemods/prefix-error-codes.ts` for reproducibility
  - [ ] Exhaustive test `error-code-exhaustive.test-d.ts` updated with new case names
  - [ ] `pnpm -r typecheck` + `test` green
  - [ ] Negative test: raw string `'UNKNOWN'` in any throw site fails tsc
  - [ ] CHANGELOG ships rename-mapping table (24 old → 25 new) per ADR §10.2
- **Parallel-safe with**: T-3.2 sub-tasks ARE the parallel granularity; each sub-task owns disjoint directories. Sub-tasks can also run in parallel with T-3.4 (placeholder publish), T-3.5 (lint rule).
- **Notes**: **This is the high-conflict task the user brief flagged.** ADR §7 PR-3 step 2 mandates "codemod all 152 throw sites across 47 files in one sweep". Recommended execution: one implementer runs codemod script first (generates the diff mechanically), then splits review by sub-task scope. Alternative: if team prefers hand-checked, pre-scope per table above. **Critical: member renames also invalidate any `catch`/`switch` narrowing on old bare strings** — codemod must sweep those too (ADR §7 PR-3 step 2 second sentence).

### T-3.3: Custom ESLint rule `harness-one/no-type-only-harness-error-code`

- **Owner**: `tools/eslint-rules/no-type-only-harness-error-code.ts` (new ~30 LOC), `.eslintrc.*` registration, seed fixture `packages/openai/src/__lint-fixtures__/type-only-error-code.ts`
- **Reads**: (none — pure AST rule)
- **Depends on**: T-3.2 (rule needs correct enum shape to reference in docstring)
- **Blocks**: T-3.7
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] Rule flags `import type { HarnessErrorCode } from 'harness-one'` with error message: "HarnessErrorCode must be value-imported. `import type` drops runtime Object.values() access."
  - [ ] Rule permits `import { HarnessErrorCode }` (value import) and `import type { SomeOtherThing }` (non-target type-only)
  - [ ] Seed fixture fails lint; expected-to-fail is noted in test doc
  - [ ] `pnpm lint` still green on main sources (no current offender)
- **Parallel-safe with**: T-3.1, T-3.4, T-3.5, T-3.6
- **Notes**: ADR §3.f + §7 PR-3 step 4. R-2 mitigation.

### T-3.4: F-14 placeholder npm publishes (4 packages)

- **Owner**: `placeholders/core/package.json`, `placeholders/core/README.md`; `placeholders/runtime/package.json`, `placeholders/runtime/README.md`; `placeholders/sdk/package.json`, `placeholders/sdk/README.md`; `placeholders/framework/package.json`, `placeholders/framework/README.md` (4 placeholder dirs, not in `packages/*` glob to avoid workspace capture)
- **Reads**: ADR §3.a text for README content
- **Depends on**: PR-2 merged (npm credentials CI step operational)
- **Blocks**: T-3.7
- **Estimate**: M (~3h) — includes publish + verification
- **Acceptance**:
  - [ ] 4 dirs under `placeholders/` contain a `package.json` with:
    - `name: "@harness-one/{core,runtime,sdk,framework}"`, `version: "0.0.0-reserved"`, `private: false`, NO `files`, NO `exports`, NO `main`
    - `description: "Reserved for future use; current runtime is the unscoped harness-one package. See MIGRATION.md."` (R-8 verbatim)
  - [ ] README one-pager with explicit language from R-8 mitigation
  - [ ] `npm publish --access public` from each dir executes successfully
  - [ ] `npm view @harness-one/core` returns `0.0.0-reserved`; same for `runtime`, `sdk`, `framework`
  - [ ] Placeholder dirs excluded from `pnpm-workspace.yaml` (either put under non-glob path or add explicit `!placeholders/*`)
  - [ ] `decisions.md` or `docs/release/placeholders.md` documents the publish ceremony (manual vs CI)
- **Parallel-safe with**: T-3.1, T-3.2 sub-tasks, T-3.3, T-3.5, T-3.6
- **Notes**: ADR §3.a + §7 PR-3 step 5. **This is the ONE real `npm publish` action in Wave-5C** (NG-2 exception). All other `npm publish` deferred to Wave-5G.

### T-3.5: Activate api-extractor CI gate + rationale-regex check

- **Owner**: `.github/workflows/api-check.yml` (new or update), `tools/check-api-rationale.ts` (new, ~30 LOC — reads PR description via `GITHUB_EVENT_PATH`)
- **Reads**: each `packages/*/etc/*.api.md`
- **Depends on**: PR-2 snapshots baseline (already in HEAD after PR-2 merged)
- **Blocks**: T-3.7
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] CI job runs api-extractor on every PR; fails if any `*.api.md` diff without an accompanying snapshot regen
  - [ ] Rationale regex check: PR body must match `^## API change rationale\s*$` with ≥20 chars of body (PRD F-8 measure)
  - [ ] Seed PR tests: (a) rename symbol without snapshot → fail; (b) snapshot regen + rationale section → pass; (c) snapshot regen without rationale → fail
  - [ ] Gate active across all 11 packages (core, cli, devkit, preset, openai, anthropic, redis, langfuse, opentelemetry, ajv, tiktoken)
- **Parallel-safe with**: T-3.1, T-3.2 sub-tasks, T-3.3, T-3.4, T-3.6
- **Notes**: Maps to F-8 activation (snapshot-diff mode — stability-tag enforcement stays OFF per PD-3; will flip in 5C.1). ADR §7 PR-3 step 3.

### T-3.6: CHANGELOG authoring (B-1..B-13 + rename mapping)

- **Owner**: `CHANGELOG.md` (or per-package `CHANGELOG.md` if changesets auto-generate)
- **Reads**: PRD §8 breaking-change inventory, ADR §6 adapter-migration example
- **Depends on**: T-3.1, T-3.2 (need final shape)
- **Blocks**: T-3.7
- **Estimate**: M (~4h)
- **Acceptance**:
  - [ ] All 13 B-* entries from PRD §8 have a sed-style 1-liner
  - [ ] Adapter migration example from ADR §6 lines 412-431 included verbatim
  - [ ] Rename-mapping table (24 old → 25 new enum values) present (ADR §10.2 compensating control)
  - [ ] CHANGELOG version block matches changeset-generated version (lockstep, major bump for all `@harness-one/*` packages)
- **Parallel-safe with**: T-3.3, T-3.4, T-3.5
- **Notes**: PRD §8.

### T-3.7: Regenerate all 11 `*.api.md` snapshots + PR-3 changeset + integration gate

- **Owner**: all 11 `packages/*/etc/*.api.md` files, `.changeset/pr-3-wave-5c-surface-lock.md`
- **Reads**: dist outputs of all 11 packages
- **Depends on**: T-3.1, T-3.2, T-3.3, T-3.4, T-3.5, T-3.6
- **Blocks**: PR-3 merge
- **Estimate**: M (~3h)
- **Acceptance**:
  - [ ] `pnpm api:update` regenerates snapshots; all 11 committed
  - [ ] `pnpm -r typecheck` + `build` + `test` + `lint` green
  - [ ] New lint rule `no-type-only-harness-error-code` passes on real sources; seed fixture still failing as designed
  - [ ] `pnpm verify:deps` green
  - [ ] api-extractor gate active: untagged exports are STILL OK (stability-tag policy stays OFF in 5C main per PD-3; 5C.1 flips it)
  - [ ] `## API change rationale` section present in the PR description itself (this PR renames every throw site — rationale is the codemod table)
  - [ ] `npm view @harness-one/core` returns `0.0.0-reserved`
  - [ ] Changeset committed: linked lockstep MAJOR bump across all packages (barrel trim + enum rename = breaking)
- **Parallel-safe with**: none (gate)
- **Notes**: ADR §7 PR-3 step 7.

### PR-3 DAG

```
PR-2 ┬─► T-3.1 ─┬─► T-3.2 (a..k sub-tasks in parallel) ─► T-3.3 ─┐
     │         │                                                 │
     │         └─► T-3.6 ─────────────────────────────────────────┤
     │                                                           │
     ├─► T-3.4 ──────────────────────────────────────────────────┤
     │                                                           │
     └─► T-3.5 ──────────────────────────────────────────────────┴─► T-3.7
```

### PR-3 file-ownership matrix

| File                                              | T-3.1 | T-3.2 | T-3.3 | T-3.4 | T-3.5 | T-3.6 | T-3.7 |
|---------------------------------------------------|-------|-------|-------|-------|-------|-------|-------|
| `packages/core/src/index.ts`                      | OWNS  | -     | -     | -     | -     | -     | -     |
| `packages/core/src/core/errors.ts`                | -     | OWNS  | -     | -     | -     | -     | -     |
| 47 throw-site files (pre-scoped in T-3.2a..k)     | -     | OWNS (partitioned) | - | - | - | - | -     |
| `tools/eslint-rules/*`                            | -     | -     | OWNS  | -     | -     | -     | -     |
| `placeholders/**`                                 | -     | -     | -     | OWNS  | -     | -     | -     |
| `.github/workflows/api-check.yml`                 | -     | -     | -     | -     | OWNS  | -     | -     |
| `tools/check-api-rationale.ts`                    | -     | -     | -     | -     | OWNS  | -     | -     |
| `CHANGELOG.md`                                    | -     | -     | -     | -     | -     | OWNS  | -     |
| `packages/*/etc/*.api.md` (11 snapshots)          | -     | -     | -     | -     | -     | -     | OWNS  |
| `.changeset/pr-3-*.md`                            | -     | -     | -     | -     | -     | -     | OWNS  |
| `packages/core/src/core/__tests__/error-code-exhaustive.test-d.ts` | - | OWNS | - | - | - | - | - |

**No SHARED conflicts** — each task owns disjoint paths. T-3.2 internally partitions 47 files by directory; sub-tasks are disjoint.

### PR-3 parallelism analysis

- **Critical path**: T-3.1 → T-3.2 (ts-morph codemod run) → T-3.3 → T-3.7. Estimate: M + L + M + M ≈ 3 days.
- **Parallel group A (after PR-2 merged, before T-3.2)**: T-3.1, T-3.4, T-3.5 (completely disjoint owners).
- **Parallel group B (T-3.2 internal)**: sub-tasks T-3.2a..k can run in parallel (~11 directory scopes). Practical N is gated by the codemod script — recommended ONE implementer runs the `ts-morph` codemod once (deterministic diff generation), then review is parallel per-subdir.
- **N=2 team**: one runs T-3.1→T-3.2→T-3.3→T-3.6, one runs T-3.4+T-3.5 in parallel. Converge at T-3.7. Safe, ~3 days.
- **N=4 team**: one each on T-3.1, T-3.4, T-3.5 (all parallel from PR-2 merge); one runs codemod T-3.2 after T-3.1. After T-3.2 done, all 4 converge on T-3.2 review (split by sub-task scopes a..k); T-3.3 + T-3.6 piggyback. Safe, ~2 days.
- **N=6 team**: T-3.2 sub-task review can genuinely split 6 ways across directories a+b+c / d+e / f / g+h / i / j+k. But codemod-generation step is single-threaded. Ceiling ~N=5 for wall-clock improvement.

### PR-3 risk notes

- **R-3.A**: T-3.2 is the user-brief-highlighted high-conflict task. **Mitigation**: run `ts-morph` codemod in ONE implementer's hand — mechanical, deterministic. Review split across N implementers by directory. Acceptance-reviewer reviews the full diff as one logical change.
- **R-3.B**: If T-3.2's rename introduces a typo in enum values, the exhaustive test catches it at tsc time. Low risk.
- **R-3.C**: T-3.4 `npm publish` requires authenticated npm token. If CI lacks org-admin token for `@harness-one`, T-3.4 must be run locally by an org admin. **Flag to risk-assessor**: is the CI token scoped for org publish, or is manual publish expected?
- **R-3.D**: T-3.5 rationale-regex check may be too strict (false positives). Seed PRs in acceptance test verify.
- **R-3.E**: T-3.1 barrel trim removes `createResilientLoop`/`createCostTracker` from HEAD pre-PR-3? ADR §5.1 RE-ADDS them (slots 3 + 17). Verify against HEAD — if they are currently at root, T-3.1 keeps them.
- **R-3.F**: Linked-lockstep bump means ALL 11 `@harness-one/*` packages bump to 1.0-rc.X on this PR. R-6 accepted per `decisions.md`.

---

## Cross-PR invariants (verification)

- PR-1 → PR-2 → PR-3 land sequentially on `wave-5/production-grade`
- Each PR independently revertable per `decisions.md` §风险与回滚
- Changeset linked lockstep: 3 changeset files, one per PR
- No real `npm publish` except T-3.4 placeholders (NG-2 exception)
- api-extractor snapshot-diff mode stays ON across all 3 PRs; stability-tag enforcement OFF (deferred to 5C.1)

---

## Gaps for arbiter

1. **PR-1 vs PR-2 placement of `templates.ts` split**: user brief lists it under PR-1; ADR §3.l + ADR §7 PR-1 step 1 defers to PR-2 (because `packages/cli/` doesn't exist until PR-2 T-2.1). I honored the ADR. **Arbiter confirmation**: is the user brief drift intentional or a slip? No functional impact either way — both are same branch, same week.

2. **`essentials.ts` delete placement**: user brief lists it under PR-3; ADR §7 PR-1 step 5 places it in PR-1. I honored the ADR (T-1.7). Same arbiter question.

3. **F-6 (HarnessErrorCode closure) — PR-1 interim flip vs PR-3 full rename**: ADR §7 PR-1 step 8 locks the interim string-enum flip (values 1:1 with strings) in PR-1; PR-3 T-3.2 does the prefix rename codemod. Rationale is sound but adds complexity — is the team comfortable with the two-step close, or would single-shot in PR-3 be preferred despite the larger diff? I left it as ADR locks (two-step); arbiter may reconsider.

4. **T-3.4 npm publish credentials**: ADR declares placeholder publishes as the sole Wave-5C publish action but does not specify WHO has the org-admin npm token. CI secret? Lead's local npm login? Arbiter should surface this to team-lead before T-3.4 starts.

5. **Lint rule for F-6 footgun — package location**: T-3.3 creates `tools/eslint-rules/no-type-only-harness-error-code.ts`. ADR §7 PR-3 step 4 calls it `harness-one/no-type-only-harness-error-code` (implying an `eslint-plugin-harness-one` package). Is the rule shipped as a package (for consumer projects) or only as an internal monorepo rule? I assumed internal-only for main 5C — if consumer-shippable is required, it becomes an `eslint-plugin-harness-one` package + publish, which is a +S task and another NG-2 exception.

6. **`createSecurePreset` re-export at barrel slot 19 — circular import**: ADR §5.1 slot 19 re-exports `createSecurePreset` from `@harness-one/preset`. But `@harness-one/preset` depends on `harness-one`. If `harness-one/src/index.ts` re-exports from `@harness-one/preset`, there's a lazy-eval cycle. Implementation pattern in Stripe-like SDKs is to re-export only types OR to defer via a thin wrapper. **Arbiter**: is this a plan-time gap (flagged B-F-20 / C-F-18 in critique — not resolved in ADR)? Recommend inline-wrapper pattern: `harness-one/src/preset-bridge.ts` imports dynamically. Adds ~30 LOC; safe.

7. **F-14 placeholder: does publishing also need npm `2FA auth-only` or `automation token`?** — same credentials concern as gap #4.

8. **ADR §3.c ajv/tiktoken keep-separate**: PRD F-5 "merge-or-keep" ask is answered but no task is required (no code change beyond existing state). I did not emit a task for it. Confirm this is intended no-op.

---

## 250-word summary

**Task counts per PR (including sub-tasks and gate tasks)**:
- PR-1 (mechanical cleanup): 13 tasks (T-1.1 through T-1.13). Feature coverage: F-2, F-5-partial, F-6-interim, F-8-baseline, F-9, F-12, plus delete/tooling/snapshot/changeset/gate.
- PR-2 (extractions + examples): 16 tasks (T-2.1 through T-2.16). Feature coverage: F-3 (cli extract + templates split + parser test), F-4 (devkit extract + architecture-checker runtime-purity), F-10 (templates split), F-13 (examples migration — F-4 acceptance blocker), F-8 snapshot maintenance.
- PR-3 (surface lock): 7 top-level tasks; T-3.2 internally fans out to 11 directory-scoped sub-tasks (T-3.2a..k) to make the 152-throw-site codemod parallel-safe. Feature coverage: F-1 (barrel trim), F-6 final rename + footgun lint, F-8 CI gate activation, F-14 placeholder publish, CHANGELOG.

**Critical-path estimates (serial chain, single implementer)**:
- PR-1: ~13h ≈ 1.5-2 days; critical chain T-1.1→T-1.2→T-1.9→T-1.10→T-1.13.
- PR-2: ~18-20h ≈ 2-3 days; critical chain T-2.5→T-2.6→T-2.9→T-2.10→T-2.16 (CLI chain parallels, converges at T-2.9).
- PR-3: ~3 days; critical chain T-3.1→T-3.2→T-3.3→T-3.7.
- **Aggregate main 5C critical path**: ~7-8 wall-clock days with N=4, matching PRD estimate of ~3 weeks including review + integration slack.

**Gaps flagged to arbiter** (8 items, see §Gaps): placement drift between user brief and ADR (PR-1 vs PR-2 for `templates.ts` split; PR-1 vs PR-3 for `essentials.ts` delete), npm-publish credentials ownership for T-3.4 + T-3.7, ESLint rule packaging scope (internal-only vs shippable plugin), and a potential circular import at barrel slot 19 where `harness-one` re-exports `createSecurePreset` from `@harness-one/preset`. None of these block planning; all are surface-level clarifications the arbiter should confirm before implementers start.

---

**Deliverable location**: Plan content is emitted inline above (per system instruction not to write .md files). If team-lead wants this persisted as `docs/forge-fix/wave-5/wave-5c-task-plan.md`, the team-lead or a writable-role agent can copy this message verbatim into that path.

**Referenced absolute paths**:
- `/Users/xrensiu/development/owner/harness-one/docs/forge-fix/wave-5/wave-5c-adr.md`
- `/Users/xrensiu/development/owner/harness-one/docs/forge-fix/wave-5/wave-5c-prd-v2.md`
- `/Users/xrensiu/development/owner/harness-one/docs/forge-fix/wave-5/wave-5c-arch-critique.md`
- `/Users/xrensiu/development/owner/harness-one/packages/core/src/_internal/` (T-1.1 rename source)
- `/Users/xrensiu/development/owner/harness-one/packages/core/src/cli/` (T-2.2 move source)
- `/Users/xrensiu/development/owner/harness-one/packages/core/src/eval/` + `packages/core/src/evolve/` (T-2.6 partial move source)
- `/Users/xrensiu/development/owner/harness-one/packages/core/src/essentials.ts` (T-1.7 delete)
- `/Users/xrensiu/development/owner/harness-one/packages/preset/src/index.ts` (T-1.6 eventBus delete)
- `/Users/xrensiu/development/owner/harness-one/packages/full/` (T-1.5 delete)
- `/Users/xrensiu/development/owner/harness-one/examples/` (T-2.12 migration target, 20 files)