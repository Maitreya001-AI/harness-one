# Migration Guide

`harness-one` is pre-release. No version has shipped to npm yet — any
change on `main` may break downstream consumers without a deprecation
window. The git log carries the actual history; pin by SHA if you need
stability.

Once the first release ships (driven by `@changesets/cli`, see
`.changeset/config.json`), this file will document version-to-version
migration steps — API renames, removed symbols, behaviour changes.
Until then, read the source.

## Unreleased — through Wave-27 audit pass

Breaking + observable changes that downstream consumers on a SHA-pinned
build should know about:

- `harness-one/testing` subpath added; mock `AgentAdapter` factories moved
  off `harness-one/advanced`. Wave-27: `createMockAdapter` /
  `createFailingAdapter` / `createStreamingMockAdapter` /
  `createErrorStreamingMockAdapter` + `MockAdapterConfig` used to ship from
  `harness-one/advanced` alongside production extension primitives. They
  are test doubles — routing them through the same surface as
  `createFallbackAdapter` / `createResilientLoop` misled adapter authors
  into treating them as production fallback. Migration:
  ```diff
  -import { createMockAdapter } from 'harness-one/advanced';
  +import { createMockAdapter } from 'harness-one/testing';
  ```
  Shape unchanged. Source file also moved: `src/core/test-utils.ts` →
  `src/testing/test-utils.ts`. See `docs/architecture/17-testing.md`.
- `StreamAggregator` UTF-8 byte counter now carries a `pendingHighSurrogate`
  flag across chunks so a supplementary codepoint split across two chunks
  (high surrogate at end of chunk N, low surrogate at start of chunk N+1)
  is accounted as 4 bytes rather than 7. The pair-completion rule is
  documented at the `utf8ByteLength` call site. Reset on `reset()`. Visible
  to consumers only as *tighter* byte-budget semantics; no pre-existing
  caller could have been relying on the over-count.
- Documentation: `docs/guides/fallback.md` + `docs/provider-spec.md` now
  reference the **public subpath** import paths (`harness-one/advanced`,
  `harness-one/core`, `harness-one/infra`) rather than the internal
  `packages/core/src/...` file layout, which is not reachable through the
  `exports` map from an npm install.
- `harness-one/infra` subpath is now actually published. Docs have
  promised `createAdmissionController` + `unrefTimeout` / `unrefInterval`
  under this path since Wave-5D/5F, but the package.json `exports` entry
  and tsup entry point were missing, so `import … from 'harness-one/infra'`
  resolved to `ERR_PACKAGE_PATH_NOT_EXPORTED`. The subpath now exports
  exactly those documented symbols and nothing else — the rest of
  `src/infra/` stays private. Additive; no consumer could have depended
  on the broken state.
- `MessageQueue` is now a factory: `createMessageQueue(config)` returns
  a `MessageQueue` interface. `new MessageQueue(...)` no longer works.
  The implementing class is hidden per `docs/ARCHITECTURE.md`
  §Construction.
- `StreamAggregator` drops the Wave-15 `initialize()` / `finalize()`
  aliases. Use `reset()` / `getMessage(usage)` instead.
- `AgentLoop.status` adds an `'errored'` state. Normal `end_turn`
  completions still report `'completed'`; abort / max_iterations /
  token_budget / guardrail-block / adapter-error terminals now land on
  `'errored'`. Consumers previously coupling success to
  `status === 'completed'` keep working; dashboards that want to
  distinguish success from failure can now do so without reading the
  last `done.reason` event. `dispose()` takes precedence — a
  concurrent in-flight terminal cannot overwrite `'disposed'`.
- Anthropic + OpenAI adapters expose `streamLimits: { maxToolCalls?,
  maxToolArgBytes? }` on their factory config. Defaults now match the
  shared `MAX_TOOL_CALLS` / `MAX_TOOL_ARG_BYTES` constants exported
  from `harness-one/advanced`, so `createAgentLoop({ limits:
  { maxToolArgBytes } })` and the adapter see the same budget unless
  you override per-factory. Previously the adapters hard-coded a 1 MB
  cap regardless of loop config.
- `StreamAggregator` byte accounting switched from UTF-16 code units to
  UTF-8 bytes so `maxStreamBytes` / `maxToolArgBytes` match their
  documented names. CJK / emoji content now counts ~2-4× more bytes.
  Tighten your budgets if you previously relied on the off-by-constant.
- `KahanSum` moved from `observe/cost-tracker` to `infra/kahan-sum`.
  It's still re-exported from `harness-one/observe` for back-compat.
- `harness-one/observe` now exports `isWarnActive(logger)` — the
  level-gate probe adapters use before allocating warn metadata.
  Both `@harness-one/anthropic` and `@harness-one/openai` now import
  from here instead of each rolling their own.
- `CostTracker.reset()` also clears the overflow-throttle timestamp
  and the unpriced-model warn-once set. A post-`reset()` overflow or
  unpriced model now emits its signal again instead of being silently
  suppressed for up to 60s / forever.
- `IterationRunner.config` grew a required `runHook`
  (`AgentLoopHookDispatcher`) and lost `hooks` / `strictHooks` /
  `logger`. `AgentLoop` builds the dispatcher once and threads the
  same instance down. Callers who constructed `createIterationRunner`
  directly (advanced tests only — the factory is internal) need to
  inject a dispatcher built via `createHookDispatcher`.
- `TraceLruList` no longer requires caller-visible `lruPrev` / `lruNext`
  / `inLru` fields on its value type. It stores node pointers in an
  internal `WeakMap` keyed on the value. Generic parameter is now
  `TraceLruList<T extends object>`.
- Redis memory store: `setEntry` / `transactionalUpdate` now forward
  `defaultTTL === 0` to SET EX verbatim (Redis treats 0 as "expire
  immediately") instead of silently treating 0 as no-TTL.
- Anthropic + OpenAI adapters no longer define `MAX_TOOL_CALLS` /
  `MAX_TOOL_ARG_BYTES` locally — use the shared constants from
  `harness-one/advanced` or override via `streamLimits`.
- `@harness-one/preset` `validateHarnessRuntimeConfig` signature widened
  from a detailed structural type to `Record<string, unknown>`. Runtime
  behaviour unchanged — the function already narrows every field through
  `require*` guards. Call sites that previously satisfied the strict
  shape continue to pass; dynamic callers no longer need `as any`.
