# ADR-0008 · Test adapters with shared conformance suites

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: harness-one maintainers

## Context

`harness-one` defines several pluggable interfaces (`MemoryStore`,
`Retriever`, `EmbeddingModel`, `ChunkingStrategy`, `AgentAdapter`).
Each one has at least two implementations today (in-memory + Redis;
in-memory + Anthropic + OpenAI; …), and the design assumes more will
land over time.

The historical failure mode for this kind of interface-plus-adapters
shape is **interface semantic drift**: adapter A satisfies the
TypeScript interface but interprets one corner of the contract
differently than adapter B. When the production code switches from
A to B, latent bugs surface that the per-adapter unit tests
(written in isolation, often using mocks of the contract itself)
never caught.

## Decision

> **Every adapter contract that has ≥2 implementations ships a
> shared executable conformance suite. Adapter test files invoke the
> suite against their concrete implementation; mock-only unit tests
> are insufficient evidence that an adapter satisfies the contract.**

The suites are runner-agnostic (they take a `{ describe, it, expect }`
triad as a parameter) so adapter authors can plug them into
whichever test framework they use. The harness's own in-memory
implementations dogfood the same suite the third-party adapters
have to pass.

For `AgentAdapter` the suite is currently **a written specification**
(`docs/provider-spec.md`) plus per-adapter regression tests; an
executable conformance harness for `AgentAdapter` is the planned
next step but is not yet shipped.

## Alternatives considered

- **Per-adapter unit tests with mocks** — the dominant pattern in TS
  libraries. Rejected: mocks reflect the author's interpretation of
  the contract, not the contract itself, so two adapters can both
  pass their own mock-based tests while disagreeing on real
  behaviour.
- **Integration tests in a separate repo** — pull both adapters into
  an end-to-end suite. Rejected: too distant from the adapter's
  source; violations get caught late, in CI of a different repo.
- **Type-level tests only** (`expectType<…>()`). Rejected: types are
  necessary but never sufficient — the failure modes that matter
  (eviction policy, ordering guarantees, error mapping) are runtime
  semantics.
- **Skip conformance for `AgentAdapter`** because LLM responses are
  non-deterministic. Rejected for written-spec form
  (`docs/provider-spec.md`); we still mean to add an executable
  harness with stubbed providers.

## Consequences

### Positive

- A new adapter author has a definitive checklist: "does my adapter
  pass the conformance suite?" The answer is binary and runnable.
- Bugs that previously hid behind divergent mocks now surface at
  adapter-PR time, before they ship to consumers.
- The conformance suite doubles as executable documentation. New
  contributors can read the test cases to learn what each method
  is supposed to do.
- Refactors of the contract are safer: the suite has to be updated
  in lockstep, and every adapter's CI then runs the new shape.

### Negative

- Writing the conformance suite is more work than writing per-adapter
  unit tests. Each new contract method has to gain a witness in
  the suite.
- The runner-agnostic shape (`{ describe, it, expect }`) is slightly
  awkward to wire into vitest / jest. We accept the small adapter
  cost in exchange for not making the testkit depend on a specific
  framework.
- `AgentAdapter` doesn't yet have an executable suite, only a
  specification. That's a gap; the per-adapter regression tests
  cover the cases we know about, but a new edge case can still
  drift between adapters until the executable suite lands.

## Evidence

- `packages/core/src/memory/testkit.ts` —
  `runMemoryStoreConformance(runner, factory)` plus the
  `TestKitRunner` interface that decouples it from any test
  framework.
- `packages/redis/src/__tests__/redis.test.ts:1192` — the Redis
  adapter calls `runMemoryStoreConformance` against its own
  implementation, dogfooding the same suite the in-memory store
  passes.
- `packages/core/src/rag/conformance.ts` —
  `runRetrieverConformance`, `runEmbeddingModelConformance`,
  `runChunkingStrategyConformance` exported from
  `harness-one/rag`.
- `docs/provider-spec.md` — written specification for
  `AgentAdapter` (REQUIRED / OPTIONAL fields, error mapping, PR
  compliance checklist) used until an executable suite ships.
- `docs/retriever-spec.md`, `docs/embedding-spec.md`,
  `docs/chunking-spec.md` — companion written specs that the
  conformance suites in `rag/conformance.ts` enforce.
