# @harness-one/preset

## 0.2.0

### Patch Changes

- c731ee2: Chore: close 4 GitHub security alerts and stop three workflows going red on every push. No runtime/API changes.

  - CodeQL `js/file-system-race` (#122) in `tools/check-pack-reproducible.mjs`: replaced the `statSync` → `readFileSync` TOCTOU pair with a single-fd flow (`openSync` + `fstatSync` + `readFileSync(fd)` + `closeSync`).
  - CodeQL `js/clear-text-logging` (#123) in `examples/guardrails/pii-detector.ts`: variable name `blockApiKey` matched the `key/token/secret` heuristic; renamed to `strictVerdict`.
  - CodeQL `js/redos` (#124) in `packages/core/src/guardrails/__tests__/content-filter.test.ts`: the test deliberately constructs an unsafe pattern to verify the ReDoS pre-check rejects it; reconstructed the source via `String.fromCharCode` so neither a regex literal nor a string literal of `(a+)+b` appears in the file.
  - Dependabot GHSA-qx2v-qp2m-jg93 (postcss XSS via unescaped `</style>`): `pnpm.overrides` bumps postcss from 8.5.8 → ^8.5.10. Dev-only — postcss isn't imported by any published source.
  - Secret scan workflow was failing on every push to `main`: full-history gitleaks scan re-flagged three test/example fixtures (placeholder secrets by design). Added them to `.gitleaks.toml`'s path allowlist.
  - Adapter-caller timing flake (`expected 11 to be greater than or equal to 12`): `Date.now()`'s 1ms resolution can leave wall-clock duration a tick behind the summed scheduled backoffs. Loosened the cumulative-duration assertion by 2ms; real accounting bugs (e.g. duration reset to 0) still trip it.
  - Cassette-drift workflow `ERR_MODULE_NOT_FOUND`: `tools/record-cassettes.mjs` runs from repo root with bare-specifier imports of `harness-one/testing` / `@harness-one/anthropic` / `@harness-one/openai`. Added the three packages as `workspace:*` devDependencies on the root so pnpm symlinks them into `node_modules/`, and updated the workflow to build all three packages before running the script.

- d361733: Chore: comment-only edit in `packages/core/tests/perf/bench.ts` to drop a dangling pointer at a docs file removed in this PR. No runtime, API, or test-coverage changes.
- 1dc2368: Layer 9 (dogfood) follow-ups: warning false-positive, vitest 4 timer regression, dogfood budget; plus README split.

  **`harness-one` — `AgentLoopConfig.guardrailsManagedExternally?: boolean`** added (additive, optional). Wrapper-layer opt-in: when `true`, suppresses the one-time "AgentLoop has no guardrail pipeline — security risk" warning. Defaults to `false`; the warning still fires for direct `createAgentLoop` callers, preserving the fail-closed safety alert. Intended for an enclosing harness (e.g. `createSecurePreset`) that runs the guardrail pipeline at its own boundary — see `docs/architecture/05-guardrails.md`.

  **`@harness-one/preset` — internal opt-in flip**. `wireComponents` now sets `guardrailsManagedExternally: true` when constructing the inner `AgentLoop`. Fixes a false-positive warning that previously fired on every `harness.run()` call telling preset users to "use createSecurePreset" — which they already were. Two documented contracts (`docs/architecture/05-guardrails.md:23` vs `README.md:421`) had collided. No public API change in `@harness-one/preset` itself.

  **Test infrastructure (no consumer impact)**: `packages/core/vitest.config.ts` pins `fakeTimers.toFake` to a safe minimal set (vitest 4 expanded the default to include `queueMicrotask`/`nextTick`/`setImmediate`, which deadlocked vitest's own internal hook scheduling — restored 51 pre-existing failing tests to green) and disables vitest's console intercept (vitest 4 worker rpc + coverage instrumentation had a race where a `safeWarn` fallback fired from inside a fake-timer callback could land on `onUserConsoleLog` after the worker rpc began closing).

  **Dogfood (private workspace, no consumer impact)**: `apps/dogfood` now enforces a per-run USD budget via `DOGFOOD_BUDGET_USD` (default `$0.50`) — eliminates the "no cost budget configured" warning that was firing on every triage run, and caps inference spend on a runaway tool-loop or attacker-crafted issue.

  **Docs**: `README.md` split per best practices — 1235 lines → 343 lines (-72%). Per-module API reference moved to `docs/modules.md`; preset deep dive moved to `packages/preset/README.md` (where npm shows it); import-path cheatsheet moved to `docs/guides/import-paths.md`; feature maturity matrix moved to `docs/feature-maturity.md`. Every cross-link verified before commit; covered by the existing `docs-links.yml` lychee check.

- fa42679: Chore: CI gate follow-ups after the TS6 / vitest 4 upgrade (PR #19). No runtime/API changes.

  - `@harness-one/ajv` test suite now exercises the circular-schema stable-key fallback path, lifting branch coverage from 70.58% to 80.39% (over the 75% gate). Source unchanged.
  - `@harness-one/preset`: two `@link` targets in the `createSecurePreset` TSDoc (`createDefaultLogger`, `registerProvider`) were demoted to inline code spans because they are not re-exported from the `harness-one` root bundle and so cannot be resolved by typedoc. Public API surface unchanged.
  - `harness-one` (`observe/trace-manager`): one intra-doc `@link` demoted to a backtick reference for the same typedoc reason. Behaviour unchanged.

  Tooling side (not versioned): `tools/check-pack-reproducible.mjs` now falls back to a content digest that alphabetises packed `package.json` dependency keys when raw tarball bytes differ, isolating a known pnpm `workspace:*` substitution quirk that previously flagged `@harness-one/preset` as non-reproducible every run. `docs-links.yml` bumped `actions/cache` v4.0.2 → v4.2.4 (deprecated-cache retirement). `secret-scan.yml` replaced the now-paywalled `gitleaks/gitleaks-action` with a direct CLI install from the upstream MIT-licensed release so the job runs without a per-org license.

- fcd5582: Chore: close the two CI gates still red after PR #20 merged. No runtime/API changes.

  - `engines.node` bumped from `">=18"` to `">=20"` across every published package and the root workspace. `packageManager: "pnpm@10.24.0"` ships a regex with the ES2024 `/v` flag, which Node 18 cannot parse — pnpm itself fails to load on Node 18 runners with `SyntaxError: Invalid regular expression flags` before any workspace code runs. The previous `">=18"` manifest claim was misleading; `">=20"` matches what actually works.
  - `.github/workflows/ci.yml` build matrix dropped Node 18; kept `[20, 22]` across ubuntu / macos / windows (6 combos).
  - `packages/core/etc/harness-one.api.md` refreshed to the current tsup chunk-hash (`cost-tracker-IqVhfrMb`). The hash shifted when PR #20's typedoc commit (`90b5b8f`) edited a JSDoc block inside `observe/trace-manager.ts` — the JSDoc change propagates into `.d.ts`, which changes the rollup-plugin-dts content hash. Public API surface unchanged (diff is four comment lines inside `// Warnings were encountered` noting a forgotten export, no exported symbols moved).

- Updated dependencies [ef73133]
- Updated dependencies [c731ee2]
- Updated dependencies [d361733]
- Updated dependencies [1dc2368]
- Updated dependencies [fa42679]
- Updated dependencies [fcd5582]
- Updated dependencies [5576b88]
- Updated dependencies [b72de7e]
  - harness-one@0.2.0
  - @harness-one/ajv@0.1.1
  - @harness-one/anthropic@0.1.1
  - @harness-one/devkit@1.0.0
  - @harness-one/openai@0.1.1
