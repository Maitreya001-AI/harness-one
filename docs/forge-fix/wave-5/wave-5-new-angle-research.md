# Wave-5 New-Angle Research — Gap Analysis vs Existing Roadmap

**Date:** 2026-04-15 (post-1.0-rc.1, after Wave-5A ✅ / 5B ✅ / 5C in-progress)
**Method:** 5 parallel `Explore` agents scoped to angles the prior wave-1..4 audits did not enter — error UX & diagnosability, backpressure & resource limits, public API ergonomics & DX, test quality (not coverage), integration failure modes.
**Purpose:** Identify findings **not** already in `wave-5d-brief.md` / `wave-5e-brief.md` / `wave-5f-brief.md` so the roadmap either absorbs them or explicitly defers.

71 raw findings → 58 unique → **19 NOVEL** (not in any brief), **28 COVERED** (in 5D/5E/5F), **11 OBSOLETED-BY-5A/5B/5C** (already landed on main).

---

## 1. Coverage Matrix

### Already addressed by waves 5A / 5B / 5C (on main as of 2026-04-15)

| Raw ID | Finding | Resolved by |
|--------|---------|-------------|
| EUX-009 | `'ADAPTER_UNKNOWN'` string literal defeats typed enum | Wave-5C PR-1b `HarnessErrorCode` enum + `(string & {})` documented vendor path + `details.adapterCode` (ADR §5.2) |
| DX-002 | God-module `agent-loop.ts` 986 LOC | Wave-5B decomposition (agent-loop 845, iteration-runner 656, adapter-caller 400, stream-handler 161) |
| DX-004 | Deprecated EventBus root export | Wave-5C PR-1b eventBus stub + root export cleanup |
| DX-009 | No systematic `@internal` + api-extractor gate | Wave-5C PR-1c api-extractor baselines + `verify-deps` |
| DX-013 | Root barrel mixes primitives with peer re-exports | Wave-5C PR-2 cli/devkit/examples split |
| BP-006 | `isEvicting` boolean re-entrance guard | Wave-4c already replaced with AsyncLock — my finding was from stale memory, verify only |
| SF-004 (partial) | `pendingExports` unbounded | Partially addressed in wave-4c (bounded LRU); egress cap still missing — see **N-01** |
| (prior) | EventBus module unused | Wave-5A already stubbed |

Cited in my 2026-04-15 pre-sync research but now **partially or wholly stale**. Do not re-plan.

### Already in scope of Wave-5D (Observability Canonical)

Overlap with `wave-5d-brief.md` findings ARCH-5, ARCH-6, ARCH-7, ARCH-8, m-6:

| Raw ID | Overlap |
|--------|---------|
| SF-004, BP-001 | ARCH-5 / m-6 — pendingExports cap + exporter timeouts (merge 5D deliverable) |
| SF-008 | ARCH-5 — OTel canonical wiring; add "no-SDK detect" test as 5D acceptance |
| SF-010 | ARCH-6 — lifecycle state machine drain order |
| BP-002 | ARCH-8 — adapter-level circuit breaker |
| BP-007 | ARCH-8 — retry/backoff policy (bring 50% equal jitter) |
| BP-008 | ARCH-5 — CostTracker fate decision (delete vs keep as domain aggregator) |
| BP-010 | ARCH-8 — AdmissionController / per-tenant quota |
| BP-005 | ARCH-6 — MessageQueue default = opt-in backpressure |

**Action:** Append the raw-ID references to `wave-5d-brief.md` under each ARCH-N section; no separate wave needed.

### Already in scope of Wave-5E (Trust Boundaries)

| Raw ID | Overlap |
|--------|---------|
| SF-006 | SEC-A08 / Redis tenant key migration; add typed `REDIS_READONLY` as part of E2 |
| EUX-002 | SEC-A05-adjacent — boundary-level payload typing; add typed "non-Error cause preservation" acceptance |

### Already in scope of Wave-5F (Cleanup)

| Raw ID | Overlap |
|--------|---------|
| EUX-007 | m-1 — `try{logger.warn}catch{}` guard-the-guard → `safeLog` wrapper |
| DX-008 | m-1-adjacent — console.warn-before-logger |
| EUX-003 | m-1-adjacent — hook error structured logging |

---

## 2. NOVEL findings — not in any brief

These 19 are the actual value-add of this research. Proposed disposition beside each.

### 2.1 Stream-protocol edges on LLM providers (P0)

| ID | File:line | Finding | Suggested home |
|----|-----------|---------|----------------|
| **N-01** | `packages/anthropic/src/index.ts:389-414` | Partial-stream disconnect (TCP RST before `message_stop`) exits for-await with no synthetic `done`. Zero tokens, empty-success. | **New wave-5G**: Provider-stream resilience — or fold into 5D as ARCH-5 acceptance |
| **N-02** | `packages/openai/src/index.ts:602-619` | `[DONE]` + usage on same final chunk; consumer `.return()` on abort → usage never read → silent zero cost | Same as N-01 |
| **N-03** | `packages/anthropic/src/index.ts:339-354` | No default timeout on `adapter.stream()`; provider hang orphans the request forever | Same as N-01 — add `providerStreamIdleTimeoutMs` default 60s |
| **N-04** | `packages/anthropic/src/index.ts:157-175` | Malformed `tool_use.input` JSON → substituted `{}`, raw string discarded. Impossible to debug model output drift | Same as N-01 — preserve `__raw_arguments` on tool-call |
| **N-05** | `packages/core/src/observe/trace-manager.ts:250` | `pendingExports` Set has no cap / no drop policy. Slow exporter = unbounded promise accumulation | Fold into 5D ARCH-5 as hard acceptance criterion (semaphore + drop metric) |

### 2.2 Error-context structure (P1)

Wave-5A consolidated the **error taxonomy**; the **payload** is still lossy.

| ID | File:line | Finding | Suggested home |
|----|-----------|---------|----------------|
| **N-06** | `packages/core/src/core/execution-strategies.ts:14-23, 60-77` | Tool failure error carries no toolCallId / toolName. Two concurrent "Timeout" errors indistinguishable | New mini-wave `5G-error-context` OR extend 5E brief §E5 |
| **N-07** | `packages/core/src/core/stream-handler.ts:143-152` | `cause` only when `err instanceof Error`; non-Error throws lose vendor trace IDs / status codes | Same |
| **N-08** | `packages/core/src/core/event-bus.ts:80-85` | Handler throw logged without handler identity; impossible to identify culprit among N handlers | Same |
| **N-09** | `packages/core/src/core/event-bus.ts:80-85` | Handlers invoked without awaiting returned promise — async-handler rejection escapes to global | Same |
| **N-10** | `packages/core/src/observe/trace-manager.ts:809-849` | `Promise.allSettled` → N individual rejection callbacks, never an `AggregateError` | Same; pairs naturally with 5D flush/drain |

**Consolidated proposal:** add `HarnessError.context: Readonly<Record<string, unknown>>` (next to `details`) + `serializeError()` helper + `HarnessAggregateError`. Land as a **small Wave-5G** (est. 3–5 days) between 5E and 5F.

### 2.3 DX / public-surface gaps (P1)

| ID | File:line | Finding | Suggested home |
|----|-----------|---------|----------------|
| **N-11** | `packages/core/src/core/agent-loop.ts:65-195` + preset factories | Config objects accept unknown keys silently (typo `maxIteration` vs `maxIterations` is hours-of-debug) | Extend **5C** task plan — API 1.0-rc should error on unknown keys |
| **N-12** | `packages/anthropic/src/index.ts:83-111`, `packages/openai/src/index.ts:98-136` | `strictExtraAllowList:false` default silently drops typos | Same — 1.0 hard default flip with 0.5.x deprecation warn |
| **N-13** | `packages/preset/src/index.ts:752-759` | Langfuse client validator `typeof client.trace === 'function'` passes an accidental Promise | Extend 5D exporter boot-validation |
| **N-14** | `packages/anthropic/README.md:17-37`, `packages/openai/README.md:17-34`, `packages/preset/README.md:26-44` | Quickstart examples lack `try/finally` + `shutdown()` — demonstrate a leak to every new user | One-off doc PR, no wave needed |
| **N-15** | `packages/openai/src/index.ts:166-223` | `registerProvider` + `sealProviders` module-scoped mutable state. Register-after-seal is runtime-only, no compile-time guarantee | Extend 5C — builder pattern `createOpenAIProviderRegistry().register().seal()` returning immutable |

### 2.4 Test-quality debt (P1)

**None** of the following is in any wave brief. Near-100% coverage is maintained but test shape is mock-mirror.

| ID | File | Finding |
|----|------|---------|
| **N-16** | `packages/anthropic/src/__tests__/anthropic.test.ts:70-76`, `packages/openai/src/__tests__/openai.test.ts:210-225`, `packages/langfuse/src/__tests__/langfuse.test.ts:79-89` | Adapter/exporter tests assert parameter shape against their own mocks → vendor SDK schema drift passes green |
| **N-17** | `packages/preset/src/__tests__/full.test.ts:7-66` | Preset "integration" test mocks every dependency — no real seam exercised |
| **N-18** | `packages/core/src/core/output-parser.ts:211` and other `/* istanbul ignore next */` | "Unreachable" error paths marked ignored; regression there has zero test safety net |
| **N-19** | all parser/validator tests | Zero property-based tests (`fast-check`) for output-parser / json-schema / LRU / MessageQueue |

**Suggested home:** New **Wave-5H** test-quality pass (est. 1 week) — scope: contract tests against real vendor SDK with noop-transport, remove every `istanbul ignore`, property-based tests for 4 core utilities. Queue AFTER 5D/5E land so seams being tested are the final shapes.

---

## 3. Recommendation to Lead

1. **No new wave for the "obvious" part.** 28 findings already fit cleanly into 5D/5E/5F; append the raw-IDs to each brief as concrete acceptance criteria (bumps existing briefs' density, not count).
2. **Add Wave-5G (error-context + streaming resilience)** — ~1 week, between 5E and 5F:
   - §2.1 stream-protocol edges (N-01..N-05) as 5G-P0
   - §2.2 error context structure (N-06..N-10) as 5G-P1
   - Natural boundary: "errors & stream protocol at external seams"
3. **Add Wave-5H (test-quality pass)** — ~1 week, AFTER 5D/5E:
   - §2.4 (N-16..N-19): contract tests, property tests, remove istanbul-ignore
4. **Fold §2.3 DX items** into the existing 5C PR-3+ work — these are within 5C's "API 1.0-rc" charter (PRD says "API 1.0-rc ready").
5. **One-off doc PR** for N-14 (README quickstart resource-leak fix) — not wave-worthy.

Resulting roadmap:
- 5C (in progress) — extend with N-11/12/13/15
- 5D — extend with N-01..N-05 as acceptance OR split into 5G
- 5E — as briefed
- **5G (new)** — error context + streaming resilience (19 LOC / 5 files touched, ~1 wk)
- 5F — as briefed
- **5H (new)** — test-quality pass (~1 wk)
- → 1.0.0

No P0 escapes the updated roadmap. The main behavioral-production gap (pendingExports + exporter timeout + provider-stream truncation) is now explicit and owned.
