# harness-one Architecture — Layering Contract

This is the single-page mental model every PR and review should
respect. Per-module deep dives live in `docs/architecture/*.md`.

## Dependency direction

The monorepo has **five conceptual layers**, and imports may only
flow top-to-bottom:

```
┌─────────────────────────────────────────────────────┐
│  L5  presets / CLI          @harness-one/preset, cli │
│                              @harness-one/devkit      │
├─────────────────────────────────────────────────────┤
│  L4  provider adapters       @harness-one/anthropic   │
│                              @harness-one/openai      │
│                              @harness-one/langfuse    │
│                              @harness-one/opentelemetry│
│                              @harness-one/redis       │
│                              @harness-one/tiktoken    │
│                              @harness-one/ajv         │
├─────────────────────────────────────────────────────┤
│  L3  feature subsystems      core/orchestration       │
│                              core/session             │
│                              core/observe             │
│                              core/guardrails          │
│                              core/memory              │
│                              core/tools               │
│                              core/prompt              │
│                              core/context             │
│                              core/rag                 │
│                              core/evolve-check        │
├─────────────────────────────────────────────────────┤
│  L2  domain primitives       core/core (AgentLoop,    │
│                              errors, events, types,   │
│                              middleware, ports,       │
│                              pricing, iteration      │
│                              coordinator, ...)        │
├─────────────────────────────────────────────────────┤
│  L1  infra                   core/infra (ids,         │
│                              backoff, async-lock,     │
│                              circuit-breaker, logger, │
│                              lru-cache, redact, ...)  │
│                              core/redact (public)     │
└─────────────────────────────────────────────────────┘
```

## Allowed import edges

- **L1 → nothing** — infra imports nothing upward. Error primitives
  (`HarnessError`, `HarnessErrorCode`, `HarnessErrorDetails`,
  `createCustomErrorCode`) live in `infra/errors-base.ts`; branded-id
  types (`TraceId`, `SpanId`, `SessionId`) live in `infra/brands.ts`.
- **L2 → L1** — `core/core` freely imports from `core/infra`. L2 also
  hosts cross-cutting ports: `core/metrics-port.ts`,
  `core/instrumentation-port.ts`, `core/pricing.ts` (canonical
  model-pricing home), and `core/iteration-coordinator.ts`
  (event-sequencing state machine).
- **L3 → L1, L2** — each subsystem (`orchestration`, `observe`, …)
  imports from `core/core` and `core/infra`. **Subsystems do not
  import each other** (not even type-only); shared abstractions belong
  in L2.
- **L4 → L1, L2, L3 via public subpath barrels** — adapter packages
  depend on `harness-one` through its published subpath exports
  (`harness-one/core`, `harness-one/observe`, `harness-one/redact`, …).
  They MUST NOT reach into `harness-one/src/**` internal paths.
- **L5 → L1…L4 via public subpath barrels** — presets and CLI compose
  adapter packages the same way end users do.

## Enforcement

Runtime: the `exports` map in each `package.json` plus TypeScript's
type graph enforce direction.

Build time: the root `eslint.config.js` enforces it via
`no-restricted-imports`:

- Inside `core/src/infra/**`, importing from any higher layer is
  forbidden.
- Inside each L3 subsystem under `core/src/<subsystem>/**`, importing
  from any *sibling* L3 subsystem is forbidden — both via
  `../<other>/**` relative paths and via `harness-one/<other>` subpath.
  Tests are exempt (they may cross-wire subsystems for integration
  coverage).
- Inside sibling packages, importing from `harness-one/src/**` is
  forbidden.

## Rules of thumb for PR review

- **"Where does this new symbol live?"** — decide at definition
  time. Dependency-free utility → L1. Shared domain type or base
  error → L2. Feature state → L3. Provider binding → L4.
  Config wiring → L5.
- **"Does this subsystem need to call that subsystem?"** — if yes,
  the shared abstraction needs to move down to L2 first. L3 modules
  never import each other at runtime.
- **"Should this be re-exported from the observe barrel?"** — only
  if it's genuinely observability-shaped. Redaction primitives
  ship from `harness-one/redact`, not `harness-one/observe`.

## LRU caches

Two shapes live in core. Pick the right one:

- **`core/infra/lru-cache.ts`** — generic `Map`-backed key/value
  cache. Reach for this first: it holds values, supports any key
  type, and fires `onEvict` on every removal path (capacity
  eviction, explicit `delete`, `clear`).
- **`core/observe/trace-lru-list.ts`** — intrusive doubly-linked
  list of trace-id strings with O(1) `move-to-tail` / `pop-head`.
  Holds no payload; callers store values in a sibling `Map`. Use it
  only when (a) eviction must fan out to multiple sibling
  side-tables, (b) prev/next pointers can live on nodes that
  already exist, or (c) move-to-tail runs on every read.

Header comments on both files carry the same decision rule.

## Validation helpers

Primitive numeric guards live in `core/infra/validate.ts`
(`requirePositiveInt`, `requireNonNegativeInt`, `requireFinitePositive`,
`requireFiniteNonNegative`, `requireUnitInterval`, `validatePricingEntry`,
`validatePricingArray`). Re-exported on `harness-one/advanced` for
adapter authors and the preset. Every subsystem delegates — do not
reintroduce a bespoke inline guard. Witness tests in `validate.test.ts`
lock delegation in place.

## Hot-path extractions

When a single function in a god-object becomes the natural place to
add new behaviour, extract a sibling module rather than growing it.
Established seams:

- **`core/streaming-retry.ts`** — pump-and-decide for one streaming
  adapter attempt. `adapter-caller.ts` keeps retry-loop bookkeeping
  (counters, cumulative timing, backoff scheduling); the helper owns
  StreamHandler iteration + buffered-error semantics.
- **`core/iteration-lifecycle.ts`** — span + hook lifecycle (close
  span, fire `onIterationEnd`, the five `bail*` terminal generators).
  `iteration-runner.ts` only owns the input → adapter → tools stage
  choreography; every terminal exit goes through a `lifecycle.bail*`.
- **`observe/cost-record-buffer.ts`** — bounded ring buffer with
  per-trace lookup index and raw/effective bias translation. The
  cost tracker owns running totals, alert dispatch, and pricing
  snapshots; the buffer owns index bookkeeping with branded raw and
  effective index types so callers cannot mix the two spaces.

## Public-surface split

- **`harness-one/core`** — end-user surface: message types, errors,
  events, `createAgentLoop` + hooks + config, and model pricing.
  Anything a typical consumer imports when wiring an agent loop.
- **`harness-one/observe`** — observability surface **and** canonical
  home for the two cross-cutting ports: `MetricsPort`,
  `InstrumentationPort`, `createNoopMetricsPort`, plus trace manager,
  cost tracker, lifecycle, and logger. The **value** `createNoopMetricsPort`
  lives here and nowhere else — one import path per public value symbol,
  so consumers cannot pick up two different singletons. The rule is
  relaxed for **type-only** re-exports: `MetricsPort` / `MetricAttributes`
  / `MetricCounter` / `MetricGauge` / `MetricHistogram` / `InstrumentationPort`
  are also re-exported as types from the root barrel, because TS structural
  typing makes the "two different copies" concern irrelevant for types. The
  canonical home remains `/observe`; the root re-export is pure UX so that
  a user passing a `MetricsPort` to `createCostTracker()` does not have to
  add a second import line.
- **`harness-one/advanced`** — extension-author surface: middleware
  factory, stream aggregator, output parser, fallback adapter, SSE
  helpers, execution-strategy factories, error classifier, custom
  error-code helper, conversation pruner, resilient-loop factory,
  validators, pricing math, backoff primitives, trusted
  system-message factories, and the mock adapters used by tests.
  The iteration-coordinator state machine is an internal
  implementation detail of `AgentLoop` and is intentionally
  **not** re-exported here.
- **Root `harness-one`** re-exports the UJ-1 value symbols
  (`createMiddlewareChain`, `createResilientLoop`, …) so top-level
  imports of those primitives don't have to know about `/advanced`.
- **L3 subsystem barrels** — every L3 subsystem also publishes its
  own subpath barrel for callers who only need that slice:
  `harness-one/observe`, `harness-one/redact`, `harness-one/prompt`,
  `harness-one/context`, `harness-one/guardrails`, `harness-one/memory`,
  `harness-one/session`, `harness-one/tools`, `harness-one/orchestration`,
  `harness-one/rag`, `harness-one/evolve-check`. These are deliberately
  thinner than `/core`: they expose the subsystem's own API without
  pulling in the rest of the harness. Adapter packages prefer
  `/core` + `/advanced` + `/observe`; specialised tools (e.g. a
  RAG-only consumer) can reach for the relevant subsystem barrel
  instead.
- **`harness-one/testing`** — mock `AgentAdapter` factories for test code.
  Keeps the `/advanced` surface focused on composable **production**
  primitives: the four mock factories (`createMockAdapter`,
  `createFailingAdapter`, `createStreamingMockAdapter`,
  `createErrorStreamingMockAdapter`) are test doubles and should not
  appear on a production import graph. Never import from production
  code. Detail: `docs/architecture/17-testing.md`.

## Construction: factories, not classes

Every public primitive in harness-one is constructed through a
`create*` factory; the implementing class is deliberately hidden
(`createRegistry`, `createSessionManager`, `createTraceManager`,
`createCostTracker`, `createLogger`, `createPipeline`,
`createMiddlewareChain`, `createResilientLoop`,
`createFallbackAdapter`, `createBackoffSchedule`, `createAgentPool`,
`createMemoryStore`, `createMessageQueue`, …). Consumers never type
`new SomeClass()`.

`AgentLoop` is the single documented exception: the factory
`createAgentLoop` is the idiomatic entry point, but the class is
also exported so tests and callers can narrow types with
`instanceof AgentLoop` (for generator-return narrowing in tooling
that can't follow the factory's return type transitively).

When adding a new primitive: export the factory and the result
type; do **not** export the implementing class unless `instanceof`
narrowing is part of the public contract.

## Lifecycle status values

`AgentLoop.status` and the `AgentLoopStatus` type surface five states:

- `idle` — constructed, never ran or last run torn down cleanly.
- `running` — currently inside `run()`.
- `completed` — last run ended with a normal `end_turn` (LLM stopped).
- `errored` — last run ended with `aborted`, `max_iterations`,
  `token_budget`, a guardrail block, or an adapter/tool error.
- `disposed` — `dispose()` has been called; the loop cannot be re-used
  and its status cannot be flipped back to `completed` / `errored` by a
  concurrent in-flight terminal.

Operators that previously coupled their "success" branch to
`status === 'completed'` keep working unchanged, but they now also get
a dedicated `'errored'` state for dashboards instead of having to
inspect the last `done.reason` event.

## Config shape: flat, single-form

`AgentLoopConfig` is the one-and-only config shape accepted by
`createAgentLoop`. All concerns (limits, hooks, pipelines,
observability, resilience, execution) are flat fields on the same
struct.

## Adapter stream limits

Provider adapters (`@harness-one/anthropic`, `@harness-one/openai`)
and core's `StreamAggregator` share the same pre-truncation budgets
so a stream cannot silently balloon past what the loop can absorb.
The constants `MAX_STREAM_BYTES` / `MAX_TOOL_ARG_BYTES` /
`MAX_TOOL_CALLS` live in `core/agent-loop-config.ts` and are
re-exported from `harness-one/advanced`. Both adapter factories
accept an optional `streamLimits: { maxToolCalls?, maxToolArgBytes? }`
override whose defaults match the shared constants, so tightening
the loop-level `maxToolArgBytes` and the adapter-level cap is a
single-place change on each side.

`StreamAggregator` now tracks bytes in **UTF-8**, not UTF-16 code
units — the documented `maxStreamBytes` / `maxToolArgBytes` names
finally match what downstream serialisers see on the wire.

`AgentLoop` additionally passes
`maxCumulativeStreamBytes = maxIterations × maxStreamBytes` to the
stream handler as a **secondary** backstop against a loop that never
trips the per-iteration cap but streams ~`maxStreamBytes` every
iteration. Treat `maxStreamBytes` as the real knob — the cumulative
product is a derived ceiling, not a token budget.

## Filesystem memory store — crash-safety contract

`createFileSystemStore()` writes each entry file atomically
(write-temp → rename) and each index write atomically, but multi-file
operations (`write`, `delete`, `compact`, `clear`) are **not**
transactional: a process crash between the entry and index writes
can leave the `_index.json` mapping slightly out of sync with the
on-disk entry files.

Queries and reads are unaffected — they scan entry files directly
and never consult the index — so the residual consequence is either
an orphan entry (`write` crashed before the index update) or a stale
key row (`delete` crashed before the index update). Both are
cosmetic from a data-integrity standpoint but leave dead weight on
disk. `FsMemoryStore.reconcileIndex()` rebuilds the index from the
actual entry files and is safe to call at boot, on a schedule, or
after a confirmed crash. Multi-process concurrent access still
requires an external lock (see the warning in the factory
docstring).

## Shared adapter helpers

`harness-one/observe` exposes `isWarnActive(logger)` — the probe
adapters use before allocating warn-level metadata. Both Anthropic
and OpenAI adapters import from here instead of rolling their own
`typeof logger.isWarnEnabled === 'function'` inline checks.

## Also see

- `docs/architecture/00-overview.md` — module-by-module deep dive.
- `docs/architecture/*.md` — per-subsystem design notes.
