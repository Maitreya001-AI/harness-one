# ADR-0004 · Keep `harness-one` core at zero runtime dependencies

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

The core package `harness-one` ships the agent loop, error layer,
guardrails, observe primitives, session manager, memory store, RAG
pipeline, orchestration, and the testing kit. A typical TypeScript
library of this scope pulls in `lodash`, an LRU cache, an Ajv
clone, `nanoid`, a tokenizer, and a logger — easily ten transitive
runtime dependencies before the consumer adds their own.

Every transitive dependency is a hidden cost: install size, bundle
size, audit surface, supply-chain risk, and the long-term maintenance
of "their breaking change just shipped". For a foundational package
that other adapter packages and end-users compose into agents, those
costs compound.

## Decision

> **`harness-one` (core) ships with zero runtime dependencies. All
> commodity infra — JSON schema, LRU, ID generation, redaction, token
> estimation, backoff — is implemented inside `packages/core/src/infra/`.**

When a consumer wants production-grade upgrades for one of these
slots (real Ajv, real tiktoken, Redis-backed memory, Langfuse cost
tracking), they install a sibling adapter package
(`@harness-one/ajv`, `@harness-one/tiktoken`, `@harness-one/redis`,
`@harness-one/langfuse`) that takes the dependency. Core stays clean.

## Alternatives considered

- **Use `lodash` and friends in core** — minimal hand-written code,
  faster to ship features. Rejected: every consumer pays for the
  install regardless of which features they touch; supply-chain
  risk concentrates in core.
- **Use `peerDependencies` everywhere** — consumers install the deps
  themselves, core declares them as peers. Rejected: peer-dep
  resolution UX is still poor (`npm i` warnings, version-mismatch
  drift) and it pushes the supply-chain risk onto every user
  instead of removing it.
- **Tree-shake the deps** — assume bundlers will strip what isn't
  used. Rejected: not all consumers use bundlers (Node CLIs, Lambda
  layers); even bundlers struggle with deps that have side effects
  on import.

## Consequences

### Positive

- Installing `harness-one` is a single tarball with no transitive
  npm graph. Bundle size is bounded by what we wrote.
- Audit surface is the source we maintain. CVE in `lodash`, `axios`,
  or `node-fetch` cannot reach a core consumer through us.
- Adapter packages can pick the dependency version that matches
  their target runtime, without core having to re-pin every time
  upstream cuts a release.
- The `infra/` rule "no upward imports" (ADR-0002 cousin) is easy
  to enforce because the layer is small and self-contained.

### Negative

- Some `infra/*.ts` files reimplement features that exist in
  battle-tested libraries. The internal LRU is simpler and slower
  than `lru-cache`; the JSON Schema validator covers a subset of
  what Ajv does. We accept that gap and document the upgrade path
  (`@harness-one/ajv`).
- Maintenance cost of `infra/` falls on the harness team. Bug fixes
  upstream do not flow to us automatically.
- The distinction between "in core" and "in adapter" can confuse
  new users — why is `tiktoken` not in core? — and has to be
  explained in the README.

## Evidence

- `packages/core/package.json` — `dependencies` field is empty (no
  `dependencies`, no `peerDependencies`, no `optionalDependencies`).
- `packages/core/src/infra/lru-cache.ts`,
  `packages/core/src/infra/ids.ts`,
  `packages/core/src/infra/backoff.ts`,
  `packages/core/src/infra/redact.ts`,
  `packages/core/src/infra/circuit-breaker.ts` — internal
  implementations of utilities others would import as deps.
- `packages/ajv/package.json`, `packages/tiktoken/package.json`,
  `packages/redis/package.json`, `packages/langfuse/package.json` —
  sibling packages that take the heavy dependency on behalf of
  consumers who opt in.
- `docs/architecture/00-overview.md` — "运行时依赖（core 包）: 0" line
  in the core-data table that pins this decision in user-visible
  docs.
