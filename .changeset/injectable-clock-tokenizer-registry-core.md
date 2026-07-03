---
"harness-one": minor
---

Remove two pieces of hidden global state from the core kernel: introduce an
injectable `Clock` port (B8) and an instance-scoped tokenizer registry (B7).
Both are additive and default to the prior behaviour byte-for-byte.

- **Injectable clock (B8).** New `Clock` interface (`now(): number`) and
  `systemClock` default in `infra/clock.ts` (L1, imports nothing upward).
  `Date.now()` was called directly throughout the kernel (adapter-caller ~8
  sites, iteration-coordinator ~3, memory store TTL/id paths, checkpoint
  timestamps), making duration budgets / TTL / timestamps untestable without
  fake timers. An optional `clock?: Clock` now threads through
  `AgentLoopConfig` → `CoordinatorDeps` (run-start + `maxDurationMs` budget)
  and `AdapterCallerConfig` (`totalDurationMs`), plus `createInMemoryStore({
  clock })` (timestamps, `mem_<time>_<rand>` id prefix, TTL expiry) and
  `createCheckpointManager({ clock })` (checkpoint `timestamp`,
  `prune({ maxAge })` cutoff). Default everywhere is `systemClock`, so runtime
  behaviour is unchanged. Exported from `harness-one/infra` and
  `harness-one/advanced`.

- **Instance-scoped tokenizer registry (B7).** New `TokenizerRegistry`
  interface (`register` / `estimate`) and `createTokenizerRegistry()` factory,
  each closed over its own map. The module-level `registerTokenizer` /
  `estimateTokens` / `clearTokenizerRegistry` now delegate to a shared default
  instance and keep working verbatim (the `@harness-one/tiktoken` global path
  is untouched). `countTokens(model, messages, tokenizerRegistry?)` and
  `StreamHandlerConfig.tokenizerRegistry?` add optional injection points that
  default to the global registry; when a custom registry is injected,
  `countTokens` bypasses its shared per-message WeakMap cache to avoid
  cross-registry contamination. `registerTokenizer`'s TSDoc now flags that it
  mutates process-wide state and recommends `createTokenizerRegistry` for
  library authors. Exported from `harness-one/context` and
  `harness-one/advanced`.
