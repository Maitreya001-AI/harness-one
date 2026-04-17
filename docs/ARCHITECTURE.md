# harness-one Architecture — Layering Contract

This document codifies the layering contract that the audit waves 5–16
have converged on. It is intentionally short — the details live in
`docs/architecture/*.md` per-module. This file is the single-page
mental model that every PR and review should respect.

## Dependency direction

The `harness-one` monorepo has **five conceptual layers**, and
imports may only flow top-to-bottom:

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
│                              middleware, ...)         │
├─────────────────────────────────────────────────────┤
│  L1  infra                   core/infra (ids,         │
│                              backoff, async-lock,     │
│                              circuit-breaker, logger, │
│                              lru-cache, redact, ...)  │
│                              core/redact (public)     │
└─────────────────────────────────────────────────────┘
```

## Allowed import edges

- **L1 → nothing** — infra must not import from any higher layer.
  Wave-15 made this rule strict: error primitives (`HarnessError` +
  `HarnessErrorCode`) now live in `infra/errors-base.ts` and branded-id
  types (`TraceId`, `SpanId`, `SessionId`) live in `infra/brands.ts`, so
  the Wave-14 carve-out for `core/errors.js` / `core/types.js` is gone.
- **L2 → L1** — `core/core` freely imports from `core/infra`. L2 is
  also where the cross-cutting ports now live after Wave-15:
  `core/metrics-port.ts` and `core/instrumentation-port.ts` (hoisted
  out of observe), `core/pricing.ts` (the canonical model-pricing home),
  and `core/iteration-coordinator.ts` (the event-sequencing state
  machine extracted from AgentLoop).
- **L3 → L1, L2** — each subsystem (`orchestration`, `observe`, …)
  imports from `core/core` and `core/infra`. Subsystems do **not**
  import from each other (not even type-only); shared abstractions
  belong in L2. Wave-17 tightened this: `orchestration/agent-pool`
  now depends on the L2 `InstrumentationPort` rather than the L3
  `TraceManager`, removing the last L3→L3 edge in the tree.
- **L4 → L1, L2, L3 (via public subpath barrels)** — adapter packages
  (`@harness-one/openai`, etc.) depend on the `harness-one` package
  through its published subpath exports (`harness-one/core`,
  `harness-one/observe`, `harness-one/redact`, …). They MUST NOT reach
  into `harness-one/src/...` internal paths.
- **L5 → L1…L4 via public subpath barrels** — presets and CLI compose
  adapter packages the same way as end users.

## Enforcement

Runtime: the dependency direction is enforced by the TypeScript type
graph and the `exports` map in each package's `package.json`.

Build time: the root `eslint.config.js` enforces the layering via
`no-restricted-imports` rules:

- In `core/src/infra/**`, importing from `../core/**` or
  `../orchestration/**`, etc., is forbidden (infra must stay
  dependency-free).
- In sibling packages, importing from `harness-one/src/**` (i.e.
  reaching into the source tree rather than the published barrels)
  is forbidden.

## Rules of thumb for PR review

- **"Where does this new symbol live?"** — answer the question at
  definition time, not later. If it's a dependency-free utility → L1.
  If it's a shared domain type or base error → L2. If it's feature
  state → L3. If it's a provider binding → L4. If it's
  configuration-wiring → L5.
- **"Does this subsystem need to call that subsystem?"** — if yes,
  the shared abstraction needs to move down to L2 first. L3 modules
  never import each other at runtime.
- **"Should this be re-exported from the observe barrel?"** — only
  if it's genuinely observability-shaped. Redaction primitives
  (previously re-exported from `observe`) were hoisted to
  `harness-one/redact` in Wave-14 for exactly this reason.

## LRU caches

Two LRU shapes live in core. Pick the right one:

- **`core/infra/lru-cache.ts`** — generic `Map`-backed key/value cache.
  Reach for this first: it holds values, supports any key type, and
  fires `onEvict` hooks for side-table accounting.
- **`core/observe/trace-lru-list.ts`** — intrusive doubly-linked list of
  trace-id strings with O(1) `move-to-tail` / `pop-head`. Holds no
  payload; callers store values in a sibling `Map<string, T>`. Use it
  when (a) eviction must fan out to multiple sibling side-tables,
  (b) nodes already exist in a parent structure where embedding
  prev/next pointers is cheaper than a separate wrapper, or (c)
  move-to-tail is called on every read.

Both modules carry a header comment with the same decision rule.

## Validation helpers

Primitive numeric guards live in one place: `core/infra/validate.ts`
(`requirePositiveInt`, `requireNonNegativeInt`, `requireFinitePositive`,
`requireFiniteNonNegative`, `requireUnitInterval`, `validatePricingEntry`,
`validatePricingArray`). They're surfaced on the public
`harness-one/advanced` barrel for adapter authors and the preset to
share; internal call sites import straight from `../infra/validate.js`.
Every subsystem (core, admission controller, circuit breaker, execution
strategies, trace sampler, trace manager, agent-loop config, ajv
validator, langfuse, preset) delegates to those helpers — do not
reintroduce a bespoke inline guard. The `validate.test.ts` witness
tests lock this in per Wave-16 m3.

## Public-surface split (Wave-17)

`harness-one/core` is the end-user surface: message types, errors,
events, `createAgentLoop` + hooks + config, model pricing, and the
two observability ports. Anything a typical consumer imports when
wiring an agent loop is here.

`harness-one/advanced` is the extension-author surface: middleware
factory, stream aggregator, output parser, fallback adapter, SSE
helpers, execution-strategy factories, error classifier, custom
error-code helper, conversation pruner, resilient-loop factory,
iteration-coordinator primitives, validators, pricing math, backoff
primitives, trusted system-message factories, and the mock adapters
used by tests. These were previously on `harness-one/core` and moved
in Wave-17 so the end-user surface is narrow and the extension-author
surface is separately declared.

The root `harness-one` barrel continues to re-export the UJ-1 value
symbols (`createMiddlewareChain`, `createResilientLoop`, …) so
top-level imports of those primitives don't have to know about the
`/advanced` split.

## Also see

- `MIGRATION.md` — deprecation timelines.
- `docs/architecture/00-overview.md` — module-by-module deep dive.
- `docs/architecture/*.md` — per-subsystem design notes.
