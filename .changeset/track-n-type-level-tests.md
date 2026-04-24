---
"harness-one": patch
---

Add Track N type-level test suite under `packages/core/tests/type-level/`
with seven `expect-type` assertions that lock down key type contracts
at compile time:

- N1 `AgentEvent` discriminated union — exhaustive switch + variant set.
- N2 `HarnessConfig` — provider-keyed narrowing + XOR between `adapter`
  and `provider`/`client`.
- N3 `TraceId` / `SpanId` / `SessionId` branded IDs — cross-brand and
  raw-string rejection.
- N4 `TrustedSystemBrand` — only `createTrustedSystemMessage()` mints
  the brand; plain `symbol` is not assignable.
- N5 `MemoryStoreCapabilities` ↔ optional-method signature pairing.
- N6 `MetricsPort` cross-subpath identity (root barrel ≡ `/observe`).
- N7 Public-API shape lockfile — any removal/rename across
  `harness-one`, `harness-one/core`, `harness-one/advanced`,
  `harness-one/testing`, `@harness-one/preset`, `@harness-one/anthropic`,
  and `@harness-one/openai` fails `tsc`.

The suite runs via `pnpm --filter harness-one typecheck:type-level` and
is wired into CI alongside the standard typecheck. Pure-type dependency
(`expect-type` 1.3.0 devDep), zero runtime bundle impact.
