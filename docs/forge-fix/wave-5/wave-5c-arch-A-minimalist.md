# Wave-5C Architecture — Proposal A: Minimalist Purist

**Architect**: A ("Minimalist Purist")
**PRD Reference**: `docs/forge-fix/wave-5/wave-5c-prd-v2.md`
**Date**: 2026-04-15
**Status**: Competing (Round 1)

---

## 1. Position statement

**What I optimize for**: the total cost of carrying this repository for a year. Every extra package is a permanent tax: an entry in the changeset, a build graph node, a published tarball, a README, a `package.json` consistency burden, a tsup config, a test harness, a version column in release notes, a support surface for CVE triage. The repo already has ten packages — three of them single-file wrappers around a native dep, one of them a dead `packages/full/` husk (no `package.json`, no `src/` — `ls` verified). Adding two more (`cli`, `devkit`) is mandated by PRD F-3 / F-4; adding *any more beyond that* needs a blood oath. I optimize for the day the repo stops being fun and becomes something we *have* to maintain: on that day, each extra package costs an hour a month forever.

**What I am willing to trade away**: consumer "dependency graph discoverability" aesthetics. A consumer who installs `@harness-one/native-deps` gets both Ajv-glue and tiktoken-glue in one devDep; they pay ~30 KB of code they may not exercise (both are thin shims — the real weight is the *peer* dep, which they opt into by installing `ajv` or `tiktoken`). I'm willing to trade the "one package per concern" npm folk-norm for a real reduction in package count. I'm **also** willing to trade away `harness-one/essentials` (kill it — it's a third redundant entry no one asked for) and the `harness-one` → `@harness-one/core` rename ceremony (keep the old name — npm rename is pure cost, zero user value pre-1.0). Stability tag default: untagged = `@stable`. If you exported it, you signed up to support it — no untagged "maybe public, maybe not" exports shipping in 1.0-rc.

---

## 2. Package map

| Package | Role | LOC estimate | Runtime deps | Changes vs HEAD |
|---|---|---|---|---|
| `harness-one` | Runtime core: loop, tools, prompt, context, guardrails, observe, session, memory, orchestration, rag + `infra/` | ~19,000 (down from 19,842 after removing cli/evolve/eval) | (none) | keep name; drop `./cli`, `./eval`, `./evolve`, `./essentials` subpaths; rename `_internal/` → `infra/` |
| `@harness-one/cli` | `init`/`audit` CLI binary; owns `templates.ts` split | ~1,100 | `harness-one` (regular dep), `commander` (or existing parser) | **NEW** — extracted from `packages/core/src/cli/` |
| `@harness-one/devkit` | `eval/` + `evolve/` (component-registry, drift-detector, architecture-checker, taste-coding, runner, scorers, generator-evaluator, flywheel) | ~3,200 | `harness-one` (regular dep) | **NEW** — extracted from `packages/core/src/eval/` + `packages/core/src/evolve/` |
| `@harness-one/native-deps` | **MERGED**: Ajv validator + tiktoken registrar, single entry with two named subpath exports (`./ajv`, `./tiktoken`) | ~400 (combined) | `harness-one` (regular); `ajv` + `tiktoken` as peer | **MERGED** from `@harness-one/ajv` + `@harness-one/tiktoken` |
| `@harness-one/preset` | `createHarness` + `createSecurePreset` batteries-included wiring | ~unchanged minus eventBus | `harness-one`, `@harness-one/native-deps`, adapter packages, `@harness-one/langfuse`, `@harness-one/redis` | drop `eventBus` dead-stub; swap `@harness-one/ajv` / `@harness-one/tiktoken` imports to `@harness-one/native-deps` |
| `@harness-one/openai` | OpenAI adapter | unchanged | `harness-one` (regular) | no change |
| `@harness-one/anthropic` | Anthropic adapter | unchanged | `harness-one` (regular) | no change |
| `@harness-one/redis` | Redis memory store | unchanged | `harness-one` (regular); `ioredis` peer | no change |
| `@harness-one/langfuse` | Langfuse exporter (auxiliary — OTel is canonical per Wave-5 invariants) | unchanged | `harness-one` (regular); `langfuse` peer | no change |
| `@harness-one/opentelemetry` | Canonical OTel bridge | unchanged | `harness-one` (regular); `@opentelemetry/api` peer | no change |
| ~~`packages/full/`~~ | **DELETE** — no `package.json`, unreferenced | — | — | **DELETE** |
| ~~`@harness-one/ajv`~~ | **MERGE into `@harness-one/native-deps`** | — | — | — |
| ~~`@harness-one/tiktoken`~~ | **MERGE into `@harness-one/native-deps`** | — | — | — |

**Net change**: 10 packages → 10 packages (−2 native shims, +1 merged native-deps, +1 cli, +1 devkit, −1 dead `full`). Zero net growth despite two PRD-mandated extractions. That is the minimalist win.

---

## 3. Subpath surface (per package)

### 3.1 `harness-one/package.json#exports` (post-trim)

```json
{
  "exports": {
    ".":              { "types": "./dist/index.d.ts",              "import": "./dist/index.js",              "require": "./dist/cjs/index.cjs" },
    "./core":         { "types": "./dist/core/index.d.ts",         "import": "./dist/core/index.js",         "require": "./dist/cjs/core/index.cjs" },
    "./prompt":       { "types": "./dist/prompt/index.d.ts",       "import": "./dist/prompt/index.js",       "require": "./dist/cjs/prompt/index.cjs" },
    "./context":      { "types": "./dist/context/index.d.ts",      "import": "./dist/context/index.js",      "require": "./dist/cjs/context/index.cjs" },
    "./tools":        { "types": "./dist/tools/index.d.ts",        "import": "./dist/tools/index.js",        "require": "./dist/cjs/tools/index.cjs" },
    "./guardrails":   { "types": "./dist/guardrails/index.d.ts",   "import": "./dist/guardrails/index.js",   "require": "./dist/cjs/guardrails/index.cjs" },
    "./observe":      { "types": "./dist/observe/index.d.ts",      "import": "./dist/observe/index.js",      "require": "./dist/cjs/observe/index.cjs" },
    "./session":      { "types": "./dist/session/index.d.ts",      "import": "./dist/session/index.js",      "require": "./dist/cjs/session/index.cjs" },
    "./memory":       { "types": "./dist/memory/index.d.ts",       "import": "./dist/memory/index.js",       "require": "./dist/cjs/memory/index.cjs" },
    "./orchestration":{ "types": "./dist/orchestration/index.d.ts","import": "./dist/orchestration/index.js","require": "./dist/cjs/orchestration/index.cjs" },
    "./rag":          { "types": "./dist/rag/index.d.ts",          "import": "./dist/rag/index.js",          "require": "./dist/cjs/rag/index.cjs" }
  }
}
```

**Removed vs HEAD** (verified against `packages/core/package.json:12-81`):
- `./essentials` — killed (ADR 9.i/9.j: third entry of UJ confusion, per PRD §2.1)
- `./cli` — moved to `@harness-one/cli`
- `./eval` — moved to `@harness-one/devkit`
- `./evolve` — moved to `@harness-one/devkit`

**`bin`**: removed from `harness-one` (moves to `@harness-one/cli`).
**`files`**: `["dist"]` but **`dist/infra/`** explicitly excluded via tsup `noExternal` + a build-time post-step `rm -rf dist/infra` to close the deep-dist-path reach-in gap (PRD F-2 "known limitation"). Tests import from `src/infra/`, not `dist/infra/`, so CI stays green.

**Total subpaths**: 11 (down from 14 — a 21 % reduction).

### 3.2 `@harness-one/cli/package.json#exports`

```json
{
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "bin": { "harness-one": "./dist/index.js" }
}
```

No subpaths. CLI is a binary — its public contract is `argv`, not imports. Do not expose `./templates`, `./parser`, `./audit` as subpaths. If anyone needs programmatic scaffolding, they copy the 10-line `spawn` wrapper.

### 3.3 `@harness-one/devkit/package.json#exports`

```json
{
  "exports": {
    ".":          { "types": "./dist/index.d.ts",          "import": "./dist/index.js" },
    "./eval":     { "types": "./dist/eval/index.d.ts",     "import": "./dist/eval/index.js" },
    "./evolve":   { "types": "./dist/evolve/index.d.ts",   "import": "./dist/evolve/index.js" }
  }
}
```

Root barrel re-exports both `eval` and `evolve` flat (all 14 symbols — list is small, tree-shaking handles the rest). Subpaths exist only for consumers who already had `harness-one/eval` / `harness-one/evolve` muscle memory — the F-13 `sed` replacement `harness-one/eval` → `@harness-one/devkit/eval` is a one-liner. **No CJS builds** — devkit is dev-only, ESM-only. Drops 50 % of devkit's build matrix.

### 3.4 `@harness-one/native-deps/package.json#exports`

```json
{
  "exports": {
    "./ajv":      { "types": "./dist/ajv/index.d.ts",      "import": "./dist/ajv/index.js",      "require": "./dist/cjs/ajv/index.cjs" },
    "./tiktoken": { "types": "./dist/tiktoken/index.d.ts", "import": "./dist/tiktoken/index.js", "require": "./dist/cjs/tiktoken/index.cjs" }
  },
  "peerDependencies":         { "ajv": ">=8", "ajv-formats": ">=3", "tiktoken": ">=1" },
  "peerDependenciesMeta":     { "ajv": {"optional":true}, "ajv-formats":{"optional":true}, "tiktoken":{"optional":true} }
}
```

**No root `.` export.** You install this package because you want one or both of its peers. The subpath names match the peer, so `import { createAjvValidator } from '@harness-one/native-deps/ajv'` reads the way the consumer thinks. Every peer is optional — `@harness-one/native-deps` without any peer installed is a no-op package with zero runtime side-effects; the consumer gets a clear `Cannot find module 'ajv'` error at call time, which is the same UX as today's two-package split.

### 3.5 Other packages

`@harness-one/preset`, `@harness-one/openai`, `@harness-one/anthropic`, `@harness-one/redis`, `@harness-one/langfuse`, `@harness-one/opentelemetry` keep current single-root-export shape.

---

## 4. Root barrel (`harness-one`) — exact symbol list

**Ceiling**: PRD F-1 ≤ 25 value symbols. **This proposal: 18 value symbols + unbounded type-only re-exports.** Fewer than the PRD ceiling — good. Every value earns its slot.

### 4.1 Value exports (18 — each with one-line justification)

```ts
// === CORE LOOP (UJ-1: runtime-only consumer) ===
export { createAgentLoop } from './core/index.js';         // primary factory
export { AgentLoop } from './core/index.js';               // class for direct new + instanceof narrowing

// === ERRORS (UJ-1: every runtime consumer needs these) ===
export { HarnessError } from './core/errors.js';           // base — always re-export
export { MaxIterationsError } from './core/errors.js';     // common catch target
export { AbortedError } from './core/errors.js';           // common catch target
export { GuardrailBlockedError } from './core/errors.js';  // common catch target
export { ToolValidationError } from './core/errors.js';    // common catch target
export { TokenBudgetExceededError } from './core/errors.js'; // common catch target

// === TOOLS (UJ-1) ===
export { defineTool } from './tools/index.js';             // tool DSL
export { createRegistry } from './tools/index.js';         // tool registry

// === GUARDRAILS (UJ-1 + fail-closed Wave-5A) ===
export { createPipeline } from './guardrails/index.js';    // guardrail composition

// === OBSERVABILITY (UJ-1; Wave-5 invariant: OTel canonical) ===
export { createTraceManager } from './observe/index.js';   // OTel bridge entry
export { createLogger } from './observe/index.js';         // structured logger

// === SESSION (UJ-1 multi-tenant gateway per Wave-5E) ===
export { createSessionManager } from './session/index.js'; // session primitive

// === MIDDLEWARE (UJ-1 — preset + custom both use this) ===
export { createMiddlewareChain } from './core/index.js';   // middleware composition

// === PRESET BRIDGE (UJ-1: fail-closed default per Wave-5A) ===
export { createSecurePreset } from '@harness-one/preset';  // re-export — convenience only

// === LIFECYCLE (ARCH-005 Disposable contract) ===
export { disposeAll } from './infra/disposable.js';        // public helper
export { DisposeAggregateError } from './infra/disposable.js'; // throws from disposeAll
```

**18 values. 7 slots of headroom.**

### 4.2 Type-only re-exports (unbounded per PRD F-1 E-8 correction)

One barrel `export type { … } from …` per submodule, listing every type currently in the subpath barrel. These cost zero runtime bundle bytes and carry no `.api.md` pressure beyond the snapshot. Keeps IDE discovery cheap.

Grouped type exports (names omitted for space — see `packages/core/src/index.ts:37-217` verbatim minus things that *move* to devkit):
- **from `./core`**: `Role`, `Message`, `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `AgentAdapter`, `AgentLoopConfig`, `AgentLoopHook`, `AgentLoopTraceManager`, `ChatParams`, `ChatResponse`, `StreamChunk`, `ToolCallRequest`, `ToolSchema`, `TokenUsage`, `JsonSchema`, `LLMConfig`, `ResponseFormat`, `AgentEvent`, `DoneReason`, `MiddlewareChain`, `PruneResult` (drop `EventBus`, `FallbackAdapterConfig`, `ResilientLoopConfig`, `ResilientLoop`, `StreamAggregator*`, `OutputParser` — relegated to subpath-only per F-1)
- **from `./tools`**: `ToolDefinition`, `ToolMiddleware`, `ToolResult`, `ToolFeedback`, `ToolCall`, `ToolRegistry`, `SchemaValidator`, `ValidationError`
- **from `./guardrails`**: `Guardrail`, `GuardrailContext`, `GuardrailVerdict`, `GuardrailPipeline`
- **from `./observe`**: `Trace`, `Span`, `SpanEvent`, `SpanAttributes`, `SpanAttributeValue`, `TraceExporter`, `TraceManager`, `InstrumentationPort`, `CostTracker`, `ModelPricing`, `TokenUsageRecord`, `CostAlert`, `Logger`, `LogLevel`, `FailureMode`, `FailureClassification`, `CacheMetrics`, `CacheMonitor`
- **from `./session`**: `Session`, `SessionEvent`, `SessionManager`, `ConversationStore`, `ConversationStoreCapabilities`, `AuthContext`
- **from `./memory`**: `MemoryEntry`, `MemoryFilter`, `MemoryStore`, `MemoryStoreCapabilities`, `MemoryGrade`
- **from `./infra/disposable`**: `Disposable`

### 4.3 Explicit drops from HEAD `packages/core/src/index.ts`

Verified against HEAD (lines cited):
- Line 23 `createJsonOutputParser`, line 24 `parseWithRetry` → subpath-only (niche)
- Line 26 `createFallbackAdapter`, line 27 `createResilientLoop` → subpath-only (`./core`)
- Line 28 `createEventBus` → **DELETE** (supports F-9 dead-stub removal; `eventBus` + `createEventBus` is the dead-stub pair)
- Line 29 `createSequentialStrategy`, line 30 `createParallelStrategy` → subpath-only
- Line 31 `categorizeAdapterError` → subpath-only (advanced; 3 in-repo consumers)
- Line 32 `pruneConversation` → subpath-only (`./core`)
- Line 33 `toSSEStream`, line 34 `formatSSE` → subpath-only (`./core` — transport concern, not every consumer needs)
- Line 35 `assertNever` → **DELETE** (TS idiom; consumers can write their own 2-liner)
- Line 71 `StreamAggregator` → subpath-only (`./core`)
- Line 75 `toolSuccess`, `toolError`, `validateToolCall` → subpath-only (`./tools`)
- Lines 95-99 `createInjectionDetector`, `createPIIDetector`, `createContentFilter`, `createRateLimiter`, `createSchemaValidator`, `withSelfHealing` → subpath-only (`./guardrails` — preset consumes)
- Lines 101-103 `runInput`, `runOutput`, `runToolOutput` → subpath-only (`./guardrails` — preset/test consumers only)
- Line 113 `createPromptBuilder`, `createPromptRegistry`, `createAsyncPromptRegistry`, `createSkillEngine`, `createDisclosureManager` → subpath-only (`./prompt`)
- Lines 116-126 all context factories → subpath-only (`./context`)
- Lines 132-138 `createConsoleExporter`, `createNoOpExporter`, `createCostTracker`, `createFailureTaxonomy`, `createCacheMonitor`, `createDatasetExporter` → subpath-only (`./observe`)
- Lines 162-164 `createInMemoryConversationStore`, `createAuthContext` → subpath-only (`./session`)
- Lines 176-185 all memory factories → subpath-only (`./memory`)
- Lines 200-206 `createAgentPool`, `createHandoff`, `createContextBoundary`, `MessageQueue` → subpath-only (`./orchestration`)
- Line 210 `createEvalRunner`, `createRelevanceScorer` → **MOVED** to `@harness-one/devkit`
- Line 211 `createComponentRegistry` → **MOVED** to `@harness-one/devkit`
- Line 212 `createRAGPipeline` → subpath-only (`./rag`)

Adapter factories (`createOpenAIAdapter`, `createAnthropicAdapter`) **not** re-exported — they are already on their own packages; re-exporting costs 2 barrel slots for zero new discoverability.

---

## 5. `HarnessErrorCode` closure — exact TypeScript

### 5.1 The shape (template-literal union + `as const` + ADAPTER_CUSTOM escape)

```ts
// packages/core/src/core/errors.ts

// --- prefix list is a closed source of truth ------------------------------
const CORE_CODES = ['UNKNOWN', 'INVALID_CONFIG', 'INVALID_STATE', 'INTERNAL_ERROR'] as const;
const LOOP_CODES = ['MAX_ITERATIONS', 'ABORTED', 'TOKEN_BUDGET_EXCEEDED', 'PROVIDER_REGISTRY_SEALED'] as const;
const TOOL_CODES = ['TOOL_VALIDATION', 'TOOL_INVALID_SCHEMA', 'TOOL_CAPABILITY_DENIED'] as const;
const GUARD_CODES = ['GUARDRAIL_BLOCKED', 'GUARDRAIL_VIOLATION', 'GUARDRAIL_INVALID_PIPELINE'] as const;
const SESSION_CODES = ['SESSION_NOT_FOUND', 'SESSION_LIMIT', 'SESSION_LOCKED', 'SESSION_EXPIRED'] as const;
const MEMORY_CODES = ['MEMORY_CORRUPT', 'MEMORY_STORE_CORRUPTION'] as const;
const TRACE_CODES = ['TRACE_NOT_FOUND', 'SPAN_NOT_FOUND'] as const;
const CLI_CODES = ['CLI_PARSE_ERROR'] as const;
const ADAPTER_CODES = ['ADAPTER_INVALID_EXTRA', 'ADAPTER_CUSTOM'] as const; //  <-- escape hatch

export type HarnessErrorCode =
  | (typeof CORE_CODES)[number]
  | (typeof LOOP_CODES)[number]
  | (typeof TOOL_CODES)[number]
  | (typeof GUARD_CODES)[number]
  | (typeof SESSION_CODES)[number]
  | (typeof MEMORY_CODES)[number]
  | (typeof TRACE_CODES)[number]
  | (typeof CLI_CODES)[number]
  | (typeof ADAPTER_CODES)[number];

export const HARNESS_ERROR_CODES = [
  ...CORE_CODES, ...LOOP_CODES, ...TOOL_CODES, ...GUARD_CODES,
  ...SESSION_CODES, ...MEMORY_CODES, ...TRACE_CODES, ...CLI_CODES, ...ADAPTER_CODES,
] as const;

// --- the base error -------------------------------------------------------
export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly code: HarnessErrorCode,              // CLOSED. No `(string & {})`.
    public readonly suggestion?: string,
    public readonly details?: Readonly<{ adapterCode?: string; [k: string]: unknown }>,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
```

**Why `as const` template-literal-union, not `enum`, not `const enum`**:
- `enum`: generates runtime object (costs bundle bytes), loses structural typing, `import type` does not erase it.
- `const enum`: inlines at call site but breaks under `isolatedModules: true` (`tsup` / `ts-node` / `vite` all hit this) and is a maintenance footgun.
- `as const` + indexed access: erases cleanly under `import type`, gives exhaustive `switch` + `satisfies` support, ships zero runtime overhead except the single `HARNESS_ERROR_CODES` array which is itself tree-shakable.

### 5.2 `ADAPTER_CUSTOM` escape — exact adapter migration

Third-party adapter code before (open union, 0.4.x):
```ts
throw new HarnessError('OpenAI rate limit hit', 'OPENAI_RATE_LIMIT', ...);  // <-- open string, worked in 0.4.x
```

Third-party adapter code after (closed union, 1.0-rc):
```ts
throw new HarnessError(
  'OpenAI rate limit hit',
  'ADAPTER_CUSTOM',
  'Retry with exponential backoff',
  { adapterCode: 'OPENAI_RATE_LIMIT' },
);
```

Consumers narrowing:
```ts
if (err.code === 'ADAPTER_CUSTOM' && err.details?.adapterCode === 'OPENAI_RATE_LIMIT') { … }
```

**Exhaustiveness test** (`packages/core/src/core/__tests__/errors.exhaustive.test.ts`) — compile-time enforcement:

```ts
import { HARNESS_ERROR_CODES, type HarnessErrorCode } from '../errors.js';

function handle(code: HarnessErrorCode): string {
  switch (code) {
    case 'UNKNOWN': case 'INVALID_CONFIG': case 'INVALID_STATE': case 'INTERNAL_ERROR':
    case 'MAX_ITERATIONS': case 'ABORTED': case 'TOKEN_BUDGET_EXCEEDED': case 'PROVIDER_REGISTRY_SEALED':
    case 'TOOL_VALIDATION': case 'TOOL_INVALID_SCHEMA': case 'TOOL_CAPABILITY_DENIED':
    case 'GUARDRAIL_BLOCKED': case 'GUARDRAIL_VIOLATION': case 'GUARDRAIL_INVALID_PIPELINE':
    case 'SESSION_NOT_FOUND': case 'SESSION_LIMIT': case 'SESSION_LOCKED': case 'SESSION_EXPIRED':
    case 'MEMORY_CORRUPT': case 'MEMORY_STORE_CORRUPTION':
    case 'TRACE_NOT_FOUND': case 'SPAN_NOT_FOUND':
    case 'CLI_PARSE_ERROR':
    case 'ADAPTER_INVALID_EXTRA': case 'ADAPTER_CUSTOM':
      return code;
    default: {
      const _exhaustive: never = code;  // <-- compile fails if a new code is added without a branch
      return _exhaustive;
    }
  }
}
```

### 5.3 Throw-site migration (F-6, 152 sites / 47 files)

Mechanical: `codemod-HarnessError` walks every `throw new HarnessError*(…, 'CODE', …)`, verifies `'CODE'` ∈ `HARNESS_ERROR_CODES` (runtime-known at codemod-time), renames deprecated ones:

| Old code | New code |
|---|---|
| `DEPRECATED_EVENT_BUS` | — removed with F-9 |
| `INVALID_PIPELINE` | `GUARDRAIL_INVALID_PIPELINE` |
| `INVALID_TOOL_SCHEMA` | `TOOL_INVALID_SCHEMA` |
| `STORE_CORRUPTION` | `MEMORY_STORE_CORRUPTION` |

The renames are a two-line `sed` each; the codemod script is ~80 LOC and ships in `tools/codemods/close-error-code.ts` (not in a published package — Wave-5G concern per LD-4). Adapter packages (`@harness-one/openai`, etc.) keep their existing subclasses but swap to `ADAPTER_CUSTOM` + `details.adapterCode`.

---

## 6. `_internal/` → `infra/` ESLint rule

### 6.1 Why `infra/` over alternatives

- `_internal/` — keep? No: leading underscore is a social convention with no teeth; 19 importers (verified grep above) reach in freely. The PRD mandates the rename.
- `private/` — reserved word vibes, confuses IDEs.
- `internal/` — loses the "external → internal" visual distinction the underscore had; still fine but already "internal" is a word downstream packages might use.
- `lib/` — too generic; connotes "library" not "infrastructure".
- **`infra/` — WINS**: one syllable, unambiguous ("infrastructure these modules sit on"), no shell/JS collision, signals "*platform-level concerns, not domain*".

### 6.2 ESLint rule (goes into root `.eslintrc.cjs`)

```js
// .eslintrc.cjs additions
module.exports = {
  overrides: [
    {
      // Rule 1: INSIDE packages/core/src, infra/* is fair game.
      files: ['packages/core/src/**/*.ts'],
      excludedFiles: ['packages/core/src/**/__tests__/**'],  // tests unrestricted
      rules: { 'no-restricted-imports': 'off' },              // explicit off, for clarity
    },
    {
      // Rule 2: OUTSIDE packages/core/src, no infra reach-in whatsoever.
      files: [
        'packages/cli/**/*.ts',
        'packages/devkit/**/*.ts',
        'packages/preset/**/*.ts',
        'packages/openai/**/*.ts',
        'packages/anthropic/**/*.ts',
        'packages/redis/**/*.ts',
        'packages/langfuse/**/*.ts',
        'packages/opentelemetry/**/*.ts',
        'packages/native-deps/**/*.ts',
        'examples/**/*.ts',
      ],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            { group: ['harness-one/infra', 'harness-one/infra/*', 'harness-one/dist/infra', 'harness-one/dist/infra/*'],
              message: 'harness-one/infra is a private infrastructure namespace. Import from a public subpath (harness-one/core, harness-one/tools, …) or from the re-exported `disposeAll` / `Disposable` on the root barrel instead. See ADR-5C-02.' },
            { group: ['../**/core/src/infra/*', '../../**/core/src/infra/*', '../../../**/core/src/infra/*'],
              message: 'Relative reach-in to packages/core/src/infra/ is forbidden. Same rule as above.' },
          ],
        }],
      },
    },
    {
      // Rule 3: tests can reach anywhere — testing infra is a real need.
      files: ['**/__tests__/**/*.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ],
};
```

### 6.3 The deep-dist-path gap (PRD F-2 "known limitation")

`harness-one/dist/infra/lru-cache.js` works *unless we stop shipping it*. Minimalist approach — don't just warn, **remove**:

- `packages/core/tsup.config.ts` adds `external: [/^\.\.?\/infra\//]` so `dist/**/*.js` does not re-export from `./infra/*.js` (compiler rewrites to `./_bundled/infra-xxx.js` — obscurable).
- Alternatively (simpler, what I advocate): `packages/core/package.json` sets `"files": ["dist"]` **and** a build-end `rimraf dist/infra` step — CI gate asserts `test ! -d packages/core/dist/infra`. This is cheaper than bundling gymnastics; trade-off is slightly larger `dist/*.js` files because infra gets inlined into the submodule bundles that use it (a 2–8 KB increase per submodule, verified empirically during implementation).

---

## 7. api-extractor configuration

### 7.1 Per-package vs repo-level

**Per-package.** Repo-level api-extractor invariably ends up with `projectFolder: .` games and fragile "pick one entry point" configs. Each published package has its own `api-extractor.json` co-located with its `package.json` and its own `*.api.md` committed next to it.

### 7.2 Exact per-package `api-extractor.json` (template)

```jsonc
// packages/<pkg>/api-extractor.json
{
  "$schema": "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
  "mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts",
  "bundledPackages": [],                            // IMPORTANT: do NOT roll up harness-one into subpackages
  "apiReport": {
    "enabled": true,
    "reportFolder": "<projectFolder>/etc",
    "reportFileName": "<unscopedPackageName>.api.md",
    "reportTempFolder": "<projectFolder>/temp"
  },
  "docModel": { "enabled": false },
  "dtsRollup": { "enabled": false },                // we ship per-file d.ts via tsup, not rolled-up
  "tsdocMetadata": { "enabled": false },
  "messages": {
    "extractorMessageReporting": {
      "ae-missing-release-tag": { "logLevel": "none" }   // main 5C: tags not enforced (LD-2)
    }
  }
}
```

**`bundledPackages: []` explicitly** — this is the minimalist defence: we never want `@harness-one/devkit.api.md` to inline `harness-one`'s types (would make every barrel change ripple into six files). Types from `harness-one` appear as `import(…)` references, which is the readable-diff mode.

### 7.3 Subpath entries

`harness-one` has 11 subpaths — each needs its own `api-extractor` run because `mainEntryPointFilePath` is single-valued. Solution: add one `api-extractor-<subpath>.json` per subpath, each emitting `etc/harness-one-<subpath>.api.md`. CI runs them in a matrix. `pnpm api:check` = 11 invocations for `harness-one`, 1 for everyone else = ~20 total, each is ~300 ms → ~6 s in CI, acceptable. `pnpm api:update` regenerates all in parallel.

Minimalist alternative considered and rejected: one config per package at root only, no subpath granularity. Rejected because then `./prompt`'s barrel can grow unchecked — defeats F-1.

### 7.4 CI gate shape (F-8 snapshot-diff only)

```yaml
# .github/workflows/api-check.yml
jobs:
  api-check:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm api:check                # runs all api-extractor configs; exits non-zero if *.api.md changes
      - name: Require API change rationale
        if: ${{ failure() }}
        run: |
          echo "::error::*.api.md drifted. Run 'pnpm api:update', commit the snapshot, add '## API change rationale' to PR body."
          exit 1
      - name: Check PR description for rationale (if api.md changed)
        if: ${{ github.event_name == 'pull_request' }}
        run: |
          if git diff --name-only origin/${{ github.base_ref }}...HEAD | grep -q '\.api\.md$'; then
            echo "${{ github.event.pull_request.body }}" | grep -qE '^## API change rationale\s*$' \
              && [ "$(echo "${{ github.event.pull_request.body }}" | awk '/^## API change rationale/,0' | wc -c)" -gt 20 ] \
              || { echo "::error::API change requires '## API change rationale' section (≥ 20 chars) in PR description."; exit 1; }
          fi
```

No CODEOWNERS gate (per PRD LD-2 acknowledging critique §2-E7 — deferred to post-1.0).

---

## 8. `templates.ts` split strategy (F-10 + ADR 9.d)

### 8.1 Current shape (verified)

- `packages/core/src/cli/templates.ts` = **651 LOC** (`wc -l` confirmed).
- Shape: one function `getTemplate(mod)` + one `TEMPLATES: Record<ModuleName, string>`.
- `ModuleName` = 12 keys matching current subpaths (`core`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `eval`, `orchestration`, `rag`, `evolve`) — verified against lines 14, 53, 99-100, 142, 193, 236, 281, 320, 377, 437, 510-511, 573 of `templates.ts`.

### 8.2 Split strategy — **one file per ModuleName**

```
packages/cli/src/templates/
  index.ts              — aggregator: ~40 LOC, builds the Record
  core.ts               — 1 export const = string template, ~55 LOC
  prompt.ts             — ~55 LOC
  context.ts            — ~55 LOC
  tools.ts              — ~55 LOC
  guardrails.ts         — ~55 LOC
  observe.ts            — ~55 LOC
  session.ts            — ~55 LOC
  memory.ts             — ~55 LOC
  orchestration.ts      — ~55 LOC
  rag.ts                — ~55 LOC
  devkit.ts             — NEW: combines old eval/ + evolve/ templates (2 → 1) ~50 LOC
  subpath-map.ts        — NEW: one const table mapping ModuleName → import-path, exercised by F-3 build-time parser test
```

Largest file: <70 LOC. Median: ~55. PRD F-10 measure ("≤ 200 LOC") met with 3× headroom.

**`subpath-map.ts`** is the critical minimalist addition — instead of string-template literals hard-coding `'harness-one/core'`, the template uses `${SUBPATH_MAP.core}`, and the map is a single source of truth the F-3 build-time parser test verifies against `harness-one/package.json#exports`:

```ts
// packages/cli/src/templates/subpath-map.ts
export const SUBPATH_MAP = {
  core:          'harness-one/core',
  prompt:        'harness-one/prompt',
  context:       'harness-one/context',
  tools:         'harness-one/tools',
  guardrails:    'harness-one/guardrails',
  observe:       'harness-one/observe',
  session:       'harness-one/session',
  memory:        'harness-one/memory',
  orchestration: 'harness-one/orchestration',
  rag:           'harness-one/rag',
  devkit:        '@harness-one/devkit',   // <-- unified; old eval/evolve merge into one template
} as const satisfies Record<string, string>;
```

The F-3 parser test (`packages/cli/src/__tests__/subpaths-resolve.test.ts`) reads `harness-one/package.json`, reads `@harness-one/devkit/package.json`, and asserts every value in `SUBPATH_MAP` is resolvable — failing fast if F-1 or F-4 later yanks a subpath the CLI still emits.

### 8.3 Why not group templates

Considered: group by "beginner/intermediate/advanced" or "runtime/devkit". Rejected — alphabetical by module is the one ordering every human and grep agrees on; any other grouping is bike-shedding.

---

## 9. Package version coordination (PD-2: changeset `linked`)

### 9.1 `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "access": "public",
  "baseBranch": "main",
  "linked": [[
    "harness-one",
    "@harness-one/cli",
    "@harness-one/devkit",
    "@harness-one/native-deps",
    "@harness-one/preset",
    "@harness-one/openai",
    "@harness-one/anthropic",
    "@harness-one/redis",
    "@harness-one/langfuse",
    "@harness-one/opentelemetry"
  ]],
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

All ten packages in one linked group. A patch to `harness-one/infra/lru-cache.ts` bumps every package by patch; a breaking change in `@harness-one/openai` bumps every package by major. Yes, this means `@harness-one/langfuse` publishes a version whenever `harness-one` does, even if nothing changed in langfuse — **that is the intended cost** of lockstep. It is cheaper than the failure mode of "which version of `@harness-one/openai` is compatible with `harness-one@1.2.0`?" that independent trains create.

### 9.2 Workspace protocol for internal deps

Every `@harness-one/*` package's `dependencies` entry for `harness-one` (or any sibling): `"harness-one": "workspace:*"`. `pnpm publish` rewrites to the concrete version at publish time. This matches what HEAD already does (verified in `packages/ajv/package.json` line with `"harness-one": "workspace:*"`).

### 9.3 F-12 `pnpm verify:deps` script

```ts
// tools/verify-deps.ts
// For every packages/*/src/**/*.ts:
//   grep `from ['"]harness-one[/'"]` and `from ['"]@harness-one\/[^/]+`;
//   for each hit, assert the enclosing package.json lists that pkg in deps/peerDeps/optionalDeps.
// Exits non-zero with file:line on mismatch. ~80 LOC.
```

Runs in `api-check` CI job. Zero external deps — pure Node + fs.

### 9.4 Publish flow

- `pnpm changeset` — interactive add; picks "linked" group automatically.
- `pnpm changeset version` — bumps all ten `package.json`s + regenerates each CHANGELOG.md.
- `pnpm -r build && pnpm api:check && pnpm verify:deps` — gate.
- `pnpm changeset publish` — topological publish (native-deps → core → everyone else → preset last).

Wave-5C: no `npm publish` of actual artifacts (per NG-2). Only the placeholder for `@harness-one/core` **if and only if ADR 9.a picks rename — which this proposal explicitly does not**. So F-14 closes as N/A under this proposal.

---

## 10. Examples migration plan (F-13)

### 10.1 Verified import map

Against HEAD `examples/`:

| File | Current | Target |
|---|---|---|
| `examples/full-stack-demo.ts:15` | `import type { Scorer } from 'harness-one/eval'` | `'@harness-one/devkit/eval'` |
| `examples/full-stack-demo.ts:20` | `import { createEvalRunner } from 'harness-one/eval'` | `'@harness-one/devkit/eval'` |
| `examples/eval/llm-judge-scorer.ts:8` | `from 'harness-one/eval'` | `'@harness-one/devkit/eval'` |
| `examples/eval/llm-judge-scorer.ts:119` | `from 'harness-one/eval'` | `'@harness-one/devkit/eval'` |
| (none external) | `harness-one/evolve` | n/a (only `templates.ts` emits it, and it moves to `@harness-one/devkit/evolve`) |
| (none external) | `harness-one/cli` | n/a |

Other example imports (`harness-one/tools`, `harness-one/memory`, `harness-one/observe`, `harness-one/context`, `harness-one/guardrails`, `harness-one/core`) survive F-1 because those subpaths stay (§3.1).

### 10.2 `examples/package.json` (create — currently absent)

```json
{
  "name": "harness-one-examples",
  "version": "0.0.0-internal",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "harness-one": "workspace:*",
    "@harness-one/devkit": "workspace:*",
    "@harness-one/openai": "workspace:*",
    "@harness-one/anthropic": "workspace:*",
    "@harness-one/redis": "workspace:*",
    "@harness-one/langfuse": "workspace:*",
    "@harness-one/native-deps": "workspace:*",
    "@harness-one/opentelemetry": "workspace:*",
    "typescript": "^5.5.0"
  }
}
```

### 10.3 CI step

```yaml
- name: Typecheck examples
  run: pnpm -C examples typecheck
```

Added to `.github/workflows/ci.yml` main job. Green = F-13 acceptance for F-4.

### 10.4 Codemod (optional; Wave-5G)

Not needed in Wave-5C — the 4 sed replacements fit in the F-4 PR diff by hand. Codemod bundle deferred to Wave-5G per LD-4.

---

## 11. Risks / what minimalism trades away

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R-A1 | Merging ajv + tiktoken into `@harness-one/native-deps` confuses consumers who only want one peer installed | Medium | Low | Subpath-per-peer exports (`./ajv`, `./tiktoken`) mean `@harness-one/native-deps/ajv` is as precise as `@harness-one/ajv` was; `peerDependenciesMeta.optional` keeps install size honest. |
| R-A2 | Keeping the name `harness-one` (not `@harness-one/core`) makes the scope asymmetric: six `@harness-one/*` + one top-level | Low | Low | The asymmetry is already there (HEAD ships both). Renaming now wastes npm ceremony for pre-1.0 SEO that doesn't exist. |
| R-A3 | Shrinking root barrel to 18 symbols forces many existing in-repo consumers (preset, examples) to switch to subpath imports | High | Low | The 30+ affected import sites are mechanical; `sed -i 's|from .harness-one.|from "harness-one/<subpath>"|` per symbol. |
| R-A4 | "Untagged = `@stable`" in 5C.1 means every existing export becomes a frozen contract when tags land | Medium | Medium | 5C.1 ADR 9.g decision; the F-1 trim (§3/§4) pre-filters the root barrel to symbols we actually want frozen. Symbols we're unsure about go to subpath-only — they get their `@stable` tag later, not because we are unsure but because we do not re-export them today. |
| R-A5 | No CJS for `@harness-one/devkit` breaks a Jest-in-CJS consumer | Low | Low | Devkit is a devDep; modern Jest handles ESM; the niche breakage is worth the halved build matrix. |
| R-A6 | ESLint rule does not catch `require('harness-one/dist/infra/lru-cache.js')` from a CJS consumer | Low | Low | Mitigated by `rimraf dist/infra` post-build (§6.3). This is a real closure, not a lint warning. |
| R-A7 | `ADAPTER_CUSTOM` escape becomes the dumping ground — adapters never get dedicated prefixes | Medium | Medium | Accept. 1.0-rc is not the time to fine-grain every adapter's code-space. A Wave-5G or 2.0 can promote well-worn ADAPTER_CUSTOM codes into `OPENAI_*`, etc. |
| R-A8 | One linked changeset group means a `@harness-one/langfuse` patch publishes all ten packages | High | Low | Intentional; lockstep is the PD-2 decision. Cost is 10 × `npm publish` per release (~45s); benefit is zero version-drift questions. |
| R-A9 | Dropping `harness-one/essentials` orphans anyone who adopted it | Low | Low | No verified consumers — HEAD ships it but `grep -rn "harness-one/essentials"` across `packages/` + `examples/` produces zero hits. |

### Where minimalism honestly hurts

- **Native-deps merge** is a genuine cost to the consumer who installs *only* `ajv`-glue — they pay 10 KB of tiktoken-wrapper code in their `node_modules` (not in their bundle, since tiktoken peer isn't installed and nothing references it). This is less than one package-lock entry's worth of pain, but it is real.
- **Barrel at 18** costs SDK consumers a `cmd-p` lookup instead of IntelliSense discovery for any factory we demoted to subpath-only. In return we get a 1.0 contract we can actually defend for a year.
- **No `@harness-one/core` rename** means consumers who type-into-npm "harness-one" find `harness-one` at 0.4.x and `@harness-one/core` at nothing — 12 months from now when we publish 1.0 under the old name, this will look like a missed branding opportunity. Accepted trade.

---

## 12. Defence against expected attacks

### 12.1 Architect B: "consumers want clearer boundaries; ajv/tiktoken merge confuses dep selection"

**Counter**: "clearer boundaries" is the aesthetic of somebody who maintains many packages and will not pay the tax. Verify: `pnpm -C packages/ajv build && pnpm -C packages/tiktoken build` is **two builds**, **two test harnesses**, **two CHANGELOG entries**, **two `api-extractor.json`s**, **two lines in every matrix CI config**, **two rows in our changeset linked list**, **two versioned package.json to bump every release**, **two CVE advisories to triage when Ajv ships one**. The alleged "dep selection clarity" is a consumer writing `@harness-one/ajv` vs `@harness-one/native-deps/ajv` — same 11 characters of typing, and the `native-deps/ajv` variant is *more* self-documenting ("this is the ajv glue inside our native-deps umbrella"). Nobody asks for "clearer boundaries" at the install site after they have typed `pnpm add` three times in their career; they ask for them the first week and forget about them forever. The merge costs one `peerDependenciesMeta.optional` block and pays for itself the first time we ship a shared-internal refactor to both.

**Concrete evidence**: `packages/ajv/src/index.ts` is **30 lines of boilerplate + the actual glue**; `packages/tiktoken/src/index.ts` is the same. Both pull from `harness-one/tools`, `harness-one/observe`, `harness-one/core`, `harness-one/context`. They share zero implementation code *because* we split them before we noticed they could share utility. Merged, they can share validation helpers, a common "peer missing, here's the install command" error path (`HarnessError('ADAPTER_INVALID_EXTRA', 'install <peer>')`), and a single `README.md` that teaches the "peer dep pattern" once instead of twice.

### 12.2 Architect C: "npm best practice is one-job-per-package; merging native deps is anti-pattern"

**Counter**: "npm best practice" is whose practice? `@babel/preset-env` is one package that contains fifty plugins. `@radix-ui/react-primitives` is thirty components under one roof when needed. `lodash-es` is four hundred functions in one tree-shakable package. The one-job-per-package norm is a heuristic for authors shipping *one identifiable concern* — and "harness-one's native-deps glue" *is* one concern: it is the set of thin adapters between harness-one's interfaces and third-party Node-native modules. The peer-dep optional-install pattern *is* the dependency-selection mechanism — consumers who want only Ajv install `ajv` as a peer, tiktoken is not pulled in at runtime. The package boundary is not where the user's mental model splits; it is where the maintainer's workload splits, and two packages for two 30-LOC files is the anti-pattern.

**Concrete evidence**: The repo already violates "one job per package" intentionally. `harness-one` itself is 65,299 LOC of loop + tools + prompt + context + guardrails + observe + session + memory + orchestration + rag — ten concerns in one package. PRD §3 calls this "god-package" and extracts *two* (cli, devkit), leaving **ten** concerns. Nobody proposed splitting `harness-one` into ten packages — because the cost of ten packages would outstrip the benefit, which is exactly the argument here at smaller scale. The consistent application of "one concern per package" means forty packages, not ten. The consistent application of "one package per team's maintenance unit" means three to eleven. We are already in the second regime. Merging ajv + tiktoken is not anti-pattern; it is *recognising the regime we are actually in*.

**Sharpest single counter**: *If `@harness-one/ajv` and `@harness-one/tiktoken` were best-practice independent packages, their independent versions would matter — and they don't. Both lockstep via PD-2's linked changeset. A package whose version never moves independently is not a package; it is a subpath with extra ceremony.*

---

## ADRs (inline, concise)

### ADR-5C-A-01 — Keep `harness-one` as top-package name
**Status**: Proposed
**Decision**: Do not rename to `@harness-one/core`. Keep `harness-one` for 1.0-rc.
**Consequences**: F-14 closes as N/A; no npm placeholder ceremony; scope asymmetry between `harness-one` + six `@harness-one/*` siblings remains (it is already there in HEAD).
**Alternative rejected**: Rename — pure ceremony cost, pre-1.0 SEO surface is negligible (no 1.0-series on npm yet), and the Wave-5G deprecation path for the old name is still open if we change our minds.

### ADR-5C-A-02 — Merge ajv + tiktoken → `@harness-one/native-deps`
**Status**: Proposed
**Decision**: One package, two subpath exports (`./ajv`, `./tiktoken`), both peers optional.
**Consequences**: −1 package in CI matrix, −1 changeset linked entry, one shared README teaching the peer-dep pattern. Consumers use `@harness-one/native-deps/ajv` (11 chars typed vs `@harness-one/ajv`).
**Alternative rejected**: Keep separate (Architect C's position) — no shared implementation today, but that is precisely because no one has had the affordance; merging creates the affordance.

### ADR-5C-A-03 — `infra/` name, in-src-only lint barrier, build-time `rm dist/infra`
**Status**: Proposed
**Decision**: Rename `_internal/` → `infra/`; ESLint `no-restricted-imports` per §6.2; post-build `rimraf dist/infra` closes the deep-dist gap.
**Consequences**: 19 importer files get a `sed`-only rename; reach-in future-proofed at lint time AND at artifact time.
**Alternative rejected**: `internal/` (keeps underscore confusion); `private/` (reserved word vibes).

### ADR-5C-A-04 — Closed `HarnessErrorCode` via grouped `as const` tuples + `ADAPTER_CUSTOM` escape
**Status**: Proposed
**Decision**: Per §5.1. Template-literal-union via `(typeof PREFIX_CODES)[number]`, not enum, not const enum. `ADAPTER_CUSTOM` + `details.adapterCode: string` is the adapter subclass escape.
**Consequences**: Compile-time exhaustiveness tests; codemod-friendly renames; zero runtime overhead; adapter subclasses get autonomy without reopening the union.
**Alternatives rejected**: `enum` (runtime bytes + lost structural typing); `const enum` (breaks isolatedModules); open union `| (string & {})` (the status quo we are fixing).

### ADR-5C-A-05 — Per-package api-extractor; 11 invocations for `harness-one` subpaths
**Status**: Proposed
**Decision**: Per §7. One `api-extractor.json` per package; `harness-one` additionally gets one per subpath (11 configs). `bundledPackages: []` everywhere.
**Consequences**: ~20 `*.api.md` files tracked; CI matrix finishes in ~6s; diffs are small and readable.
**Alternative rejected**: Single repo-level config — single `mainEntryPointFilePath` cannot cover subpaths.

### ADR-5C-A-06 — Linked changeset group (all 10 packages)
**Status**: Proposed (satisfies PD-2)
**Decision**: Per §9.1. Every package in one `linked` list.
**Consequences**: Every release publishes all 10 packages; zero version-drift questions; changeset UX simplified.
**Alternative rejected**: Independent trains — re-introduces the compatibility matrix Wave-5C is supposed to eliminate.

### ADR-5C-A-07 — Kill `harness-one/essentials`
**Status**: Proposed (satisfies ADR 9.i/9.j inputs)
**Decision**: Remove the `./essentials` subpath export from `harness-one/package.json`; delete `packages/core/src/essentials.ts`.
**Consequences**: Three entries (root / essentials / subpath) → two (root / subpath); zero verified consumers (`grep -rn "harness-one/essentials"` in `packages/` + `examples/` = 0 hits).
**Alternative rejected**: Keep it — perpetuates "which entry do I use?" confusion that PRD §2.1 explicitly calls out.

### ADR-5C-A-08 — `@harness-one/devkit` is ESM-only
**Status**: Proposed
**Decision**: No CJS build for devkit. Module only.
**Consequences**: 50 % faster devkit build; niche failure mode for a Jest-in-CJS consumer.
**Alternative rejected**: Dual CJS+ESM — devkit is a devDep; in 2026 every sane test runner speaks ESM.

### ADR-5C-A-09 — Untagged = `@stable` default (5C.1 position; noted here for continuity)
**Status**: Proposed (Wave-5C.1 input)
**Decision**: When F-7 lands in 5C.1, default for untagged public symbols is `@stable`. If you exported it, you support it.
**Consequences**: Aggressive; forces the F-1 trim to be genuinely minimal (§4.1/§4.3 already is).
**Alternative rejected**: Build-fail on untagged (critique §7 frontrunner) — mechanically equivalent during rc because you'd have to tag everything anyway; `@stable` default is less ceremony.

---

## 200-word summary

**Package map (one-liner each)**:
1. `harness-one` — runtime (keep name; 11 subpaths; `infra/` sealed).
2. `@harness-one/cli` — new; binary only; `templates/` split into 12 files.
3. `@harness-one/devkit` — new; `eval` + `evolve`, ESM-only.
4. `@harness-one/native-deps` — **MERGED** `ajv` + `tiktoken`, two subpaths, optional peers.
5. `@harness-one/preset` — unchanged minus `eventBus` dead-stub.
6-10. `openai`, `anthropic`, `redis`, `langfuse`, `opentelemetry` — unchanged.
**Delete**: `packages/full/` (no `package.json`), `harness-one/essentials` (zero consumers). **Net**: 10 → 10 packages, two PRD-mandated extractions absorbed by one merge + one delete.

**Root barrel size**: **18 value symbols** + unbounded type-only re-exports (7 slots under the PRD ≤ 25 ceiling). `createSecurePreset` re-exported from `@harness-one/preset`; `createEventBus`, `assertNever`, `StreamAggregator`, SSE helpers, all guardrail run*, all prompt factories, all context factories, all secondary observe factories, all memory factories, `MessageQueue`, `createRAGPipeline` all demoted to subpath.

**Sharpest counter to expected attackers**: a package whose version never moves independently under PD-2 lockstep is not a package — it is a subpath with extra ceremony. Merging `ajv` + `tiktoken` into `@harness-one/native-deps` recognises the regime we are already in and cuts recurring maintenance cost without costing consumers a character of typing.
