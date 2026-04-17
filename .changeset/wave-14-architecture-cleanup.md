---
'harness-one': patch
'@harness-one/preset': patch
'@harness-one/langfuse': patch
---

Wave-14 architecture cleanup (14 findings addressed)

**Extractions (back-compat preserving, new focused modules):**
- `core/adapter-timeout.ts` — `withAdapterTimeout` helper extracted from `adapter-caller.ts` (581→511 lines). Includes optional MetricsPort for `harness.adapter.orphan_after_timeout` counter.
- `core/infra/validate.ts` — shared `requirePositiveInt` / `requireFinitePositive` / `validatePricingArray` / … helpers. Preset and core now share validation rules so fractional/NaN/negative values are rejected identically.
- `preset/build-harness/wire-components.ts` — component wiring extracted from `run.ts` (679→471 lines).
- `orchestration/shared-context-store.ts` — `createSharedContext` factory extracted from `orchestrator.ts`.
- `orchestration/delegation-tracker.ts` — cycle-detection + size-cap + per-source locks extracted from `orchestrator.ts` (658→502 lines).
- `session/session-event-bus.ts` — re-entry-safe event dispatch with priority-aware drop.
- `session/session-lru.ts` — lock-aware LRU with amortised eviction. Manager shrunk 637→437 lines.
- `observe/trace-view.ts` — pure `toReadonlyTrace` snapshot builder extracted from `trace-manager.ts`.

**Public API additions (back-compat):**
- `AgentLoopConfigV2` — nested-form public config with `{ execution, limits, resilience, observability, pipelines }` groups. Flat `AgentLoopConfig` still accepted.
- `CostTracker.getCostByModelMap(): ReadonlyMap<string, number>` — O(1) membership counterpart to `getCostByModel()`.
- `SharedContext.get<T>(key)` — typed-generic overload for narrowing at the boundary.
- `harness-one/redact` public subpath — canonical home for redaction primitives.
- `ADAPTER_RETRY_JITTER_FRACTION` / `AGENT_POOL_IDLE_JITTER_FRACTION` named constants.

**Stricter contracts:**
- `HarnessConfig` now enforces adapter XOR client at compile time (discriminated union) plus a runtime guard with a clear migration error.
- `infra → core subsystems` forbidden via new ESLint layering rule (see `docs/ARCHITECTURE.md`).

**Deprecations (removal scheduled for v2.0):**
- `GuardrailBlockedError` — use `new HarnessError(..., HarnessErrorCode.GUARD_VIOLATION)`.
- Redact re-exports from `harness-one/observe` — use `harness-one/redact`.
- `HarnessErrorCode.MEMORY_STORE_CORRUPTION` / `MEMORY_DATA_CORRUPTION` — use `MEMORY_CORRUPT`.

**Documentation:**
- Added `MIGRATION.md` with deprecation timeline.
- Added `docs/ARCHITECTURE.md` with the five-layer contract.

**Test suite:**
- +83 new focused tests (4309 → 4392 passing).
- `agent-loop.test.ts` header now explicitly scopes it as the integration suite; new unit tests land in `adapter-timeout.test.ts`, `validate.test.ts`, `agent-loop-config-v2.test.ts`, `shared-context-store.test.ts`, `delegation-tracker.test.ts`, `session-event-bus.test.ts`, `session-lru.test.ts`, `trace-view.test.ts`, `redact-barrel.test.ts`.
