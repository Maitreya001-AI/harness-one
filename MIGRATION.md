# Migration Guide

`harness-one` is pre-release. No version has shipped to npm yet — any
change on `main` may break downstream consumers without a deprecation
window. The git log carries the actual history; pin by SHA if you need
stability.

Once the first release ships (driven by `@changesets/cli`, see
`.changeset/config.json`), this file will document version-to-version
migration steps — API renames, removed symbols, behaviour changes.
Until then, read the source.

## Release blockers

Before cutting the first npm release, re-introduce `@deprecated`
JSDoc aliases for every symbol renamed during the thin-harness audit
(see *Naming cleanup* below). Rationale: once a version exists on
npm, consumers can no longer pin by SHA; a hard rename inside a
`^0.1.0` -> `^0.2.0` bump silently breaks them. Post-release renames
MUST carry a full major-version grace period with runtime-working
aliases.

Concretely, before the first release:

- [ ] Re-export `createRoundRobinStrategy` / `createRandomStrategy` /
      `createFirstAvailableStrategy` from `harness-one/orchestration`
      as `@deprecated` aliases of their `createBasic*` counterparts.
- [ ] Re-export `createFixedSizeChunking` /
      `createParagraphChunking` / `createSlidingWindowChunking` from
      `harness-one/rag` as `@deprecated` aliases of their `createBasic*`
      counterparts.
- [ ] Re-export `createRelevanceScorer` / `createFaithfulnessScorer` /
      `createLengthScorer` from `@harness-one/devkit` eval module as
      `@deprecated` aliases of their `createBasic*` counterparts.
- [ ] Re-export `withSelfHealing` from `harness-one/guardrails` as a
      `@deprecated` alias of `withGuardrailRetry`.
- [ ] Leave the `hallucination` failure-mode string recognised as an
      alias for `repeated_tool_failure` in consumer detectors (or
      document the rename as a breaking change in the first release
      notes — pick one, decide before shipping).
- [ ] Add an eslint rule or API-extractor gate that fails CI if any
      new public symbol is removed without a matching `@deprecated`
      alias, so future renames can't silently regress this policy.

The grace aliases should live for one full major version after first
release, then be removed in the following major.

## Unreleased

Breaking + observable changes that downstream consumers on a SHA-pinned
build should know about:

- **`packages/core/vitest.config.ts` pins `fakeTimers.toFake`** to the
  safe minimal set (`setTimeout`, `clearTimeout`, `setInterval`,
  `clearInterval`, `Date`, `performance`). vitest 4 expanded the default
  `useFakeTimers()` set to also mock `setImmediate` / `queueMicrotask`
  / `nextTick`, which collides with vitest's own internal hook
  scheduling and made every fake-timer-based suite (rate-limiter,
  session GC, circuit breaker, agent-pool, etc.) hang in `afterEach`
  with "Hook timed out in 10000ms". This pin restores 51 tests to
  green across 4 files. Tests that genuinely need to fake those types
  must override `toFake` at the call site.
- **`apps/dogfood` enforces a per-run USD budget** (`DOGFOOD_BUDGET_USD`,
  default `0.50`). The triage harness was previously built without a
  cost budget, leaving inference spend uncapped on a runaway tool-loop
  or attacker-crafted issue. The dogfood agent — Layer 9 of the testing
  blueprint — surfaced this gap as a "no cost budget configured"
  warning on every run.
- **AgentLoop now runs `inputPipeline` on tool-call arguments.** When
  `AgentLoopConfig.inputPipeline` is configured, the iteration runner
  invokes `pipeline.runInput({ content: toolCall.arguments })` once per
  tool call **before** yielding the `tool_call` event and **before** the
  tool side-effect runs. A `block` verdict aborts the loop with
  `guardrail_blocked` (new phase `'tool_args'`) + `error`
  (`HarnessErrorCode.GUARD_VIOLATION`); the `tool_call` is never
  yielded. Closes the asymmetry where direct `createAgentLoop` callers
  with an input pipeline previously got user-message validation but not
  tool-arg validation — preset users were already covered by the
  wrapper at `harness.run()`.

  **`AgentEvent['guardrail_blocked'].phase` widened** from
  `'input' | 'tool_output' | 'output'` to
  `'input' | 'tool_args' | 'tool_output' | 'output'`. Exhaustive
  switches on `phase` now need to handle the new variant. Consumers
  that filter on the existing three values continue to work; only
  exhaustive type-checks (`assertNever(phase)` patterns) need updating.

  **No impact on preset users.** `createSecurePreset` /
  `createHarness` do not pass `inputPipeline` to the inner AgentLoop
  (the preset runs all guardrail phases at the `harness.run()`
  boundary). The new check is a no-op on the preset path — no
  double-execution, no rate-limiter double-counting.

  **Direct AgentLoop users with rate-limiter inside `inputPipeline`**
  will see one additional pipeline run per tool call (counts toward
  the limiter). If this is undesirable, lift the rate-limiter out of
  `inputPipeline` (e.g., compose it as a separate, AgentLoop-external
  guard) so it doesn't count tool-arg checks against the user's
  request budget.
- **`AgentLoopConfig.guardrailsManagedExternally?: boolean`** added.
  Wrapper-layer opt-in: when `true`, suppresses the one-time "AgentLoop has
  no guardrail pipeline — security risk" warning. `createSecurePreset` /
  `createHarness` now set this to `true` internally because they run the
  guardrail pipeline around `harness.run()` rather than threading it into
  the inner AgentLoop (see README §"Auto-wiring in createHarness()"). For
  preset users this fixes a false-positive warning that previously fired
  on every `harness.run()` call telling them to "use createSecurePreset"
  — which they already were.

  Behaviour for direct `createAgentLoop` callers is unchanged: omitting
  the field (or setting `false`) preserves the fail-closed safety alert.
  The field is opt-in; setting it to `true` without an external wrapper
  silences a security signal with no replacement, so direct callers
  MUST NOT set it unless an enclosing harness genuinely runs guardrails
  at its boundary.
- **`apps/*` is now a pnpm workspace glob.** Consumers running
  `pnpm -r <cmd>` at the repo root will now include `apps/dogfood` in the
  iteration set. This is intentional — the dogfood agent is part of the
  library quality story (Layer 9 of the testing blueprint) and must
  typecheck / test alongside `packages/*`.
- **New workspace: `@harness-one/dogfood` (private, not published).**
  Ships the Issue Triage Bot used to dogfood the library against the
  repository's own issues. Zero new public API; exists only to drive the
  two new workflows `.github/workflows/dogfood-triage.yml` and
  `.github/workflows/dogfood-weekly.yml`. Downstream consumers can ignore
  this unless they want to copy the pattern.
- **New examples at `examples/`** (`codebase-qa.ts`,
  `autoresearch-loop.ts`, `evolve-check-demo.ts`). All three run
  deterministically under `pnpm examples:smoke` with `HARNESS_MOCK=1`; no
  API key required. Documented in the new Examples section of the
  README + `README.zh-CN.md`. (Originally landed at
  `examples/showcases/`; relocated to `examples/` root when the
  three-layer architecture — examples / showcases / apps — was
  introduced. See `docs/harness-one-form-coverage.md`.)
- **`docs/ROADMAP.md` published** with v0.1 / v0.2 / v1.0 scopes. The
  roadmap is the contract for what "public API change" means from this
  point on.
- **`docs/security/ossf-best-practices.md` extended** with a submission
  runbook mapping each Best Practices criterion to its existing evidence
  file in the repo. Owner action: paste the URLs into the form at
  <https://www.bestpractices.dev/> and replace the README badge.
- Prompt module: `SkillEngine` has been removed. Use `createSkillRegistry()`
  or `createAsyncSkillRegistry()` instead. The new registries are stateless:
  they store immutable skill definitions, render prompt text, and validate
  declared tool requirements, but they do not model staged transitions.
  Skill `version` values are restricted to numeric semantic versions
  (`1.0.0`, `2.10.3`) — pre-release / build-metadata tags such as
  `1.0.0-rc1` are rejected at `register()` time. See
  `packages/core/src/prompt/skill-types.ts` for the full contract.
  Migration:
  ```diff
  -import { createSkillEngine } from 'harness-one/prompt';
  +import { createSkillRegistry } from 'harness-one/prompt';
  +
  +const skills = createSkillRegistry();
  +skills.register({
  +  id: 'planner',
  +  description: 'Planning instructions',
  +  content: 'Plan before acting.',
  +  requiredTools: ['search'],
  +});
  +const rendered = skills.render(['planner']);
  +const validation = skills.validate(['planner'], ['search']);
  +```
- Naming cleanup across starter and recovery surfaces:
  - `createRoundRobinStrategy` -> `createBasicRoundRobinStrategy`
  - `createRandomStrategy` -> `createBasicRandomStrategy`
  - `createFirstAvailableStrategy` -> `createBasicFirstAvailableStrategy`
  - `createFixedSizeChunking` -> `createBasicFixedSizeChunking`
  - `createParagraphChunking` -> `createBasicParagraphChunking`
  - `createSlidingWindowChunking` -> `createBasicSlidingWindowChunking`
  - `createRelevanceScorer` -> `createBasicRelevanceScorer`
  - `createFaithfulnessScorer` -> `createBasicFaithfulnessScorer`
  - `createLengthScorer` -> `createBasicLengthScorer`
  - `withSelfHealing` -> `withGuardrailRetry`
  - failure mode `hallucination` -> `repeated_tool_failure`
- `AgentLoop` now accepts `maxDurationMs` in addition to iteration and token
  budgets. The limit is wall-clock based and aborts the run with
  `CORE_DURATION_BUDGET_EXCEEDED` once elapsed time exceeds the configured cap.
- `AgentLoopHook` adds two interceptable pre-flight hooks:
  `onBeforeChat(messages)` and `onBeforeToolCall(call)`. They can modify the
  outgoing payload or abort tool execution before dispatch.
- Message metadata now supports provenance fields:
  `meta.provenance` and `meta.provenanceDetail`. User input defaults to
  `user_input`, trusted system messages to `trusted_system`, tool replies to
  `tool_result`, and other legacy messages to `unknown` unless callers supply
  a more specific value.
- `MemoryStoreCapabilities` and `MemoryStore` were extended for explicit TTL,
  tenant scoping, and optimistic locking:
  - capability flags: `supportsTtl`, `supportsTenantScope`,
    `supportsOptimisticLock`
  - optional methods: `setWithTtl()`, `scopedView()`, `updateWithVersion()`
  Existing stores can remain partial implementations, but should advertise
  unsupported features honestly through the new capability flags.
- `harness-one/testing` subpath added; mock `AgentAdapter` factories moved
  off `harness-one/advanced`. `createMockAdapter` /
  `createFailingAdapter` / `createStreamingMockAdapter` /
  `createErrorStreamingMockAdapter` + `MockAdapterConfig` previously shipped
  from `harness-one/advanced` alongside production extension primitives.
  They are test doubles — routing them through the same surface as
  `createFallbackAdapter` / `createResilientLoop` misled adapter authors
  into treating them as production fallback. Migration:
  ```diff
  -import { createMockAdapter } from 'harness-one/advanced';
  +import { createMockAdapter } from 'harness-one/testing';
  ```
  Shape unchanged. Source file also moved: `src/core/test-utils.ts` →
  `src/testing/test-utils.ts`. See `docs/architecture/17-testing.md`.
- `harness-one/testing` further gained three sub-surfaces (all additive —
  no existing import changes):
  - Chaos injection: `createChaosAdapter` wraps any `AgentAdapter` with a
    seeded error/latency/corruption schedule for scenario tests;
    `createSeededRng` + `SeededRng` expose the PRNG directly. See Track H
    in `docs/architecture/17-testing.md`.
  - Cassette record/replay: `recordCassette` wraps a real adapter and
    appends a `CassetteChatEntry | CassetteStreamEntry` JSONL row per call;
    `createCassetteAdapter` / `loadCassette` replay from that file.
    Fingerprint helpers (`computeKey`, `fingerprint`, `isCassetteEntry`,
    `SUPPORTED_VERSIONS`) are exported for adapter-contract authors who need
    to thread their own keys. Deliberate semantic scope on the fingerprint:
    messages + tools + temperature / topP / maxTokens / stopSequences +
    responseFormat; `signal` and `LLMConfig.extra` are not part of the
    key, so SDK-default parameter changes don't red all cassettes.
  - Adapter contract suite: `createAdapterContractSuite(adapter, opts)`
    registers ~25 `AgentAdapter` contract assertions against a caller-
    supplied vitest `{ describe, it, expect, beforeAll }`. Every adapter
    package now uses this instead of duplicating mocks.
    `CONTRACT_FIXTURES` / `cassetteFileName` / `contractFixturesHandle`
    are the shared fixture registry. See ADR-0008.
- Redactor: `createRedactor` + `redactValue` now normalise camelCase keys
  by inserting `-` at every lower→upper boundary before matching the
  default secret pattern. Keys such as `apiToken`, `accessToken`,
  `bearerToken`, `refreshToken` that previously slipped through are now
  redacted. Visible only as *widening* of `[REDACTED]` coverage in logs
  and trace attributes; no callers should have been relying on these
  values surfacing in cleartext. Snake_case / kebab-case / single-word
  matches unchanged. See `docs/security/redact-findings.md` for the full
  gap ledger.
- Prompt registry: declaring a variable whose name collides with an
  `Object.prototype` key (`toString`, `valueOf`, `constructor`,
  `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`,
  `toLocaleString`) and calling `resolve(id, {})` previously threw
  `TypeError: rawValue.replace is not a function` because the missing-
  variable check walked the prototype chain. It now throws the documented
  `HarnessError('PROMPT_MISSING_VARIABLE')`. Callers pattern-matching on
  `TypeError` around `registry.resolve()` should switch to `HarnessError` /
  `HarnessErrorCode.PROMPT_MISSING_VARIABLE`. Fuzz-discovered; see
  `packages/core/tests/fuzz/FINDINGS.md` F-O4-01.
- `packages/core/tests/` top-level directories split out for dedicated
  test kinds, each with its own config / tsconfig / CI workflow:
  `tests/integration/` (Track D), `tests/chaos/` (Track H, `chaos.yml`
  is part of `ci.yml`), `tests/perf/` (Track I + `perf.yml`), `tests/fuzz/`
  (Track O + nightly `fuzz.yml`), `tests/type-level/` (Track N +
  `typecheck:type-level` script), `tests/security/` (Track O threat
  models). Not a consumer-facing change — noted here because local
  scripts that globbed `packages/core/src/**/*.test.ts` previously
  covered every test and now miss the top-level dirs; use
  `pnpm --filter harness-one test` or the per-kind scripts instead.
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
- `harness-one/infra` subpath is published. It exports exactly
  `createAdmissionController` + `unrefTimeout` / `unrefInterval` (plus
  their supporting types) — the rest of `src/infra/` stays private.
- `MessageQueue` is now a factory: `createMessageQueue(config)` returns
  a `MessageQueue` interface. `new MessageQueue(...)` no longer works.
  The implementing class is hidden per `docs/ARCHITECTURE.md`
  §Construction.
- `StreamAggregator` does not have `initialize()` / `finalize()`
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
