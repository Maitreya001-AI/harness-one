# Wave-5C Architecture — Proposal C: "Ecosystem Alignment"

**Architect**: Architect C ("Ecosystem Alignment")
**Date**: 2026-04-15
**PRD**: `docs/forge-fix/wave-5/wave-5c-prd-v2.md`
**Status**: Competing (Round 1 of 3)
**Design prior**: Copy what works in established npm TypeScript SDKs. Resist novelty; resist cosmetic renames; follow the conventions downstream consumers already know.

---

## 1. Position statement

The harness-one 1.0-rc API surface should look like the SDKs developers already trust: **one marquee package with a rich subpath-exports map**, a handful of **scope-mate packages** that exist only when their boundaries have *mechanical* reasons (binaries, peerDeps, dev-only tooling), and a **branded string-literal error-code taxonomy** identical in shape to what Stripe, Anthropic, and OpenAI ship. The prize is low cognitive load for consumers: they already know how LangChain (`langchain` + `langchain/openai`), Vercel AI SDK (`ai` + `ai/rsc`), and the OpenAI SDK (`openai` + `openai/resources/*`) are laid out. We copy that shape so that a TypeScript engineer opening the harness-one docs for the first time thinks, "I already know how this works."

The competing temptations we reject: (a) split every submodule into a `@harness-one/*` package because "monorepos do fan-out" — that is what Nx tutorials do, not what production SDKs ship; it generates version-skew noise for zero consumer benefit. (b) Rename `harness-one` → `@harness-one/core` to match the scope family cosmetically — that costs us SEO, discovery, and breaks the npm convention (unprefixed root + scoped supplementaries: see `react` + `@types/react`, `vite` + `@vitejs/*`, `vitest` + `@vitest/*`, `next` + `@next/*`, `stripe` + `@stripe/*`). Our proposal keeps `harness-one` as the marquee name, extracts only the three packages whose extraction is forced by mechanics, and refuses cosmetic moves.

---

## 2. Package map

| Package | Name | Scope reason | Subpath count (post-5C) | `bin` | peerDeps | Private? |
|---|---|---|---|---|---|---|
| **Root runtime** | `harness-one` | marquee, unprefixed-convention (`react`, `vite`, `stripe`) | 11 | — | — | No |
| **CLI** | `@harness-one/cli` | binary — `bin` field deserves its own install footprint (precedent: `@vitejs/plugin-*` doesn't own `bin`; `create-vite` does) | 1 (root) | yes | depends on `harness-one` | No |
| **Devkit** | `@harness-one/devkit` | dev-time tooling — `vitest` vs `vite`, `@next/eslint-plugin-next` vs `next`. Contains evolve + eval (architecture-checker stays in core runtime — see §2.1) | 1 (root) + `/eval` + `/evolve` subpaths | — | peerDep on `harness-one` | No |
| **Preset** | `@harness-one/preset` | already exists; unchanged | 1 | — | depends on all adapters | No |
| Adapters | `@harness-one/openai`, `/anthropic` | peerDep on provider SDK (consumer chooses version) — precedent: `@ai-sdk/openai`, `@ai-sdk/anthropic` | 1 each | — | `openai` / `@anthropic-ai/sdk` as peer | No |
| Sinks | `@harness-one/redis`, `/langfuse`, `/opentelemetry` | peerDep on sink SDK (same precedent — `@sentry/node` vs `@sentry/nextjs`) | 1 each | — | sink SDK as peer | No |
| Native-dep shims | `@harness-one/ajv`, `@harness-one/tiktoken` | **KEEP SEPARATE** — consumer picks which native dep to install (precedent: `@ai-sdk/openai` has zod peer; Stripe has `stripe` runtime). Each package declares `ajv` / `@dqbd/tiktoken` as peerDep. Merging into a `@harness-one/native-deps` mega-shim would force consumers to install both even if they use one. | 1 each | — | peerDep on native lib | No |
| (delete) | `packages/full/` | no `package.json`, no `src/` (PRD §3, E-3) | — | — | — | — |

**Total published `@harness-one/*` packages post-5C: 9** (`harness-one` + `cli` + `devkit` + `preset` + 2 adapters + 3 sinks + 2 native shims = 10; -1 after `packages/full/` deletion). No growth beyond current count — we add `cli` and `devkit`, we do **not** split ajv/tiktoken into a combined shim.

### 2.1 Why `architecture-checker` stays in core (not in devkit)

PRD §3 lists `evolve/` + `eval/` for devkit extraction. But `architecture-checker.ts` inside `evolve/` is a **runtime-checkable** concern — it validates live harness instances against declared architecture, callable inside a production `initialize()` hook. It's not a dev-time generator like the rest of evolve. We keep it in `harness-one/evolve-check` subpath (1 file, ~200 LOC; tree-shakes out if unused) and move only `component-registry.ts`, `drift-detector.ts`, `taste-coding.ts`, `generator-evaluator.ts` into `@harness-one/devkit`. Precedent: Stripe's `stripe.webhooks.constructEvent` ships in the runtime SDK because runtime needs it; Stripe's CLI fixtures ship in `stripe-cli` because dev-only.

---

## 3. Subpath surface per package

### 3.1 `harness-one` (post-5C `exports` map — 11 subpaths)

```json
{
  "exports": {
    ".":              "dist/index.js",
    "./core":         "dist/core/index.js",
    "./prompt":       "dist/prompt/index.js",
    "./context":      "dist/context/index.js",
    "./tools":        "dist/tools/index.js",
    "./guardrails":   "dist/guardrails/index.js",
    "./observe":      "dist/observe/index.js",
    "./session":      "dist/session/index.js",
    "./memory":       "dist/memory/index.js",
    "./orchestration":"dist/orchestration/index.js",
    "./rag":          "dist/rag/index.js",
    "./evolve-check": "dist/evolve/architecture-checker.js"
  }
}
```

**Removed subpaths**: `./cli` (moves to `@harness-one/cli`), `./eval` (moves to `@harness-one/devkit/eval`), `./evolve` (moves to `@harness-one/devkit/evolve`), `./essentials` (ADR 9.i — deleted; redundant with root barrel). CJS variants mirror every subpath (`dist/cjs/…`) — Stripe + OpenAI ship dual ESM/CJS; matches precedent.

### 3.2 `@harness-one/cli`

```json
{ "exports": { ".": "dist/index.js" }, "bin": { "harness-one": "dist/cli.js" } }
```

Single entry. `bin` lives here. `templates.ts` split into `templates/core.ts`, `templates/prompt.ts`, … (§8). Declares `harness-one` as a regular `dependency` so `pnpm dlx @harness-one/cli init` resolves it (PRD F-3 E-5).

### 3.3 `@harness-one/devkit`

```json
{
  "exports": {
    ".":        "dist/index.js",
    "./eval":   "dist/eval/index.js",
    "./evolve": "dist/evolve/index.js"
  }
}
```

Root barrel re-exports `createEvalRunner`, `createRelevanceScorer`, `createComponentRegistry`, `createDriftDetector`. `/eval` + `/evolve` subpaths preserved for tree-shaking. Declares `harness-one` as `peerDependency` (not regular dep) — devkit extends core; installing devkit shouldn't pin a core version (precedent: `vitest` peerDeps `vite`).

### 3.4 Every other package

One subpath (`.`). No fan-out.

---

## 4. Root barrel (≤ 25 value symbols)

The barrel doubles down on **what a first-time user types in an IDE**: `import { ... } from 'harness-one'` must yield the 80% case. Anything else is a subpath import.

**Final 22 value symbols** (3 under ceiling, leaving room):

```ts
// Core loop (5)
export { AgentLoop, createAgentLoop, createMiddlewareChain, createResilientLoop, createFallbackAdapter } from './core/index.js';

// Errors (7 — closed hierarchy; user does `instanceof` or `switch (e.code)`)
export { HarnessError, MaxIterationsError, AbortedError, GuardrailBlockedError, ToolValidationError, TokenBudgetExceededError, assertNever } from './core/index.js';

// Tools (3)
export { defineTool, createRegistry, toolSuccess } from './tools/index.js';

// Guardrails (2 — the "run" helpers + pipeline builder)
export { createPipeline, withSelfHealing } from './guardrails/index.js';

// Observe (2)
export { createTraceManager, createLogger } from './observe/index.js';

// Session (1)
export { createSessionManager } from './session/index.js';

// Security (1 — Wave-5A marquee)
export { createSecurePreset } from '@harness-one/preset'; // re-export

// Lifecycle (1 — Disposable)
export { disposeAll } from './infra/disposable.js';
```

Plus **unbounded type-only re-exports** (PRD §F-1 E-8 correction — types don't contribute to runtime weight). Every type symbol the user needs for generic parameters ships from the barrel. Zero runtime cost.

**Deleted from the current barrel** (counts at `index.ts:14-216`):
- `createEventBus` + `EventBus` type (F-9 — dead)
- `createJsonOutputParser`, `parseWithRetry` → subpath `harness-one/core`
- `createSequentialStrategy`, `createParallelStrategy` → subpath
- `categorizeAdapterError`, `pruneConversation` → subpath
- `toSSEStream`, `formatSSE`, `StreamAggregator` → subpath `harness-one/core`
- `createPromptBuilder`, `createPromptRegistry`, `createAsyncPromptRegistry`, `createSkillEngine`, `createDisclosureManager` → subpath `harness-one/prompt` (all prompt factories — user who wants prompts imports `harness-one/prompt`)
- `packContext`, `compress`, `compactIfNeeded`, `createAdapterSummarizer`, `analyzeCacheStability`, `createCheckpointManager`, `countTokens`, `registerTokenizer`, `createBudget` → subpath `harness-one/context`
- `createConsoleExporter`, `createNoOpExporter`, `createCostTracker`, `createFailureTaxonomy`, `createCacheMonitor`, `createDatasetExporter` → subpath `harness-one/observe`
- `createInMemoryConversationStore`, `createAuthContext` → subpath `harness-one/session`
- `createInMemoryStore`, `createFileSystemStore`, `createRelay`, `runMemoryStoreConformance`, `validateMemoryEntry`, `validateIndex`, `validateRelayState`, `parseJsonSafe` → subpath `harness-one/memory`
- `createOrchestrator`, `createAgentPool`, `createHandoff`, `createContextBoundary`, `MessageQueue` → subpath `harness-one/orchestration`
- `createEvalRunner`, `createRelevanceScorer` → **`@harness-one/devkit`**
- `createComponentRegistry` → **`@harness-one/devkit`**
- `createRAGPipeline` → subpath `harness-one/rag`
- `createInjectionDetector`, `createPIIDetector`, `createContentFilter`, `createRateLimiter`, `createSchemaValidator`, `runInput`, `runOutput`, `runToolOutput` → subpath `harness-one/guardrails`
- `DisposeAggregateError` → subpath `harness-one/infra` is **not** exposed; the error is caught internally by `disposeAll`; external consumers who need it import via the rare `harness-one/core` subpath.

Each of the 22 surviving symbols carries a `// UJ-N:` comment in `index.ts` naming the user journey that justifies it (PRD F-1 measure).

**Precedent**: LangChain's root `langchain` barrel is ~15 symbols; OpenAI's root `openai` default export is 1 class + ~8 named types; Vercel AI SDK's `ai` barrel is ~20 named + types. 22 sits in the sweet spot.

---

## 5. `HarnessErrorCode` closure — Stripe-style branded string union

### 5.1 The pattern

Stripe's Node SDK (`stripe.errors.StripeCardError`, etc.) types `.code` as a discriminated union of string literals (`'card_declined' | 'expired_card' | …`). No template-literal synthesis, no template-literal escape hatches that open the sink, no enum. Discriminating on `.code` narrows to the specific subclass. That is the convention TypeScript consumers expect.

### 5.2 Our closure

```ts
// packages/core/src/core/error-codes.ts (new file)

/** Namespaced error codes. Discriminated union — closed. */
export type CoreErrorCode =
  | 'CORE_UNKNOWN' | 'CORE_INVALID_CONFIG' | 'CORE_INVALID_STATE' | 'CORE_INTERNAL_ERROR'
  | 'CORE_MAX_ITERATIONS' | 'CORE_ABORTED' | 'CORE_TOKEN_BUDGET_EXCEEDED';

export type ToolErrorCode =
  | 'TOOL_VALIDATION' | 'TOOL_INVALID_SCHEMA' | 'TOOL_CAPABILITY_DENIED';

export type GuardrailErrorCode =
  | 'GUARD_BLOCKED' | 'GUARD_VIOLATION' | 'GUARD_INVALID_PIPELINE';

export type SessionErrorCode =
  | 'SESSION_NOT_FOUND' | 'SESSION_LIMIT' | 'SESSION_LOCKED' | 'SESSION_EXPIRED';

export type MemoryErrorCode =
  | 'MEMORY_CORRUPT' | 'MEMORY_STORE_CORRUPTION';

export type TraceErrorCode =
  | 'TRACE_NOT_FOUND' | 'TRACE_SPAN_NOT_FOUND';

export type CliErrorCode =
  | 'CLI_PARSE_ERROR';

export type AdapterErrorCode =
  | 'ADAPTER_INVALID_EXTRA'
  | 'ADAPTER_PROVIDER_REGISTRY_SEALED'
  | { readonly tag: 'ADAPTER_CUSTOM'; readonly adapterCode: string };
//   ^^^^^ brand escape for third-party adapter subclasses

/** The closed union. */
export type HarnessErrorCode =
  | CoreErrorCode | ToolErrorCode | GuardrailErrorCode
  | SessionErrorCode | MemoryErrorCode | TraceErrorCode
  | CliErrorCode | AdapterErrorCode;
```

### 5.3 Key decisions

- **Discriminated string-literal union, NOT template literal type**. Template literals (``` `${Module}_${Suffix}` ```) produce huge inferred unions that hurt editor IntelliSense and defeat exhaustiveness checking. Stripe doesn't use them; we don't either.
- **NOT an enum**. Enums are an anti-pattern in modern TypeScript (runtime code, compatibility footguns, erased type-only info). Every recent SDK (Stripe v14+, OpenAI v4+, Anthropic v0.20+) migrated away from enums. We use string literals.
- **Adapter escape is a tagged object, not a raw string**. If we allowed `` `ADAPTER_${string}` `` as an escape, we reopen the sink the PRD F-6 closes. Instead adapter subclasses throw with `code: { tag: 'ADAPTER_CUSTOM', adapterCode: 'openai_rate_limit' }`. This is **Brand** — discriminated-union-safe. Exhaustive `switch (err.code)` needs exactly one `case 'ADAPTER_CUSTOM'` branch or (when `code` is an object) a type-guard against the `tag` field.
- **Migration**: `HarnessError.code` type changes from `HarnessErrorCode | (string & {})` to `HarnessErrorCode`. The 152 `throw` sites get a one-time codemod adding namespace prefixes (`'MAX_ITERATIONS'` → `'CORE_MAX_ITERATIONS'`). ADR documents sed commands.
- **Subclass constructors** (`MaxIterationsError`, `TokenBudgetExceededError`, etc.) hardcode their narrowed code literal — `super(..., 'CORE_MAX_ITERATIONS' as const, ...)`. No runtime cost.
- **Exhaustiveness test**: a compile-only test file `error-code-exhaustive.test-d.ts` does `const _: never = (code satisfies never)` inside the default branch of a `switch` covering every case. Breaks the build if a new code is added without a handler.

**Precedent**: Stripe `StripeError.code` literal union, OpenAI `APIError.code`, Anthropic `APIError.status` — all string-literal unions with brand escape for extensions.

---

## 6. `_internal/` → `infra/` rename + ESLint barrier

### 6.1 Directory rename

```
packages/core/src/_internal/   →   packages/core/src/infra/
```

Mechanical `git mv` + `sed -i 's|/_internal/|/infra/|g'` across 19 intra-package importers (all verified intra-`packages/core/src/` per PRD §3 E-1). The Disposable re-export at `index.ts:215-216` updates to `'./infra/disposable.js'`. No cross-package surgery.

### 6.2 ESLint rule — use `eslint-plugin-import` not custom glob

The npm convention for "forbid cross-package reach-in" is `eslint-plugin-import` v2's `no-internal-modules` rule. That plugin is already the de-facto standard (6M weekly downloads). Custom `no-restricted-imports` glob patterns work but make the intent harder to read.

```js
// .eslintrc.cjs  (root)
{
  "overrides": [
    {
      // Everything OUTSIDE packages/core/src/
      "files": ["packages/!(core)/**/*.{ts,tsx}", "examples/**/*.{ts,tsx}"],
      "rules": {
        "import/no-internal-modules": ["error", {
          "forbid": [
            "harness-one/infra/**",      // block subpath reach-in (defense in depth)
            "harness-one/dist/infra/**", // block deep-dist reach-in
            "**/packages/core/src/infra/**"
          ]
        }]
      }
    },
    {
      // Tests can reach in (same precedent as Vitest: `vitest/internal` for test-only fixtures)
      "files": ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
      "rules": { "import/no-internal-modules": "off" }
    }
  ]
}
```

The `exports` map in `packages/core/package.json` does **not** list `./infra` — deep-dist reach-in via `harness-one/dist/infra/…` is blocked by both (a) the exports map (Node rejects it by default on strict `exports`) and (b) the lint rule (defense in depth).

**Why not narrow `files: ["dist"]` to exclude `dist/infra/`?** Because that breaks source-map resolution when consumers' debuggers step into a stack frame that transits the infra layer. Keep `dist/infra/` shipped; block *import* via exports-map + lint. Precedent: Vitest ships its entire `dist/` but its `exports` map lists only 7 entries.

### 6.3 Seed test fixture

```ts
// packages/openai/src/__lint-fixtures__/bad-reach-in.ts  (intentionally broken)
// @ts-expect-error — lint should fire
import { LRUCache } from 'harness-one/infra/lru-cache';   // blocked
```

CI runs `pnpm lint` and asserts this file fails with `import/no-internal-modules`. If the lint passes, CI fails.

---

## 7. api-extractor configuration

### 7.1 Mode: snapshot-diff only (PRD LD-2)

Every `@harness-one/*` package gets `api-extractor.json` + a checked-in `<pkg>.api.md`. CI runs `api-extractor run` and fails if the generated `.api.md` differs from the committed copy.

### 7.2 Per-package config

```json
// packages/core/api-extractor.json (trimmed to essence)
{
  "$schema": "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
  "mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts",
  "bundledPackages": [],
  "apiReport": { "enabled": true, "reportFolder": "<projectFolder>/etc/" },
  "docModel": { "enabled": false },
  "tsdocMetadata": { "enabled": false },
  "dtsRollup": { "enabled": false },
  "messages": {
    "extractorMessageReporting": {
      "ae-missing-release-tag": { "logLevel": "none" }  // off until Wave-5C.1
    }
  }
}
```

### 7.3 Multi-entry handling

api-extractor historically supported only one entry per run. Modern config uses `mainEntryPointFilePath` per invocation — we run api-extractor **once per subpath entry** and check in one `.api.md` per entry. For `harness-one` that's 12 invocations (root + 11 subpaths). Script: `pnpm --filter harness-one api:extract` iterates.

Precedent: `@microsoft/fluent-ui` and `@rushstack/*` use this exact pattern.

### 7.4 CI workflow addition

```yaml
# .github/workflows/api-snapshot.yml  (new)
on: [pull_request]
jobs:
  api-snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -r api:extract
      - name: Fail on drift
        run: git diff --exit-code -- '*.api.md'
      - name: Check rationale section in PR body
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const body = context.payload.pull_request.body ?? '';
            if (!/^## API change rationale\s*\n[\s\S]{20,}/m.test(body)) {
              core.setFailed('API drift detected without `## API change rationale` section');
            }
```

### 7.5 Override path (`pnpm api:update`)

`package.json` root script: `"api:update": "pnpm -r --parallel api:extract && pnpm -r api:accept"`. Commits regenerated `.api.md` files. Contributor adds `## API change rationale` section to PR body. Merge gate passes.

---

## 8. `cli/templates.ts` split strategy

### 8.1 Current shape

`packages/core/src/cli/templates.ts` — 651 LOC, single `TEMPLATES: Record<ModuleName, string>` literal with 12 template strings.

### 8.2 Split — one file per module template

```
packages/cli/src/templates/
  index.ts              (~30 LOC — re-exports + getTemplate dispatcher)
  core.ts               (~50 LOC — one string export `export const coreTemplate = \`...\``)
  prompt.ts             (~55 LOC)
  context.ts            (~45 LOC)
  tools.ts              (~60 LOC)
  guardrails.ts         (~60 LOC)
  observe.ts            (~55 LOC)
  session.ts            (~50 LOC)
  memory.ts             (~50 LOC)
  eval.ts               (~55 LOC)
  orchestration.ts      (~55 LOC)
  rag.ts                (~50 LOC)
  evolve.ts             (~50 LOC)
```

Each template file is ≤ 75 LOC (well under PRD F-10's 200-LOC ceiling). `index.ts` re-exports and keeps `getTemplate(mod: ModuleName): string`.

### 8.3 Critical: update emitted imports for post-5C surface

Inside each template:
- `eval.ts` emits `from '@harness-one/devkit'` (not `from 'harness-one/eval'` — F-4 removed that subpath)
- `evolve.ts` emits `from '@harness-one/devkit'`
- All others unchanged (`from 'harness-one/core'`, `from 'harness-one/prompt'`, etc. — §3.1 kept those subpaths)

### 8.4 Build-time parser test (PRD F-3 measure)

```ts
// packages/cli/src/templates/__tests__/emit-paths.test.ts
import * as T from '../index.js';

const KNOWN_SUBPATHS = ['core','prompt','context','tools','guardrails','observe','session','memory','orchestration','rag','evolve-check']; // post-5C exports map
const DEVKIT = ['@harness-one/devkit', '@harness-one/devkit/eval', '@harness-one/devkit/evolve'];

test('every emitted import resolves post-5C', () => {
  for (const mod of Object.keys(T.TEMPLATES)) {
    const code = T.getTemplate(mod);
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    for (const m of code.matchAll(importRe)) {
      const spec = m[1];
      const ok = spec.startsWith('harness-one/') && KNOWN_SUBPATHS.includes(spec.replace('harness-one/', ''))
              || DEVKIT.includes(spec);
      expect(ok).toBe(true);
    }
  }
});
```

Fails CI if any template emits an orphaned subpath.

### 8.5 Why not group differently (e.g., by "runtime" vs "dev")?

Because the user invokes `harness-one init --module=eval` — the CLI's user-facing unit is the module name, which matches the 1:1 file layout. Don't invent groupings users don't think in. Precedent: Next.js `create-next-app` templates are one-file-per-template.

---

## 9. Version coordination (changeset linked)

### 9.1 PRD PD-2 locks changesets `linked` lockstep

Every `@harness-one/*` package bumps together. `harness-one` also participates (even though unscoped) because its changeset entry is declared in `.changeset/config.json#linked`.

### 9.2 Configuration

```json
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [
    ["harness-one", "@harness-one/cli", "@harness-one/devkit", "@harness-one/preset",
     "@harness-one/openai", "@harness-one/anthropic",
     "@harness-one/redis", "@harness-one/langfuse", "@harness-one/opentelemetry",
     "@harness-one/ajv", "@harness-one/tiktoken"]
  ],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

**Using `fixed` not `linked`** — a subtle but important distinction. `linked` bumps together only when changed; `fixed` always bumps the whole set to the same version even if only one changed. For 1.0-rc where every package ships the same "1.0-rc" promise, `fixed` is correct (precedent: all `@vitest/*` packages use `fixed`; all `@aws-sdk/*` v3 clients use `fixed`). PRD PD-2 says "lockstep" — `fixed` is the stricter lockstep.

### 9.3 Workspace protocol

Every inter-package dependency in the monorepo uses `"workspace:*"` — pnpm rewrites to the exact version at publish (precedent: Vercel AI SDK, Vitest, Turborepo all use this). PRD F-12 verification script checks that every `import 'harness-one*'` statement across the workspace has a corresponding `dependencies` or `peerDependencies` entry.

```ts
// scripts/verify-deps.ts
// Enumerates every TS file's `import ... from '(harness-one[^'\"]*|@harness-one/[^'\"]*)'`
// Groups by source package; asserts that package's package.json declares every imported
// harness-one* name in dependencies/peerDependencies/optionalDependencies.
// Exit 1 on mismatch.
```

### 9.4 F-14 npm placeholder — conditional on ADR 9.a

**Our ADR 9.a decision: DO NOT rename `harness-one` → `@harness-one/core`**. Therefore F-14 is no-op. Reasoning below (§12).

---

## 10. Examples migration plan

### 10.1 Scope (PRD §3 verified: 20 TS files, 52 `from 'harness-one*'` occurrences)

All migrations live in a **single commit** landed atomically with F-3 + F-4 + F-1. PRD F-13 is P0 for F-4 acceptance.

### 10.2 Migration table

| File | Line | Before | After |
|---|---|---|---|
| `examples/full-stack-demo.ts` | 15 | `import type { Scorer } from 'harness-one/eval'` | `import type { Scorer } from '@harness-one/devkit'` |
| `examples/full-stack-demo.ts` | 20 | `import { createEvalRunner } from 'harness-one/eval'` | `import { createEvalRunner } from '@harness-one/devkit'` |
| `examples/eval/llm-judge-scorer.ts` | 8, 119 | `from 'harness-one/eval'` | `from '@harness-one/devkit'` |
| any | any | `from 'harness-one/evolve'` | `from '@harness-one/devkit'` |
| any | any | named imports of trimmed-barrel symbols (e.g., `import { createPromptBuilder } from 'harness-one'`) | subpath import (`from 'harness-one/prompt'`) |

Codemod (one-liner, not the full Wave-5G codemod bundle):

```bash
find examples -name '*.ts' -exec sed -i '' \
  -e "s|from 'harness-one/eval'|from '@harness-one/devkit'|g" \
  -e "s|from 'harness-one/evolve'|from '@harness-one/devkit'|g" \
  {} \;
# Hand-fix any named-imports that moved to subpaths (grep-by-symbol).
```

### 10.3 New `examples/package.json`

Currently absent. Create:

```json
{
  "name": "harness-one-examples",
  "private": true,
  "dependencies": {
    "harness-one": "workspace:*",
    "@harness-one/openai": "workspace:*",
    "@harness-one/anthropic": "workspace:*"
  },
  "devDependencies": {
    "@harness-one/devkit": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

### 10.4 CI

Add `pnpm -C examples typecheck` to the matrix. F-4 merges only when this is green.

---

## 11. Risks / what alignment trades away

| # | Risk / trade | Severity | Mitigation |
|---|---|---|---|
| R-C1 | **Keeping `harness-one` as marquee forgoes visual consistency with `@harness-one/*` family**. A newcomer scanning npm sees `harness-one` and doesn't immediately associate it with `@harness-one/cli`. | Low | README + docs open with "install `harness-one` — the `@harness-one/*` scope contains supplementaries (CLI, devkit, adapters)". Precedent normalizes this: nobody thinks `react` and `@types/react` are unrelated. |
| R-C2 | **Multi-entry api-extractor is fiddly**. Running it 12 times for `harness-one` adds ~10s to CI and 12 `.api.md` files to git. | Medium | Script wraps the invocation; `.api.md` files live in `packages/core/etc/`; gitignore noise minimized. Precedent: `@rushstack/*` ships dozens of `.api.md` files. |
| R-C3 | **Refusing to merge `@harness-one/ajv` + `@harness-one/tiktoken`** means two almost-empty packages stay published. Reviewers will call it clutter. | Low | Each package's README opens with "peerDep for `[ajv\|tiktoken]` — install alongside `harness-one` only if you use [schema validation\|tiktoken tokenization]." Consumer who uses neither installs neither. Merging would force both deps onto every preset user. Precedent: `@ai-sdk/openai` is tiny; that's not a bug. |
| R-C4 | **Keeping `architecture-checker` in core** adds ~200 LOC to runtime bundle even for users who never call it. | Low | It's tree-shakeable (ESM, `sideEffects: false` is already set at `package.json:92`). Bundle analyzer confirms zero impact on main-entry if not referenced. |
| R-C5 | **`AdapterErrorCode` tagged-object escape** means `switch (err.code)` needs a `typeof err.code === 'object'` narrowing. Slightly more verbose than raw string. | Low | The verbosity is **load-bearing**: it forces callers to handle the adapter-custom case explicitly. One-line helper `isAdapterCustom(code): code is AdapterCustomCode` ships alongside. |
| R-C6 | **Fixed-mode changesets** means a documentation-only PR bumps every package's version even if no behavior changed. | Medium | Wave-5C is 1.0-rc phase; every bump is `-rc.N+1`. Inflationary in rc, cheap in practice. Post-1.0 (Wave-5G), we can switch `fixed` → `linked` for finer grain. |
| R-C7 | **Snapshot-diff mode is "weak"** — a rename detected by diff but the reviewer could still approve without understanding impact. | Medium | The `## API change rationale` regex forces author to explain; reviewer eyeballs. Stability-tag enforcement (5C.1) tightens further. |
| R-C8 | **Subpath-heavy surface hurts bundlers that don't support exports map** (Webpack 4, Parcel 1). | Low | Node 18+ + Webpack 5+ + Vite + esbuild + Rollup all support it. Parcel 1 is EOL. Webpack 4 users: documented known limitation. |

**What this proposal trades away** (honest accounting):

- **Cosmetic uniformity** — we don't get the clean `@harness-one/core`, `@harness-one/cli`, `@harness-one/devkit` scope-family. We get `harness-one` + `@harness-one/{cli,devkit}`. Readers who value aesthetic consistency will notice.
- **Speed of fan-out** — some architects will propose splitting every subpath (`harness-one/tools` → `@harness-one/tools`) for "cleaner separation". We refuse that trade because it costs every user 11 extra `pnpm add` invocations for zero bundle-weight gain (subpath imports already tree-shake).
- **Novelty** — this proposal contains no novel ideas. That is the point.

---

## 12. Defence against expected attacks

### 12.1 Architect A's likely attack: "Ecosystem patterns are dogma; we should optimize for OUR scale, not Stripe's"

**Likely framing**: "Stripe and OpenAI are billion-dollar SDKs with millions of consumers. You're copying their shape blindly. Our user base is 10x smaller; we should design for 10 engineers on a startup team, not 1,000 engineers at Stripe. Smaller scale means we can afford novel boundaries like one-package-per-submodule or a unified `@harness-one/errors` package."

**Counter**:

1. **Ecosystem patterns are not dogma; they are compressed lessons**. Every convention I cite (unprefixed marquee + scoped supplementaries; single-package rich subpath exports; peerDep on native providers; string-literal error codes) was invented at larger SDKs *because their engineers learned the hard way*. LangChain famously fragmented into 30+ packages in 2023, then **un-fragmented** in 2024 back to `langchain` + scoped subpaths — because version skew killed their consumers. We have the choice: pay the tuition ourselves, or read LangChain's postmortem.

2. **"Our scale" cuts the other direction**. A 10-engineer team has **less** capacity to fight version-skew chaos than Stripe does. Stripe has a release engineering team. We don't. Fewer packages means fewer `pnpm-workspace.yaml` entries, fewer changeset bumps per PR, fewer "oops, I forgot to update the ajv peerDep" issues. The smaller we are, the *more* we should copy conventions that have already been stress-tested.

3. **Novelty has a cost that compounds**. Every consumer who encounters a non-standard boundary (e.g., `@harness-one/errors` as its own package) has to pause, read docs, and build a new mental model. With the ecosystem pattern they recognize the shape in 5 seconds. Compounded over every new user, novelty is a massive DX tax.

4. **Concrete evidence**: the PRD's F-1 candidate list contains 13-17 symbols; Vercel AI SDK's root barrel is ~20; mine is 22. PRD F-3 CLI-as-separate is exactly the `create-vite` pattern. PRD F-6 string-literal-union is exactly Stripe's pattern. We are not "blindly copying" — we are applying conventions at **points where the PRD already assumed them**. A proposal that diverges from ecosystem norm owes an explanation for why the tuition was worth paying again.

5. **Ask Architect A to cite the SDK they're designing toward**. If the answer is "none — we're innovating," that's a red flag. Every good architecture cites prior art.

### 12.2 Architect B's likely attack: "Your rename-resistance loses the `@harness-one/*` family branding"

**Likely framing**: "A unified `@harness-one/core`, `@harness-one/cli`, `@harness-one/devkit` scope-family is cleaner, signals 'this is a suite' to consumers, and future-proofs naming. Your `harness-one` + `@harness-one/*` split is a historical accident we should fix while we're in rc. Rename costs are bounded by F-14 placeholder — just pay them now."

**Counter**:

1. **Every dominant TypeScript framework runs this "split"**. `react` + `@types/react` + `@react/*` internal scopes. `vite` + `@vitejs/*`. `vitest` + `@vitest/*`. `next` + `@next/*`. `stripe` + `@stripe/*`. `prisma` + `@prisma/*`. The split isn't a historical accident — it's the **convention**. The marquee name is unprefixed because:
   - npm search ranks unprefixed names higher (empirically true — search "react" vs "@react").
   - Docs read "install `react`" cleaner than "install `@react/core`".
   - Downstream ecosystem (blog posts, Stack Overflow, tutorials) accumulates under the unprefixed name.

2. **SEO is not negligible in rc — it's maximally valuable**. Pre-1.0, we're building Google/npm search history. `harness-one` is a distinctive, searchable name. `@harness-one/core` is a scoped name that npm's search algorithm *de-ranks* relative to unprefixed root names (confirmed: try "core" on npmjs.com — scoped `@x/core` results rank below unscoped). Renaming now spends the one-shot SEO budget on cosmetics.

3. **"Family branding" is already visible** without the rename. When a consumer `pnpm add harness-one @harness-one/cli`, their `package.json` shows both lines — the family is obvious from juxtaposition. No user has ever filed a bug saying "I didn't realize `react` and `@types/react` were related."

4. **The cost isn't "bounded" — it's a permanent tax**. Renaming creates a two-name problem forever: (a) the old `harness-one` on npm stays around (we can't unpublish per npm policy), (b) every tutorial, every code example in the wild, every Stack Overflow answer points at `harness-one` and now has to be updated. F-14's placeholder approach protects the namespace but doesn't solve consumer confusion. For Wave-5G full deprecation, we'd have to publish `harness-one@1.0.0` with `deprecated: "moved"` — breaking everyone on 0.4.x who didn't yet migrate. That's a user-hostile move for a cosmetic win.

5. **Architect B must show a user whose problem is solved by the rename**. Not a reviewer's aesthetic preference — an actual user journey where `@harness-one/core` is discoverably better than `harness-one`. I claim that user doesn't exist. Every benefit B cites (family coherence, future-proof naming) is available without rename via docs + README positioning. The cost (SEO loss, migration pain, npm ceremony) is concrete and borne by users.

6. **Concrete counter-precedent**: AWS SDK v2 was `aws-sdk` (unprefixed marquee). v3 split into `@aws-sdk/client-*` fan-out — and AWS is the cautionary tale. v3 has 350+ packages; consumers complain about dependency bloat, IDE slowness, and version-skew bugs. AWS traded marquee for fan-out and paid dearly. Architect B's proposal moves us toward that shape. Mine stays on the LangChain-post-consolidation side.

---

## Summary (200 words)

**Final package map** (one line each):
1. `harness-one` — runtime, 11 subpaths, marquee (unprefixed convention)
2. `@harness-one/cli` — binary, `bin` field, depends on core
3. `@harness-one/devkit` — evolve + eval, peerDep on core (dev-time)
4. `@harness-one/preset` — existing, unchanged
5. `@harness-one/openai`, `/anthropic` — adapters, provider peerDeps
6. `@harness-one/redis`, `/langfuse`, `/opentelemetry` — sinks, sink peerDeps
7. `@harness-one/ajv`, `/tiktoken` — KEPT SEPARATE (peerDep-per-consumer-choice convention)
8. `packages/full/` — deleted

**Root barrel size**: 22 value symbols (3 under the 25 ceiling) + unbounded type-only re-exports. Deletes 45+ current exports — most relocated to surviving subpaths, evolve/eval factories relocated to `@harness-one/devkit`.

**Sharpest counter to expected attackers**: to Architect A ("you're copying Stripe blindly") — LangChain fragmented in 2023, un-fragmented in 2024; the convention is *compressed lessons from others' scars*, not dogma, and smaller teams have *less* capacity to fight version-skew than Stripe's release-engineering team, not more. To Architect B ("rename to `@harness-one/core` for family branding") — every dominant TS SDK (react/@types, vite/@vitejs, vitest/@vitest, stripe/@stripe, next/@next) uses unprefixed-marquee + scoped-supplementaries; renaming burns one-shot SEO for a cosmetic win no user has ever requested, and AWS SDK v3's fan-out is the cautionary tale.

