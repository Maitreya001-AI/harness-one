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

**Wave-5C PR-3 — surface lock: barrel trim + HarnessErrorCode rename + api-extractor gate (BREAKING).**

Third of three PRs on `wave-5/production-grade` that finalise the 1.0-rc
package boundaries (see `docs/forge-fix/wave-5/wave-5c-adr.md` §5 / §6 / §7).

## F-1: root barrel trimmed to 19 curated value exports

Previously the unscoped `harness-one` package re-exported ~40 factories
and utilities from its submodules. The root now ships 19 value symbols
covering the primary user journeys (UJ-1..UJ-5 per `wave-5c-prd-v2.md`
§5); every other runtime factory must be imported from its owning
subpath (`harness-one/core`, `harness-one/tools`, `harness-one/guardrails`,
`harness-one/observe`, `harness-one/session`, `harness-one/infra`) or
from a sibling package (`@harness-one/cli`, `@harness-one/devkit`,
`@harness-one/preset`).

**Per R-01 lead decision, `createSecurePreset` is NOT re-exported from
the root.** Importing it from `harness-one` previously caused a
three-leg cycle (`harness-one` → `@harness-one/preset` → `harness-one`)
that tsup resolved lazily at call time. Import it directly:

```ts
- import { createSecurePreset } from 'harness-one';
+ import { createSecurePreset } from '@harness-one/preset';
```

Type-only re-exports at the root remain unbounded (zero runtime bundle
cost per ADR §5.2).

## F-6: HarnessErrorCode closed + module-prefixed

`HarnessError.code` is no longer widened with `(string & {})` — it
types as the closed enum, so `switch` exhaustiveness now holds. Enum
members are renamed to module-prefixed form. Sed-style migration:

```
s/HarnessErrorCode\.UNKNOWN\b/HarnessErrorCode.CORE_UNKNOWN/
s/HarnessErrorCode\.INVALID_CONFIG\b/HarnessErrorCode.CORE_INVALID_CONFIG/
s/HarnessErrorCode\.INVALID_STATE\b/HarnessErrorCode.CORE_INVALID_STATE/
s/HarnessErrorCode\.INTERNAL_ERROR\b/HarnessErrorCode.CORE_INTERNAL_ERROR/
s/HarnessErrorCode\.MAX_ITERATIONS\b/HarnessErrorCode.CORE_MAX_ITERATIONS/
s/HarnessErrorCode\.ABORTED\b/HarnessErrorCode.CORE_ABORTED/
s/HarnessErrorCode\.GUARDRAIL_VIOLATION\b/HarnessErrorCode.GUARD_VIOLATION/
s/HarnessErrorCode\.GUARDRAIL_BLOCKED\b/HarnessErrorCode.GUARD_BLOCKED/
s/HarnessErrorCode\.INVALID_PIPELINE\b/HarnessErrorCode.GUARD_INVALID_PIPELINE/
s/HarnessErrorCode\.MEMORY_CORRUPT\b/HarnessErrorCode.MEMORY_DATA_CORRUPTION/
s/HarnessErrorCode\.STORE_CORRUPTION\b/HarnessErrorCode.MEMORY_DATA_CORRUPTION/
# bare-string literal forms — do the same with 'CORE_UNKNOWN' etc.
s/'UNKNOWN'/HarnessErrorCode.CORE_UNKNOWN/
s/'MAX_ITERATIONS'/HarnessErrorCode.CORE_MAX_ITERATIONS/
s/'GUARDRAIL_VIOLATION'/HarnessErrorCode.GUARD_VIOLATION/
# provider errors must fold into ADAPTER_ERROR or ADAPTER_CUSTOM
s/'PROVIDER_ERROR'/HarnessErrorCode.ADAPTER_ERROR/
s/'NOT_FOUND'/HarnessErrorCode.MEMORY_NOT_FOUND/
```

Adapter migration example (ADR §6 verbatim):

```ts
// before
throw new HarnessError('Unsupported mode', 'MY_PROVIDER_BAD_MODE');
// after — adapters use the ADAPTER_CUSTOM escape hatch + typed sub-code
throw new HarnessError(
  'Unsupported mode',
  HarnessErrorCode.ADAPTER_CUSTOM,
  'Upgrade to the version that supports bidirectional streams',
  undefined,
  { adapterCode: 'MY_PROVIDER_BAD_MODE' },
);
```

**`import type { HarnessErrorCode }` silently drops the runtime
`Object.values()` record.** A new lint rule
`harness-one/no-type-only-harness-error-code` flags the mistake at
lint time — always value-import:

```ts
import { HarnessErrorCode } from 'harness-one'; // correct
import type { HarnessErrorCode } from 'harness-one'; // ❌ lint error
```

New codes added alongside the rename (non-breaking): full `ADAPTER_*`,
`MEMORY_*`, `SESSION_*`, `TRACE_*`, `ORCH_*`, `PROMPT_*`, `RAG_*`,
`EVOLVE_*`, `CONTEXT_*`, `LOCK_*`, `POOL_*`, `EVAL_*` families, plus
`TOOL_INVALID_SCHEMA`, `TOOL_CAPABILITY_DENIED`, and
`PROVIDER_REGISTRY_SEALED`. See `packages/core/src/core/errors.ts` for
the authoritative enum.

## F-8: api-extractor CI gate (snapshot-diff mode)

A new `.github/workflows/api-check.yml` runs on every PR:

1. `pnpm api:check` fails if any `packages/*/etc/*.api.md` is out of
   date relative to the committed snapshot.
2. `tools/check-api-rationale.ts` fails if any api.md diffs vs base
   without a `## API change rationale` section (≥20 chars) in the PR
   body.

Stability-tag enforcement (untagged-export rejection) stays OFF in main
per decisions-doc PD-3 — Wave-5C.1 will flip it after the tag audit.

## F-14: scoped-name reservations (deferred execution)

`@harness-one/core`, `/runtime`, `/sdk`, `/framework` published at
`0.0.0-reserved` to squat names. Actual `npm publish` is blocked pending
org-admin token (R-3.C) and will land in a follow-up commit.

## Verification

- `pnpm -r typecheck` + `pnpm -r test` green across all 12 workspace
  packages (~3800 tests).
- `pnpm -r lint` green; custom rule verified against
  `packages/openai/src/__lint-fixtures__/type-only-error-code.ts`.
- `pnpm api:update` regenerated `packages/core/etc/harness-one.api.md`
  (barrel trim reduced it by ~1500 lines); the other 10 snapshots were
  already aligned.

## API change rationale

The root-barrel surface shrank from ~40 to 19 value exports because the
previous surface was accretive — every wave added a few more
"convenience" re-exports without a UJ test. The resulting root package
forced bundlers to pin modules that most consumers never touched and
exposed internal factories (`createEventBus`, `assertNever`,
`categorizeAdapterError`, ...) as load-bearing API. The curated
19-symbol set maps 1:1 to the documented user journeys; everything else
moved to its owning subpath (still tree-shakable, still directly
importable) or to a sibling package where it semantically belongs.
`HarnessErrorCode` closure removes the last `(string & {})` widening in
the core type surface so consumer `switch` statements compile
exhaustively; the module-prefix rename is the one-time cost of closing
the enum without losing disambiguation between cross-module
near-duplicates (`SESSION_NOT_FOUND` vs `MEMORY_NOT_FOUND` vs
`PROMPT_SKILL_NOT_FOUND` etc.).
