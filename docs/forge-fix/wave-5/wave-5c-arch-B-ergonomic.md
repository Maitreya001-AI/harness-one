# Wave-5C Architecture — Proposal B: Consumer Ergonomics First

**Architect**: B — "Consumer Ergonomics First"
**Date**: 2026-04-15
**Branch**: `wave-5/production-grade`
**PRD**: `docs/forge-fix/wave-5/wave-5c-prd-v2.md` (LOCKED)
**Status**: Competing (Round 1)
**Prior**: Different from Architect A by construction — I optimize for the SDK consumer, not for monorepo maintenance cost.

---

## 1. Position Statement

Every line of `package.json` an SDK consumer reads is a promise. `harness-one@0.4` today ships a single install whose `exports` map has 14 subpaths, whose `bin` lives in the same package as the runtime, whose `_internal/` directory is shipped to `dist/` with no lint wall around it, and whose error-code taxonomy is open to any string. That shape is legible only to its authors. A developer opening `npm view harness-one` cannot tell which subpath is load-bearing, cannot tell what runs in the browser vs Node, cannot tell what is dev-time vs production. 1.0-rc is the last moment we can fix this without a second major.

My design prior is that **every package name an SDK consumer types is a reasoning handle**. `@harness-one/core` tells a consumer "this is the runtime I deploy"; `@harness-one/cli` tells them "this is my scaffolder"; `@harness-one/devkit` tells them "this is what I put in `devDependencies`". I will accept more packages, a rename ceremony, and slightly higher CI cost as the price of import lines that read as intent. Architect A will argue the opposite — that fewer packages reduce fan-out. The difference is philosophical: A optimizes for the authoring experience, I optimize for the reading experience. Packages are read a thousand times more than they are published.

---

## 2. Package Map

**Final shape — 11 published packages (up from today's 10; `packages/full/` deleted, `cli` + `devkit` added)**

| Package | Kind | Dep role | One-line purpose |
|---|---|---|---|
| `@harness-one/core` | runtime | `dependency` | The agent loop, tools, guardrails, observability ports, sessions, memory, prompt, context, orchestration, rag. Renamed from `harness-one`. |
| `@harness-one/cli` | binary | `devDependency` (or `pnpm dlx`) | `harness-one` scaffolder. Owns `bin`, owns `templates.ts` split. Depends on `@harness-one/core` as a regular dep so `pnpm dlx` resolves. |
| `@harness-one/devkit` | dev-time | `devDependency` | `createEvalRunner`, `createComponentRegistry`, `createRelevanceScorer`, architecture-checker. Never in prod trees. |
| `@harness-one/preset` | runtime | `dependency` | `createHarness`, `createSecurePreset`. Unchanged; `eventBus` deleted. |
| `@harness-one/openai` | adapter | `dependency` | OpenAI adapter. Unchanged. |
| `@harness-one/anthropic` | adapter | `dependency` | Anthropic adapter. Unchanged. |
| `@harness-one/redis` | adapter | `dependency` | Redis session/memory store. Unchanged. |
| `@harness-one/langfuse` | adapter | `dependency` | Langfuse exporter. Unchanged. |
| `@harness-one/opentelemetry` | adapter | `dependency` | OTel exporter. Unchanged. |
| `@harness-one/ajv` | native-dep | `dependency` (opt-in) | Ajv-backed schema validator. **Kept separate.** |
| `@harness-one/tiktoken` | native-dep | `dependency` (opt-in) | Tiktoken-backed tokenizer. **Kept separate.** |

**Deleted**: `packages/full/` (no `package.json`, E-3 confirmed unreachable).

**Key opinion (diverging from Architect A)**:

1. **`harness-one` → `@harness-one/core` rename.** Painful once, clarifying forever. A consumer scanning npm search sees the whole family (`@harness-one/*`) in one cluster. `harness-one@0.x` is untouched on the registry; `@harness-one/core@1.0.0-placeholder.0` reserves the name (F-14 conditional, ADR 9.a = rename). Wave-5G does the full deprecation dance on the old name.
2. **`@harness-one/ajv` and `@harness-one/tiktoken` stay separate.** Merging them hides the native-dep cost. `ajv` pulls `ajv-formats` and a JSON-schema runtime; `tiktoken` pulls a WASM binary. A consumer who needs only token counting should not pay for JSON-schema machinery, and vice versa. They have *different* peerDep stories (Ajv is synchronous, Tiktoken is async-init via WASM). A merged `@harness-one/native-deps` would force us to write a README explaining "you get one or both; opt out via tree-shaking"; separation turns that into two `package.json` lines a consumer can reason about.
3. **`@harness-one/devkit` is its own package, not a subpath.** `eval` + `evolve` + `architecture-checker` are dev-time. If they sit as `harness-one/eval` and `harness-one/evolve` subpaths, the root `dependencies` graph of `@harness-one/core` stays tangled with evaluation harnesses. A `devDependency` label is the only honest signal that "this is not in your Lambda cold-start."
4. **`@harness-one/cli` is its own package, not a subpath.** Same logic: `bin` + `devDep` = unambiguous. `pnpm dlx @harness-one/cli init` is prettier than `pnpm dlx harness-one init` because the scope tells the consumer "this is tooling". The rename + extraction land together.

---

## 3. Subpath Surface per Package

### 3.1 `@harness-one/core` exports map (after F-1/F-3/F-4)

| Subpath | Purpose | Exports (condensed) |
|---|---|---|
| `.` (root barrel) | Curated ≤ 25 value entry | See §4 |
| `./core` | Agent loop + errors | `AgentLoop`, `createAgentLoop`, `HarnessError*`, middleware, SSE, parser, event bus helpers, StreamAggregator |
| `./tools` | Tool registry | `defineTool`, `createRegistry`, `toolSuccess`/`toolError`, types |
| `./guardrails` | Guardrail pipeline | `createPipeline`, detectors, `runInput`/`runOutput`/`runToolOutput` |
| `./prompt` | Prompt builders | `createPromptBuilder`, registries, skills, disclosure |
| `./context` | Context packing | `packContext`, `compress`, `countTokens`, `createBudget` |
| `./observe` | Traces/logs/costs | `createTraceManager`, `createLogger`, `createCostTracker`, exporters, failure taxonomy |
| `./session` | Sessions + auth | `createSessionManager`, `createAuthContext`, stores |
| `./memory` | Memory stores + relay | `createInMemoryStore`, `createFileSystemStore`, `createRelay`, conformance |
| `./orchestration` | Multi-agent | `createOrchestrator`, `createAgentPool`, `createHandoff`, `MessageQueue` |
| `./rag` | RAG pipeline | `createRAGPipeline` |

**Removed from `@harness-one/core`**: `./cli`, `./eval`, `./evolve`, `./essentials`.

**`./essentials` fate (ADR 9.i/9.j): DELETE.** It is a third legitimate entry for the same symbols the root barrel serves. An ergonomics-first design does not keep three entries for one surface. One canonical root, one canonical per-domain subpath, nothing else.

Final `exports` count on `@harness-one/core`: **11 subpaths** (down from 14). Counts per PRD §9.k.

### 3.2 `@harness-one/cli` exports map

| Subpath | Purpose |
|---|---|
| `.` | Thin programmatic entry (for tests + consumers who want to embed scaffolding) — `runCli`, `getTemplate` |
| `./bin/harness-one` | `bin` target |

`package.json#bin = { "harness-one": "./dist/bin/harness-one.js" }`. We keep the binary command-name `harness-one` because that is the muscle-memory; only the *package* name changes. Consumer still types `npx harness-one init` or `pnpm dlx @harness-one/cli init`.

### 3.3 `@harness-one/devkit` exports map

| Subpath | Purpose |
|---|---|
| `.` | Curated dev entry: `createEvalRunner`, `createRelevanceScorer`, `createComponentRegistry` |
| `./eval` | Eval runner + scorers + types |
| `./evolve` | Component registry, drift detector, taste-coding, architecture-checker |
| `./arch-check` | Standalone architecture-checker (for CI use) |

Rationale for two subpaths under one package: `eval` and `evolve` are conceptually distinct but share a dev-time lifecycle; splitting them into two packages would double the devDep install line without buying independent use. A consumer who only wants eval imports from `@harness-one/devkit/eval`.

---

## 4. Root Barrel (≤ 25 Value Exports)

**`@harness-one/core/src/index.ts` — 22 value exports, unbounded type re-exports**

Each line carries a one-line rationale comment (PRD F-1 mandate). All 22 are symbols an SDK consumer would need inside the first 30 minutes of reading the README.

```ts
// ── Agent loop (the headline primitive) ─────────────────────────────────
export { AgentLoop, createAgentLoop } from './core/index.js';

// ── Error taxonomy (for try/catch at any level) ─────────────────────────
export {
  HarnessError,              // base — every consumer catches this
  MaxIterationsError,        // common loop exit
  AbortedError,              // AbortController path
  GuardrailBlockedError,     // guardrail pipeline verdict
  ToolValidationError,       // tool-call schema miss
  TokenBudgetExceededError,  // budget ceiling
  HarnessErrorCode,          // enum — runtime-introspectable
} from './core/index.js';

// ── Tools (defining + registering, the 2-function minimum) ──────────────
export { defineTool, createRegistry } from './tools/index.js';

// ── Guardrails (pipeline + 3 run helpers — 1 slot via namespace) ────────
export { createPipeline } from './guardrails/index.js';
export * as guardrails from './guardrails/run-helpers.js';
  // exposes runInput / runOutput / runToolOutput as guardrails.runInput etc.

// ── Observability (the 3 factories 80% of apps need) ────────────────────
export { createTraceManager, createLogger, createCostTracker } from './observe/index.js';

// ── Session (the primitive, not the store choices) ──────────────────────
export { createSessionManager } from './session/index.js';

// ── Prompt (the builder; registries live at subpath) ────────────────────
export { createPromptBuilder } from './prompt/index.js';

// ── Composition (middleware + resilient wraps — 2 slots) ────────────────
export { createMiddlewareChain, createResilientLoop } from './core/index.js';

// ── Disposable lifecycle (ARCH-005 primitive) ───────────────────────────
export { disposeAll } from './infra/disposable.js';
export type { Disposable } from './infra/disposable.js';
```

**Count: 22 value exports.** 3 slots held in reserve for adapter re-exports (ADR 9.a may decide to re-export `createOpenAIAdapter`, `createAnthropicAdapter` for discoverability — that consumes 2 of the 3 reserve slots; 1 remains for a future headline primitive).

**Diverging from A deliberately**:
- **I re-export `HarnessErrorCode` at root.** A consumer writing `switch (err.code)` should not need a subpath import for the enum keys. The runtime-introspectability of the enum (see §5) is exactly the kind of thing that belongs in the root 25.
- **I use `export * as guardrails`** to fold 3 symbols into 1 slot, preserving `guardrails.runInput(...)` as a call site. Architect A will likely list them flat and eat 3 of 25 slots. My namespace is opinionated — it also signals "these three are sibling helpers, not independent primitives."
- **I drop `createFallbackAdapter`, `createEventBus`, `createSequentialStrategy`, `createParallelStrategy`, `toSSEStream`, `formatSSE`, `pruneConversation`, `categorizeAdapterError`, `assertNever`, `createJsonOutputParser`, `parseWithRetry`, `StreamAggregator`** from the root barrel. All remain on `./core` subpath for advanced users. They are not day-one symbols.
- **Type re-exports unbounded** (PRD F-1 E-8 correction): all 40+ types currently at root stay, because type exports cost zero runtime bytes and give IDE autocomplete.

---

## 5. HarnessErrorCode Closure — Enum-based

**Diverging from Architect A's expected template-literal-union approach.**

A consumer writing an error handler today would like to do:

```ts
if (Object.values(HarnessErrorCode).includes(err.code as HarnessErrorCode)) { ... }
```

That is **impossible** with a template-literal union. It requires a runtime value. Therefore **I propose a TypeScript `enum`**, not a type-only union:

```ts
// packages/core/src/core/errors.ts
export enum HarnessErrorCode {
  // ── CORE_* — agent loop & runtime invariants ──────────────────────
  CORE_UNKNOWN = 'CORE_UNKNOWN',
  CORE_INVALID_CONFIG = 'CORE_INVALID_CONFIG',
  CORE_INVALID_STATE = 'CORE_INVALID_STATE',
  CORE_INTERNAL = 'CORE_INTERNAL',
  CORE_MAX_ITERATIONS = 'CORE_MAX_ITERATIONS',
  CORE_ABORTED = 'CORE_ABORTED',
  CORE_TOKEN_BUDGET_EXCEEDED = 'CORE_TOKEN_BUDGET_EXCEEDED',

  // ── TOOL_* ────────────────────────────────────────────────────────
  TOOL_VALIDATION = 'TOOL_VALIDATION',
  TOOL_INVALID_SCHEMA = 'TOOL_INVALID_SCHEMA',
  TOOL_CAPABILITY_DENIED = 'TOOL_CAPABILITY_DENIED',

  // ── GUARD_* ───────────────────────────────────────────────────────
  GUARD_BLOCKED = 'GUARD_BLOCKED',
  GUARD_VIOLATION = 'GUARD_VIOLATION',
  GUARD_INVALID_PIPELINE = 'GUARD_INVALID_PIPELINE',

  // ── SESSION_* ─────────────────────────────────────────────────────
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_LIMIT = 'SESSION_LIMIT',
  SESSION_LOCKED = 'SESSION_LOCKED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  // ── MEMORY_* ──────────────────────────────────────────────────────
  MEMORY_CORRUPT = 'MEMORY_CORRUPT',
  MEMORY_STORE_CORRUPTION = 'MEMORY_STORE_CORRUPTION',

  // ── TRACE_* ───────────────────────────────────────────────────────
  TRACE_NOT_FOUND = 'TRACE_NOT_FOUND',
  TRACE_SPAN_NOT_FOUND = 'TRACE_SPAN_NOT_FOUND',

  // ── CLI_* ─────────────────────────────────────────────────────────
  CLI_PARSE_ERROR = 'CLI_PARSE_ERROR',

  // ── ADAPTER_* (escape hatch lives here) ───────────────────────────
  ADAPTER_INVALID_EXTRA = 'ADAPTER_INVALID_EXTRA',
  ADAPTER_CUSTOM = 'ADAPTER_CUSTOM',

  // ── PROVIDER_* ────────────────────────────────────────────────────
  PROVIDER_REGISTRY_SEALED = 'PROVIDER_REGISTRY_SEALED',
}
```

And the `HarnessError` constructor signature closes to:

```ts
export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly code: HarnessErrorCode,
    public readonly suggestion?: string,
    public override readonly cause?: Error,
    /** For ADAPTER_CUSTOM only. Carries adapter-specific sub-code. */
    public readonly details?: { adapterCode?: string; [k: string]: unknown },
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
```

**Migration from `errors.ts:71`** (`public readonly code: HarnessErrorCode | (string & {})`): all 24 existing string-literal codes map 1:1 to enum members (rename `'UNKNOWN'` → `CORE_UNKNOWN`, etc.); all 152 throw sites in `packages/core/src/` (PRD §3 verified) update mechanically via codemod. Adapter packages (`@harness-one/openai`, etc.) use `HarnessErrorCode.ADAPTER_CUSTOM` + `details.adapterCode = 'OPENAI_RATE_LIMITED'`.

**Why enum (not template literal union, not `as const` object)**:

| Approach | Runtime value? | Reverse lookup? | IDE autocomplete? | Exhaustive switch? |
|---|---|---|---|---|
| template-literal union | no | no | yes | yes |
| `as const` object | yes | manual | yes | yes (via `typeof obj[keyof typeof obj]`) |
| **enum** | **yes** | **yes (`HarnessErrorCode[value]`)** | **yes** | **yes** |

The enum is the only shape where `Object.values(HarnessErrorCode)` gives an introspectable list at runtime — exactly what consumer error-telemetry middleware needs (e.g., "alert if code not in known set" without parsing a type). Enums have real cost (reverse-mapping for numeric enums) but **string enums** compile to a plain `Object.freeze`-style const, which tree-shakes cleanly.

**Architect A will probably prefer a template-literal union (compiler-first)**. I contest: SDKs run in consumers' error handlers at runtime. Compiler-only taxonomies fail the "I want to enumerate the codes" test.

**Adapter escape**: `HarnessErrorCode.ADAPTER_CUSTOM` + `details.adapterCode: string` is the sole escape hatch. Adapter packages MUST use it; enforced by an ESLint rule under `packages/*-adapter/` that forbids any other code value in adapter-subclassed errors. Documented in `@harness-one/core` README + CHANGELOG migration entry.

**Exhaustiveness test** (PRD F-6 measure):

```ts
// packages/core/src/core/__tests__/error-code-exhaustive.spec.ts
import { HarnessErrorCode } from '../errors.js';

function describe(code: HarnessErrorCode): string {
  switch (code) {
    case HarnessErrorCode.CORE_UNKNOWN: return '…';
    // … every member …
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
```

Adding a new enum member without a `case` line fails `tsc` — exactly the PRD F-6 measure.

---

## 6. `_internal/` → `infra/` Rename + ESLint Barrier

### 6.1 Mechanical rename

```bash
git mv packages/core/src/_internal packages/core/src/infra
sed -i '' "s|from '\\./_internal/|from './infra/|g" packages/core/src/**/*.ts
sed -i '' "s|from '\\.\\./_internal/|from '../infra/|g" packages/core/src/**/*.ts
# (or ripgrep-based codemod for all 19 importers — PRD §3 E-1 verified count)
```

**Estimated diff**: ~20 files, mechanical, hour-scale. No cross-package work because all 19 importers are intra-`packages/core/src/` (PRD §3 verified).

### 6.2 ESLint barrier

```js
// packages/core/.eslintrc.cjs
module.exports = {
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['**/infra/*', '**/infra'],
          message:
            'packages/core/src/infra/ is internal infrastructure. ' +
            'Do not import it from outside packages/core/src/. ' +
            'If a symbol here should be public, add it to a subpath export.',
        },
      ],
    }],
  },
  overrides: [
    {
      // All intra-core files may reach in
      files: ['packages/core/src/**/*.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      // Tests may reach in freely (PRD F-2 exemption)
      files: ['packages/core/src/**/__tests__/**/*.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ],
};
```

A sibling rule at the **repo root** `.eslintrc.cjs` catches the cross-package case:

```js
'no-restricted-imports': ['error', {
  patterns: [
    { group: ['@harness-one/core/infra', '@harness-one/core/infra/*'], message: '...' },
    { group: ['@harness-one/core/dist/infra', '@harness-one/core/dist/infra/*'], message: '...' },
    { group: ['harness-one/infra', 'harness-one/infra/*'], message: '...' }, // covers transition
  ],
}],
```

### 6.3 `package.json#files` narrowing (PRD F-2 known limitation)

To close the "deep dist-path reach-in" vector I narrow `files` to exclude `infra/`:

```json
"files": [
  "dist/*.js",
  "dist/*.cjs",
  "dist/*.d.ts",
  "dist/core",
  "dist/tools",
  "dist/guardrails",
  "dist/prompt",
  "dist/context",
  "dist/observe",
  "dist/session",
  "dist/memory",
  "dist/orchestration",
  "dist/rag"
]
```

**Note**: this requires a tsup config tweak to still *build* `dist/infra/` for intra-package consumption, then the packaged tarball omits it. I prefer this over shipping infra + hoping nobody reaches in — closing the vector at the packaging level is belt-and-suspenders.

---

## 7. api-extractor Configuration

### 7.1 Per-package config

Every `@harness-one/*` package gets `api-extractor.json`:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
  "mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts",
  "bundledPackages": [],
  "apiReport": {
    "enabled": true,
    "reportFolder": "<projectFolder>/etc/",
    "reportFileName": "<unscopedPackageName>.api.md"
  },
  "docModel": { "enabled": false },
  "tsdocMetadata": { "enabled": false },
  "dtsRollup": { "enabled": false },
  "messages": {
    "extractorMessageReporting": {
      "ae-missing-release-tag": { "logLevel": "none" }
      // main 5C: snapshot-diff only. 5C.1 flips this to "error".
    }
  }
}
```

**Subpath entries**: api-extractor does not natively support multi-entry. Workaround: run api-extractor once per subpath entry (`./core`, `./tools`, etc.), producing `etc/core.api.md`, `etc/core-core.api.md`, `etc/core-tools.api.md`, … all checked in. A root shell script `pnpm api:check` runs all N invocations.

### 7.2 Root script

```jsonc
// package.json (monorepo root)
"scripts": {
  "api:check": "pnpm -r run api:check",
  "api:update": "pnpm -r run api:update"
}
```

Each package's `api:check` runs api-extractor in `--local` mode and fails if `etc/*.api.md` differs from git.

### 7.3 CI gate (PRD F-8 snapshot-diff mode)

```yaml
# .github/workflows/api-gate.yml
- name: api-extractor snapshot diff
  run: pnpm api:check
- name: PR description contains rationale
  if: github.event_name == 'pull_request'
  uses: actions/github-script@v7
  with:
    script: |
      const body = context.payload.pull_request.body || '';
      const hasRationale = /^## API change rationale\s*$[\s\S]{20,}/m.test(body);
      const apiChanged = /* diff check on etc/*.api.md */;
      if (apiChanged && !hasRationale) {
        core.setFailed('API snapshot changed — PR must include "## API change rationale" section');
      }
```

Override path: `pnpm api:update` locally, commit regenerated `*.api.md`, add `## API change rationale` to PR body — PRD F-8 §6 satisfied.

**Wave-5C.1 upgrade**: flip `ae-missing-release-tag` to `"error"`, add `@stable`/`@beta`/`@alpha`/`@experimental` to every public export. My **default-untagged = `@experimental`** policy (see §11) is the ergonomics-friendly path: consumers see "experimental" and know to pin; we are not auto-promising stable on day one.

---

## 8. `templates.ts` Split Strategy

**Current**: `packages/core/src/cli/templates.ts` = 651 LOC, one `Record<ModuleName, string>` holding 12 scaffold templates as tagged-template strings. After F-3 extraction, it lives at `packages/cli/src/templates.ts`.

**Split plan — one file per module, plus a registry**:

```
packages/cli/src/templates/
├── index.ts                    # registry: getTemplate(mod) → string
├── core.template.ts            # one export: coreTemplate (string)
├── prompt.template.ts
├── context.template.ts
├── tools.template.ts
├── guardrails.template.ts
├── observe.template.ts
├── session.template.ts
├── memory.template.ts
├── eval.template.ts            # emits `from '@harness-one/devkit/eval'` (NOT harness-one/eval)
├── evolve.template.ts          # emits `from '@harness-one/devkit/evolve'`
├── orchestration.template.ts
└── rag.template.ts
```

Each file:
- ≤ 80 LOC (largest is likely `core.template.ts` at ~50 LOC).
- Header comment names its one consumer: `// Consumed by @harness-one/cli init --module=core`.
- A co-located `__tests__/<module>.template.spec.ts` asserts the emitted subpath resolves against `@harness-one/core/package.json#exports`.

**Registry**:

```ts
// packages/cli/src/templates/index.ts
import { coreTemplate } from './core.template.js';
import { promptTemplate } from './prompt.template.js';
// ... etc

const TEMPLATES = {
  core: coreTemplate,
  prompt: promptTemplate,
  // ...
} as const satisfies Record<ModuleName, string>;

export function getTemplate(mod: ModuleName): string {
  return TEMPLATES[mod];
}
```

**Build-time parser test** (PRD F-3 E-4 new measure):

```ts
// packages/cli/src/templates/__tests__/subpath-resolvability.spec.ts
import { readFileSync } from 'fs';
import * as templates from '../index.js';
import corePkg from '@harness-one/core/package.json';
import devkitPkg from '@harness-one/devkit/package.json';

const SUBPATH_RE = /from\s+['"](@?harness-one[\w/@-]*)['"]/g;

for (const [mod, template] of Object.entries(templates)) {
  for (const match of template.matchAll(SUBPATH_RE)) {
    const spec = match[1];
    // Assert spec resolves against @harness-one/core or @harness-one/devkit exports map
    expect(isResolvable(spec, [corePkg, devkitPkg])).toBe(true);
  }
}
```

This is the test that catches the PRD §3 E-4 failure mode: a template emits `harness-one/eval` but F-4 removed `./eval` — build fails before release.

**Post-rename template updates**: `templates.ts:14-15` emits `from 'harness-one/core'` today. After the rename, each template emits `from '@harness-one/core/core'` (awkward) — so we update the templates to emit **bare `from '@harness-one/core'`** for the common case and `from '@harness-one/core/<subpath>'` only when the scaffold actually needs a subpath symbol. This is a DX improvement piggy-backed on the forced touch.

---

## 9. Version Coordination — Changesets Linked

**Per PRD PD-2: `linked` lockstep across `@harness-one/*`.**

```json
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [[
    "@harness-one/core",
    "@harness-one/cli",
    "@harness-one/devkit",
    "@harness-one/preset",
    "@harness-one/openai",
    "@harness-one/anthropic",
    "@harness-one/redis",
    "@harness-one/langfuse",
    "@harness-one/opentelemetry",
    "@harness-one/ajv",
    "@harness-one/tiktoken"
  ]],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

**`linked` vs `fixed`**: I use `linked`, not `fixed`. `linked` bumps every package in the group to the highest bump level *when any of them is released*, but packages not touched in a given release cycle stay at their current version. `fixed` would force every package to share a version number even when untouched — that is maintenance theatre, not consumer value.

**Wave-5C release plan**:
1. Wave-5C main merge → single changeset: `"major"` bump for every package in the linked group.
   - `harness-one@0.4.x` → `@harness-one/core@1.0.0-rc.1` (rename + SemVer major reset).
   - All other `@harness-one/*` → `1.0.0-rc.1` lockstep.
2. Placeholder publish of `@harness-one/core@1.0.0-placeholder.0` happens **before** the changeset merge to reserve the name (F-14 conditional on ADR 9.a rename).
3. The old `harness-one` package on npm stays at `0.4.x` untouched — no deprecation until Wave-5G.
4. `examples/package.json` added (F-13 measure), declares `@harness-one/core`, `@harness-one/preset`, `@harness-one/openai`, `@harness-one/anthropic`, `@harness-one/devkit` as devDeps at `workspace:*`.

**Dependency consistency check** (PRD F-12):

```ts
// scripts/verify-deps.ts
const imports = enumerateWorkspaceImports();       // every `from '@harness-one/*'` or `from 'harness-one*'`
for (const [pkg, specs] of imports) {
  const pkgJson = readPackageJson(pkg);
  for (const spec of specs) {
    const depName = extractTopPackage(spec);
    assert(
      pkgJson.dependencies?.[depName] === 'workspace:*' ||
        pkgJson.peerDependencies?.[depName],
      `${pkg} imports ${spec} but does not declare ${depName} in package.json`,
    );
  }
}
```

Runs in CI as `pnpm verify:deps`.

---

## 10. Examples Migration Plan

Per PRD F-13 (P0 blocker for F-4 acceptance).

### 10.1 Inventory (PRD §3 verified: 20 files, 52 import sites)

- `full-stack-demo.ts:15,20` — `from 'harness-one/eval'` → `from '@harness-one/devkit'`
- `eval/llm-judge-scorer.ts:8,119` — `from 'harness-one/eval'` → `from '@harness-one/devkit'`
- Every other file — `from 'harness-one'` or `from 'harness-one/<subpath>'` → `from '@harness-one/core'` or `from '@harness-one/core/<subpath>'`
- Adapter files — `harness-one/openai` pattern (if any) → already `@harness-one/openai` (no change)

### 10.2 Automation: one-shot codemod

```ts
// scripts/codemod-examples.ts
const REWRITES: Array<[RegExp, string]> = [
  [/from\s+['"]harness-one\/eval['"]/g,    "from '@harness-one/devkit'"],
  [/from\s+['"]harness-one\/evolve['"]/g,  "from '@harness-one/devkit'"],
  [/from\s+['"]harness-one\/cli['"]/g,     "from '@harness-one/cli'"],
  [/from\s+['"]harness-one\/(\w+)['"]/g,   "from '@harness-one/core/$1'"],
  [/from\s+['"]harness-one['"]/g,          "from '@harness-one/core'"],
];
for (const file of glob('examples/**/*.ts')) {
  let src = readFileSync(file, 'utf8');
  for (const [re, repl] of REWRITES) src = src.replace(re, repl);
  writeFileSync(file, src);
}
```

### 10.3 `examples/package.json` (new file)

```json
{
  "name": "@harness-one/examples",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@harness-one/core": "workspace:*",
    "@harness-one/preset": "workspace:*",
    "@harness-one/devkit": "workspace:*",
    "@harness-one/openai": "workspace:*",
    "@harness-one/anthropic": "workspace:*",
    "@harness-one/redis": "workspace:*",
    "@harness-one/langfuse": "workspace:*",
    "@harness-one/opentelemetry": "workspace:*",
    "@harness-one/ajv": "workspace:*",
    "@harness-one/tiktoken": "workspace:*",
    "typescript": "^5.5.0"
  }
}
```

### 10.4 CI step

```yaml
- name: Examples typecheck
  run: pnpm -C examples typecheck
```

Added to the main PR CI job so F-4 cannot merge if examples break (F-13 measure).

### 10.5 README note

Top of `examples/README.md`:

> Examples import from `@harness-one/*`. In your own project, install the same package names. If you are on `harness-one@0.4.x`, see MIGRATION-1.0-rc.md for the rename map.

---

## 11. Risks / What Ergonomics Trades Away

| # | Risk | Cost | Mitigation |
|---|---|---|---|
| R-B1 | npm rename (`harness-one` → `@harness-one/core`) breaks SEO + blog links | High: every "harness-one@0.4 tutorial" link needs updating | LD-3 already accepts this; placeholder publish reserves name; Wave-5G adds `"deprecated"` field to `harness-one@0.4.x`; MIGRATION-1.0-rc.md is first doc published |
| R-B2 | Two separate `@harness-one/ajv` + `@harness-one/tiktoken` packages = more `pnpm install` lines for consumers who want both | Medium: 2 lines instead of 1 | Consumers who need both write one shell alias; merging hides the native-dep cost asymmetry (see §2 rationale) |
| R-B3 | Enum `HarnessErrorCode` has larger compiled output than template-literal union | Low: string enum compiles to `const X = { CORE_UNKNOWN: 'CORE_UNKNOWN', ... }` — ~2KB gzipped for 25 members | Tree-shakes cleanly; runtime introspectability is worth 2KB |
| R-B4 | Per-subpath api-extractor invocations multiply CI time | Medium: ~11 invocations for `@harness-one/core` alone | All run in parallel via `pnpm -r`; cold CI run adds ~30s total; cached runs ~5s |
| R-B5 | 11 packages in `linked` group = every release bumps all of them | Low: `linked` bumps only on release, not on every PR | Already PD-2; trade-off accepted |
| R-B6 | `@harness-one/devkit` sub-exporting `./eval` + `./evolve` means 2 more api-extractor snapshots to maintain | Low | Two small snapshots vs one large one; bugfix blast radius smaller |
| R-B7 | `package.json#files` narrowing can miss a legitimate file and break install | High if silent | Post-build smoke test: `pnpm pack` + `tar tf` + assert all declared subpath entry files present |
| R-B8 | Default `@experimental` policy (5C.1) frightens adoption | Medium | Countered by clear README "what @experimental means for you"; ADR 9.g picks; I recommend `@experimental` default over build-fail because rc is rc |
| R-B9 | CLI binary command name `harness-one` + package name `@harness-one/cli` creates "which do I install?" confusion | Low | Documented in README top-banner: "install `@harness-one/cli`, run `harness-one`" |
| R-B10 | `essentials` deletion breaks whatever code imports it today | Low: grep shows zero current consumers; it exists as a vestigial entry | CHANGELOG note |

**Ergonomics trades away**:
- **Monorepo maintenance cost**: 2 new packages = 2 more `package.json` files, 2 more `tsup.config.ts`, 2 more `tsconfig.json`. Worth it.
- **CI minutes**: ~20% higher due to more package installs + more api-extractor runs. Worth it.
- **One atomic rename ceremony**: `harness-one` → `@harness-one/core` is a one-time forced touch on every consumer. Worth it — 1.0-rc is the only permissible moment.

---

## 12. Defence Against Expected Attacks

### 12.1 Architect A: "More packages = more CI cost + more install latency"

**My counter**:

1. **CI cost is a maintainer cost, not a consumer cost.** The PRD's §7.1 performance budget is on *consumer* bundle size (≥30% shrink) and *build* topo-order correctness — not on our CI minutes. Measurement per package has ~30s amortized cost; we spend 30 minutes per PR on review; the ratio is 1:60.
2. **Install latency for consumers is a subset-install story.** A runtime-only consumer does `pnpm add @harness-one/core @harness-one/openai` — **2 packages**, not 11. They never install `@harness-one/cli` or `@harness-one/devkit` in prod. Architect A's "11 packages to install" counter is a strawman; nobody installs all 11.
3. **More packages → smaller blast radius on version bumps.** With `linked` versioning the consumer sees a single version number they can pin; with 3 packages merged into 1 god-package, a bugfix in `devkit` forces the whole runtime package's users to re-evaluate a new release. Package boundaries = change-propagation boundaries. Fewer packages looks cheaper up-front and is more expensive at every release.
4. **Tooling already handles fan-out.** `changeset linked`, `pnpm -r`, Turborepo — the entire JS monorepo ecosystem exists because small-package-many-versions is the paved road. Architect A's argument is an argument against 2023-era tooling.
5. **Concrete CI math**: current CI wall-clock ≈ 4-6 min (estimated). Adding 2 packages adds ~45s of install + ~20s of api-extractor runs = ~1 min. That is a **2-minute-per-PR tax for a permanent DX win**. I will take that trade every day of the week.

### 12.2 Architect C: "Your scope rename is npm registry pollution"

**My counter**:

1. **Scope reservation is not pollution; it is hygiene.** `@harness-one` is already reserved (the adapter packages publish under it: `@harness-one/openai`, etc.). Adding `@harness-one/core`, `@harness-one/cli`, `@harness-one/devkit` *completes* the family — it does not start a new one. Pollution would be squatting under an unrelated scope.
2. **Leaving `harness-one` unscoped is the real pollution.** A consumer searching npm for "harness-one" today hits a page where the marquee package sits in a different namespace from its siblings. That is cognitive pollution — the family looks like two unrelated projects. Post-rename: one `npm search @harness-one` query returns the whole family in one cluster.
3. **Placeholder publish cost is minimal.** F-14 requires one `package.json`, one README, one `npm publish`. Under 30 minutes of work. The registry absorbs millions of placeholder packages; one more to complete a coherent scope is rounding error.
4. **`harness-one@0.4.x` stays alive and untouched.** I am not poisoning the existing name on npm in this wave (see §9 release plan). The 0.x installers keep working; the scoped packages coexist. The deprecation dance is Wave-5G.
5. **Industry precedent overwhelmingly favors scoped-family naming.** `@nestjs/core` + `@nestjs/cli` + `@nestjs/common`. `@angular/core` + `@angular/cli`. `@remix-run/react` + `@remix-run/dev`. `@vercel/ai` + `@ai-sdk/*`. Every serious TS framework over the last five years picks scoped families. The unscoped marquee name is a 2016-era artefact we should retire.
6. **SEO concern is real but bounded.** Pre-1.0 docs traffic is low; we have no published 0.x on npm for the 1.0-series name yet per PRD §7; blog posts referring to `harness-one@0.4` remain accurate. Redirect-style docs at `harness-one/0.4 → @harness-one/core/1.0-rc` absorb the rest.

---

## Summary

**Final package map (one-line each)**:
- `@harness-one/core` — runtime agent loop + tools + guardrails + observability (renamed from `harness-one`)
- `@harness-one/cli` — `harness-one` bin + scaffolder, devDep
- `@harness-one/devkit` — eval + evolve + arch-checker, devDep
- `@harness-one/preset` — `createHarness` + `createSecurePreset`, `eventBus` deleted
- `@harness-one/openai` / `anthropic` / `redis` / `langfuse` / `opentelemetry` — adapters, unchanged
- `@harness-one/ajv` + `@harness-one/tiktoken` — native-dep packages, **kept separate**
- `packages/full/` — deleted

**Root barrel size**: **22 value exports** (3 reserved for adapter re-exports if ADR 9.a picks), unbounded type-only exports; `HarnessErrorCode` *enum* surfaced at root for runtime introspectability; `guardrails.run*` folded into a namespace to preserve slots.

**Sharpest counter**: Architect A's "more packages = more CI cost" is a maintainer-cost argument applied to a consumer-facing surface. Consumers install **subsets** (runtime: 2 packages; dev: +1); they never feel the package count. The ~1-minute-per-PR CI tax buys a permanent DX win on the reading experience — and reading happens a thousand times per publish. Architect C's "registry pollution" ignores that `@harness-one` is already the family scope; the unscoped marquee name is the actual inconsistency. Every modern framework (Nest, Angular, Remix, Vercel AI) chose the scoped-family shape. 1.0-rc is our only window.
