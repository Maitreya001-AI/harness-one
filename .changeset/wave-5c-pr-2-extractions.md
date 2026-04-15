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
"@harness-one/cli": major
"@harness-one/devkit": major
---

**Wave-5C PR-2 — CLI + devkit extractions (BREAKING).**

Second of three PRs on `wave-5/production-grade` that finalise the 1.0-rc
package boundaries (see `docs/forge-fix/wave-5/wave-5c-adr.md` §3.a / §7).

First-time publications (per risk-decisions R-09 — both start at the
prevailing 1.0.0-rc major line so they lockstep with `harness-one`):

- **`@harness-one/cli`** — new workspace package. Owns `bin: harness-one`,
  `init`, `audit`, `help` commands. `harness-one` is a regular dependency
  (not peer) so `pnpm dlx @harness-one/cli init` resolves from a clean
  `node_modules`. The 651-LOC `templates.ts` is split into one file per
  `ModuleName` under `packages/cli/src/templates/` with a
  `SUBPATH_MAP` source-of-truth file and a build-time parser test
  (`templates-subpaths.test.ts`, F-3 acceptance) that asserts every
  `from 'harness-one/<subpath>'` or `from '@harness-one/devkit'` literal in
  a template still resolves to a real export.
- **`@harness-one/devkit`** — new workspace package carrying the former
  `harness-one/eval` surface and the `harness-one/evolve` component-registry,
  drift-detector, and taste-coding sub-surfaces. Declares `harness-one` as a
  peer dependency (dev-time tool; consumer ships core separately).

Breaking changes in this PR:

- **`harness-one/cli` subpath removed.** Use `@harness-one/cli` (or
  `pnpm dlx @harness-one/cli ...`). The core package no longer declares a
  `bin` field.
- **`harness-one/eval` subpath removed.** Migrate to `@harness-one/devkit`:
  ```ts
  - import { createEvalRunner } from 'harness-one/eval';
  + import { createEvalRunner } from '@harness-one/devkit';
  ```
- **`harness-one/evolve` subpath removed.** Split per responsibility:
  ```ts
  // runtime architecture rules stay in core
  - import { createArchitectureChecker } from 'harness-one/evolve';
  + import { createArchitectureChecker } from 'harness-one/evolve-check';
  // dev-time registry / drift / taste-coding move to devkit
  - import { createComponentRegistry, createDriftDetector } from 'harness-one/evolve';
  + import { createComponentRegistry, createDriftDetector } from '@harness-one/devkit';
  ```
- **Root-barrel `createEvalRunner`, `createRelevanceScorer`, and
  `createComponentRegistry` exports removed.** They were convenience
  re-exports from the now-deleted subpaths; consumers must import from
  `@harness-one/devkit` directly. `createRAGPipeline` remains in the root
  barrel (still lives in core).

Non-breaking additions:

- **`harness-one/evolve-check`** — new core subpath carrying
  `createArchitectureChecker`, `noCircularDepsRule`, `layerDependencyRule`,
  and the `ArchitectureRule` / `RuleContext` / `RuleResult` types. The hybrid
  split per ADR §3.h keeps architecture enforcement in the core package
  (runtime safety) while moving dev-tool surfaces to devkit.
- **`examples/` is now a workspace package** (`@harness-one/examples`,
  `private: true`). `pnpm -C examples typecheck` runs in CI (via
  `pnpm -r typecheck`) so any future subpath migration regression fails the
  build.

CLI scaffold changes (visible to `npx harness-one init`):

- `init --modules eval` now emits `from '@harness-one/devkit'` instead of
  `from 'harness-one/eval'`.
- `init --modules evolve` emits `from '@harness-one/devkit'` (registry,
  drift) plus `from 'harness-one/evolve-check'` (architecture checker).

api-extractor snapshots regenerated; new baselines added for
`packages/cli/etc/cli.api.md` and `packages/devkit/etc/devkit.api.md`; the
`packages/core/etc/harness-one.api.md` diff reflects the removed `cli/`,
`eval/`, `evolve/` public surface.
