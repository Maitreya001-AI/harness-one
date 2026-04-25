---
'harness-one': patch
'@harness-one/preset': patch
---

Layer 9 (dogfood) follow-ups: warning false-positive, vitest 4 timer regression, dogfood budget; plus README split.

**`harness-one` — `AgentLoopConfig.guardrailsManagedExternally?: boolean`** added (additive, optional). Wrapper-layer opt-in: when `true`, suppresses the one-time "AgentLoop has no guardrail pipeline — security risk" warning. Defaults to `false`; the warning still fires for direct `createAgentLoop` callers, preserving the fail-closed safety alert. Intended for an enclosing harness (e.g. `createSecurePreset`) that runs the guardrail pipeline at its own boundary — see `docs/architecture/05-guardrails.md`.

**`@harness-one/preset` — internal opt-in flip**. `wireComponents` now sets `guardrailsManagedExternally: true` when constructing the inner `AgentLoop`. Fixes a false-positive warning that previously fired on every `harness.run()` call telling preset users to "use createSecurePreset" — which they already were. Two documented contracts (`docs/architecture/05-guardrails.md:23` vs `README.md:421`) had collided. No public API change in `@harness-one/preset` itself.

**Test infrastructure (no consumer impact)**: `packages/core/vitest.config.ts` pins `fakeTimers.toFake` to a safe minimal set (vitest 4 expanded the default to include `queueMicrotask`/`nextTick`/`setImmediate`, which deadlocked vitest's own internal hook scheduling — restored 51 pre-existing failing tests to green) and disables vitest's console intercept (vitest 4 worker rpc + coverage instrumentation had a race where a `safeWarn` fallback fired from inside a fake-timer callback could land on `onUserConsoleLog` after the worker rpc began closing).

**Dogfood (private workspace, no consumer impact)**: `apps/dogfood` now enforces a per-run USD budget via `DOGFOOD_BUDGET_USD` (default `$0.50`) — eliminates the "no cost budget configured" warning that was firing on every triage run, and caps inference spend on a runaway tool-loop or attacker-crafted issue.

**Docs**: `README.md` split per best practices — 1235 lines → 343 lines (-72%). Per-module API reference moved to `docs/modules.md`; preset deep dive moved to `packages/preset/README.md` (where npm shows it); import-path cheatsheet moved to `docs/guides/import-paths.md`; feature maturity matrix moved to `docs/feature-maturity.md`. Every cross-link verified before commit; covered by the existing `docs-links.yml` lychee check.
