---
"harness-one": minor
"@harness-one/preset": minor
"@harness-one/langfuse": minor
"@harness-one/openai": minor
"@harness-one/anthropic": minor
---

Architecture cleanup — second review pass

Structural changes resolving issues surfaced by a deep architecture review:

**Dependency-layer correctness (P0)**
- Moved `Logger` / `createLogger` into `infra/` so `infra/safe-log.ts` stops reverse-importing from `observe/`. `observe/logger.ts` is now a thin re-export shim; the public `harness-one/observe` surface is unchanged.
- Introduced `core/guardrail-port.ts` — an opaque port interface that `core/iteration-runner.ts` and `agent-loop.ts` depend on. `@harness-one/guardrails`' `createPipeline()` now returns an object implementing the port, eliminating the runtime `core → guardrails` edge. Free-function wrappers (`runInput` / `runOutput` / `runToolOutput` / `runRagContext`) stay as back-compat shims and keep the existing `HarnessError(GUARD_INVALID_PIPELINE)` contract for forged tokens.
- Unified `_internal/` → `infra/` references across all live architecture docs. Source tree never had an `_internal/` directory.

**Large-file splits (P1)**
- `preset/src/index.ts` 1108 → 79 LOC. `createHarness()` body and helpers moved to `preset/src/build-harness/{adapter,exporters,memory,guardrails,run,types}.ts`.
- `langfuse/src/index.ts` 991 → 26 LOC. Split into `exporter.ts`, `prompt-backend.ts`, `cost-tracker.ts`.
- `openai/src/index.ts` 1032 → 31 LOC. Split into `providers.ts`, `convert.ts`, `adapter.ts`.
- `anthropic/src/index.ts` 677 → 23 LOC. Split into `convert.ts`, `adapter.ts`.
- `core/observe/trace-manager.ts`, `core/observe/cost-tracker.ts`, `core/session/manager.ts` — public interfaces extracted to sibling `*-types.ts` files.
- `core/core/agent-loop.ts` — config validation extracted to `agent-loop-validation.ts`.

**Cross-package dedup (P2)**
- Promoted `createRedactor` / `sanitizeAttributes` / `REDACTED_VALUE` / `DEFAULT_SECRET_PATTERN` / `POLLUTING_KEYS` to the public `harness-one/observe` surface. `@harness-one/langfuse` now delegates to them; its previously inlined secret-pattern copy is removed.

**Breaking changes (P3 — pre-1.0 cleanup)**
- `CostTracker.setPricing()` / `setBudget()` removed. Use `createCostTracker({ pricing, budget })` at factory time or the async `updatePricing()` / `updateBudget()` for runtime mutation. `LangfuseCostTrackerConfig` now accepts `pricing` / `budget`.
- `createEventBus` / `EventBus` / `EventBusOptions` / `EventHandler` removed — unused module.
- `AgentLoop` class is no longer `@deprecated`; factory (`createAgentLoop`) remains the idiomatic entry, class stays as its return type for `instanceof` / type-reference usage.

**Comment cleanup (P4)**
- Stripped ~391 lines of audit-ID archaeology (`Wave-XX`, `T-NN`, `SEC-`, `PERF-`, `CQ-`, `ARCH-`, `P1-…`, `OBS-…`, `Fix N`) from the hottest files while preserving rationale / invariants / security notes.

All 4255 tests continue to pass; `pnpm typecheck`, `pnpm lint`, `pnpm build` are green; api-extractor baselines regenerated.
