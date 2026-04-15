---
"harness-one": major
"@harness-one/preset": major
"@harness-one/openai": major
"@harness-one/anthropic": major
"@harness-one/redis": major
"@harness-one/langfuse": major
"@harness-one/opentelemetry": major
"@harness-one/ajv": major
"@harness-one/tiktoken": major
---

**Wave-5C PR-1 — Mechanical cleanup (BREAKING).**

First of three PRs on the `wave-5/production-grade` branch that finalise the 1.0-rc
package boundaries (see `docs/forge-fix/wave-5/wave-5c-adr.md`).

Breaking changes in this PR:

- **`harness-one/_internal` → `harness-one/infra`.** The directory has been renamed
  from `_internal/` to `infra/` across `packages/core/src/`. All 19 intra-package
  importers updated. No external consumer should have reached into either path
  (both were/are internal); if one did, rewrite `from 'harness-one/infra/*'`.
  An ESLint `import/no-internal-modules` rule now enforces this wall.
- **`harness-one/essentials` subpath removed.** The redundant curated-12 entry
  point has been deleted (`src/essentials.ts`, the `./essentials` export map
  entry, and the `dist/essentials.*` build outputs). Consumers should import
  from `harness-one` or the appropriate submodule (`harness-one/core`,
  `harness-one/observe`, …) directly.
- **`Harness.eventBus` removed** (ARCH-010). The deprecated dead-stub Proxy and
  `DEPRECATED_EVENT_BUS` error code are gone. Use per-module `onEvent()`
  subscriptions (sessions, orchestrator, traces).
- **`HarnessErrorCode` is now a TypeScript enum** with module-prefixed intent
  (values unchanged in this PR — prefixing lands in PR-3). `Object.values(HarnessErrorCode)`
  now yields a runtime array, enabling introspection in logs and telemetry.
  The constructor accepts an optional `details?: { adapterCode?: string; … }`
  for adapter subclasses per ADR §5.2.
- **`packages/full/` deleted.** The orphaned build artefact directory (no
  `package.json`, not referenced anywhere) has been removed.

Non-breaking additions:

- New root scripts: `pnpm verify:deps` (workspace dependency auditor with
  merge-guard per ADR §3.c) and `pnpm api:update` (api-extractor snapshot
  regenerator across all 9 packages).
- Baseline `etc/<pkg>.api.md` snapshots committed for every publishable package;
  api-extractor runs in snapshot-diff-only mode per ADR §3.g (stability-tag
  enforcement is deferred to Wave-5C.1).
