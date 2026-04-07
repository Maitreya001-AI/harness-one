# Architecture Proposal A: "Minimal Composable Primitives"

**Philosophy**: Function-first, zero dependencies, maximum tree-shakeability
**Style**: zod, nanoid, date-fns

## Key Decisions
- All public APIs are pure functions or factory functions (no classes, no `new`)
- Core module has ZERO internal dependencies
- No barrel export at package root (forces subpath imports)
- Guardrails are plain functions: `(ctx) => result`
- Internal state via closures (opaque types)
- Minimal JSON Schema validator in `_internal/` (~200 lines, no ajv)
- Token counting via fast heuristic in `_internal/tiktoken-lite.ts`

## Directory Structure
```
src/
├── core/       (loop.ts, types.ts, errors.ts)
├── context/    (count-tokens.ts, budget.ts, pack.ts, compress.ts, cache-stability.ts)
├── tools/      (define-tool.ts, registry.ts, validate.ts)
├── guardrails/ (pipeline.ts, retry.ts, rate-limiter.ts, injection-detector.ts, schema-validator.ts, content-filter.ts)
└── _internal/  (json-schema.ts, tiktoken-lite.ts)
```

## Dependency Graph (acyclic)
- core → nothing
- context → _internal
- tools → _internal
- guardrails → _internal, tools/types (type-only)
- _internal → nothing

## Estimated: ~5,250 lines (including tests), ~25 days effort

## 6 ADRs proposed covering function-first API, opaque types, no barrel export, guardrails as functions, zero core deps, internal JSON Schema validator.

(Full proposal with complete TypeScript interfaces on file)
