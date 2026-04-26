# harness-one

[![codecov](https://codecov.io/gh/Maitreya001-AI/harness-one/graph/badge.svg)](https://codecov.io/gh/Maitreya001-AI/harness-one)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/Maitreya001-AI/harness-one/badge)](https://securityscorecards.dev/viewer/?uri=github.com/Maitreya001-AI/harness-one)
[![OpenSSF Best Practices](https://bestpractices.coreinfrastructure.org/projects/12635/badge)](https://bestpractices.coreinfrastructure.org/projects/12635)

> Universal primitives for AI agent harness engineering. The hard 30% of harness infrastructure, done once and done right.

**Languages**: **English** (this file) · [中文版 → `README.zh-CN.md`](./README.zh-CN.md)

## What is Harness Engineering?

An AI agent is **Model + Harness**. The model provides intelligence; the harness provides everything else: context management, tool routing, safety guardrails, observability, memory, evaluation, and session orchestration.

Harness engineering is the discipline of building robust, production-grade infrastructure around LLMs. It is framework-agnostic, model-agnostic, and designed to outlast any single model generation.

## Why harness-one?

- **Framework-agnostic** -- works with any LLM provider (OpenAI, Anthropic, local models) through a simple adapter interface
- **Composable primitives** -- use one module or all twelve; no all-or-nothing framework lock-in
- **Zero runtime dependencies** -- pure TypeScript, nothing to audit or worry about in production
- **Complete coverage** -- addresses all 9 layers of the harness reference architecture in a single, cohesive package, plus RAG, multi-agent orchestration, and more

## Quick Start

> **Shortest path:** see [`examples/quickstart.ts`](./examples/quickstart.ts)
> — 20 LOC, one SDK, first streaming reply.

### `createSecurePreset` vs `createHarness` vs `createAgentLoop`

Three entry points, graduated by how much wiring they do for you. Pick the
one that matches how much control you need:

| Entry point | Package | What it gives you | Pick when |
|---|---|---|---|
| **`createSecurePreset`** | `@harness-one/preset` | Everything in `createHarness` **plus** fail-closed guardrail pipeline, default redaction, tool capability allow-list (`['readonly']`), sealed provider registry | You want opinionated reference wiring with secure defaults and minimal setup. |
| **`createHarness`** | `@harness-one/preset` | Core + all subsystems pre-wired (adapter, logger, traceManager, sessionManager, memory, cost tracker, lifecycle). No mandatory security posture. | Development / prototypes where you want everything connected but will flip security flags explicitly. |
| **`createAgentLoop`** | `harness-one` | Just the loop + whatever ports you pass in. Nothing else is wired. | À la carte. You only want the loop; you'll compose other primitives yourself. |

`createSecurePreset` is not the only production path. Use it when its defaults
match your deployment; drop to `createHarness` or raw primitives when they do not.

All packages are pre-release (`0.x` — every minor bump may break). The
canonical published version is whatever `npm view harness-one version`
returns; every other workspace package is fixed-version with it.

### Install

```bash
# À la carte — the core package (tree-shakeable submodules).
npm install harness-one

# Batteries-included preset — core + all integrations wired.
npm install @harness-one/preset @anthropic-ai/sdk
```

### Secure preset (recommended for production)

```ts
import { createSecurePreset } from '@harness-one/preset';
import Anthropic from '@anthropic-ai/sdk';

const harness = createSecurePreset({
  provider: 'anthropic',
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }),
  model: 'claude-sonnet-4-20250514',
  // guardrailLevel defaults to 'standard' (injection + contentFilter + PII)
});
```

Under the hood:
- `logger` / `traceManager` redact secrets by default
- `langfuseExporter` sanitizes span attributes
- Tool registry defaults to `allowedCapabilities: ['readonly']` (fail-closed);
  tools declaring `network`/`shell` must be widened via
  `createRegistry({ allowedCapabilities: [...] })` or `createPermissiveRegistry()`
- AgentLoop guardrail pipeline is pre-wired (input + output + tool-output hooks)
- OpenAI provider registry is sealed after construction
- `HarnessLifecycle` state machine auto-created with health checks for core components
- `MetricsPort` wired (no-op by default; swap in OTel adapter for real metrics)
- Unified config validation catches typos and invalid values at construction time

For the full preset surface (graceful shutdown, lifecycle health, provider
variants, optional integrations, observability, footguns), see
[`packages/preset/README.md`](./packages/preset/README.md).

### Using `harness-one` directly

Every public API is re-exported from the root entry **and** from its submodule
path. The root barrel carries 18 curated value symbols; everything else lives
on a submodule path. The full mapping is in
[`docs/guides/import-paths.md`](./docs/guides/import-paths.md).

Root-entry imports are convenient for prototypes and examples:

```typescript
import { createAgentLoop, defineTool, createRegistry, createPipeline } from 'harness-one';
```

Subpath imports are better for production builds (sharper tree-shaking):

```typescript
import { AgentLoop } from 'harness-one/core';
import { defineTool, createRegistry, toolSuccess } from 'harness-one/tools';
import { createPipeline, createInjectionDetector, runInput } from 'harness-one/guardrails';
```

`AgentLoop.run()` is **not re-entrant**: calling it again while a previous call
is still running throws `HarnessError('INVALID_STATE')`. Create one `AgentLoop`
instance per concurrent run, or await the previous run before starting a new one.

## Modules

Twelve composable subpaths plus seven sibling packages. The full per-module
API reference (with code samples for each subpath) is in
[`docs/modules.md`](./docs/modules.md).

| Subpath / Package | Purpose |
|---|---|
| `harness-one/core` | Agent Loop — LLM calling, tool dispatch, safety valves |
| `harness-one/prompt` | Prompt builder, registry, skill registry, disclosure |
| `harness-one/context` | Token budgets, packing, compression, cache stability |
| `harness-one/tools` | `defineTool`, registry, JSON Schema validation, rate limiting |
| `harness-one/guardrails` | Pipeline, injection detector, content filter, PII detector, rate limiter |
| `harness-one/observe` | TraceManager, CostTracker, Logger, MetricsPort, lifecycle |
| `harness-one/session` | TTL + LRU + locking + GC |
| `harness-one/memory` | In-memory / fs / vector stores + relay |
| `harness-one/orchestration` | AgentPool, Handoff, ContextBoundary, MessageQueue |
| `harness-one/rag` | Loaders, chunking, embedding, retriever, RAG pipeline |
| `harness-one/redact` | Redactor, value sanitization, secret patterns |
| `harness-one/infra` | AdmissionController, unref timer helpers |
| `harness-one/evolve-check` | Architecture rule engine (runtime checker) |
| `harness-one/advanced` | Middleware chain, resilient loop, fallback adapter, SSE, output parsers |
| `harness-one/testing` | Mock + chaos + cassette adapter factories (test-only) |
| [`@harness-one/preset`](./packages/preset/) | Batteries-included `createSecurePreset` / `createHarness` |
| [`@harness-one/devkit`](./packages/devkit/) | Eval runner, scorers, ComponentRegistry, DriftDetector |
| [`@harness-one/cli`](./packages/cli/) | `harness-one init` / `audit` scaffolder |
| [`@harness-one/anthropic`](./packages/anthropic/) / [`@harness-one/openai`](./packages/openai/) | Provider adapters |
| [`@harness-one/ajv`](./packages/ajv/) / [`@harness-one/tiktoken`](./packages/tiktoken/) | SchemaValidator / Tokenizer |
| [`@harness-one/redis`](./packages/redis/) / [`@harness-one/langfuse`](./packages/langfuse/) / [`@harness-one/opentelemetry`](./packages/opentelemetry/) | MemoryStore / TraceExporter |

## Examples

Lightweight reference implementations. Read the code to learn how to use a
specific subsystem or composition. Deterministic, no API key needed
(`pnpm examples:smoke` in CI).

- [`examples/codebase-qa.ts`](./examples/codebase-qa.ts) — RAG retrieval +
  fail-closed injection guardrails on retrieved chunks, with a mock
  AgentLoop reader producing citations.
- [`examples/autoresearch-loop.ts`](./examples/autoresearch-loop.ts) —
  Confidence-gated outer loop using harness-one `createFallbackAdapter` and
  standardized `computeBackoffMs`.
- [`examples/evolve-check-demo.ts`](./examples/evolve-check-demo.ts) —
  ComponentRegistry, DriftDetector, TasteCodingRegistry composed for a
  "code keeps being right" pass.

See [`examples/README.md`](./examples/README.md) for the full index.

## Showcases

Form-pressure experiments following the 7-stage method in
[`docs/harness-one-showcase-method.md`](./docs/harness-one-showcase-method.md).
Each showcase ships PLAN/HYPOTHESIS/FRICTION_LOG/OBSERVATIONS/HARVEST/FEEDBACK
and is run against a live API at least 10 times before archival into CI as
cassette replay.

Currently shipped at MVP build (Stage 3 of the 7-stage method —
runnable, deterministic, 6 markdown artifacts each):

- [`showcases/01-streaming-cli`](./showcases/01-streaming-cli) — `core`
  streaming + `session` + `observe` lifecycle
- [`showcases/02-rag-support-bot`](./showcases/02-rag-support-bot) —
  `rag` + multi-tenant scoping + injection guardrails
- [`showcases/03-memory-checkpoint-stress`](./showcases/03-memory-checkpoint-stress)
  — `FsMemoryStore` under SIGKILL crash injection
- [`showcases/04-orchestration-handoff`](./showcases/04-orchestration-handoff)
  — multi-agent `spawnSubAgent` + error / abort propagation

Run any of them with `pnpm -C showcases/<name> start`. Each carries a
[`PLAN.md`](./docs/showcase-plans/) + `HYPOTHESIS.md` + `FRICTION_LOG.md`
documenting predictions made before code was written and the friction
encountered while building. Stage 4 (`≥10 real-API runs`) and beyond
are open work.

See [`showcases/README.md`](./showcases/README.md) and
[`docs/harness-one-form-coverage.md`](./docs/harness-one-form-coverage.md)
for the full coverage matrix.

## Apps

Real agent applications built on harness-one. Production-grade code,
either continuously running or maturing into a vertical package.

- [`apps/dogfood/`](./apps/dogfood/) — Issue triage bot, runs on every new
  issue, reports land in `dogfood-reports/`.
- `apps/coding-agent/` (planned) — Autonomous coding agent, also published
  as the `harness-one-coding` vertical package
  ([design](./docs/app-designs/coding-agent-DESIGN.md)).
- `apps/research-collab/` (planned) — Multi-agent research collaboration
  pipeline ([design](./docs/app-designs/research-collab-DESIGN.md)).

Apps feed back to harness-one through `HARNESS_LOG.md` (continuous) and
quarterly `RETRO/` reviews. See
[`docs/harness-one-app-feedback-loop.md`](./docs/harness-one-app-feedback-loop.md).

## Architecture

### Module Dependency Graph

```
                    +-----------+
                    |   infra   |  <- JSON Schema, IDs, LRU, async-lock, timers, safe-log,
                    +-----+-----+      AdmissionController
                          |
                    +-----+-----+
                    |   core    |  <- shared types + AgentLoop + HarnessError(Code)
                    +-----+-----+      + TrustedSystemMessage helpers
                          |
  +--------+--------+-----+-----+--------+--------+--------+--------+----------------+---------------+
  |        |        |     |     |        |        |        |        |                |               |
  v        v        v     v     v        v        v        v        v                v               v
context  prompt   tools   guardrails  observe  session  memory    rag    evolve-check       orchestration
                                       |                  |
                                       v                  v
                              MetricsPort +            fs-io
                              HarnessLifecycle
```

Sibling packages:

```
@harness-one/cli      <- harness-one CLI binary
@harness-one/devkit   <- eval + evolve dev-tools
@harness-one/preset   <- batteries-included `createSecurePreset` / `createHarness`
```

Dependency rules (enforced by `harness-one/evolve-check`):

1. `infra/` -> no dependencies (leaf module)
2. `core/` -> only `infra/`
3. Every feature module -> only `core/` + `infra/` (mostly type-only imports)
4. Feature modules never import each other (`context`, `tools`, `guardrails`, `prompt`, etc. are siblings)
5. Sibling packages depend on `harness-one` as a regular or peer dep; never the reverse

### Key Design Decisions

- **Function-first API** -- factory functions (`createRegistry()`, `createBudget()`) over classes for composability
- **JSON Schema validation** -- tool parameters validated against JSON Schema at runtime
- **Fail-closed guardrails** -- errors in guardrails block by default (opt into fail-open)
- **Errors as feedback** -- tool errors are serialized back to the LLM for self-correction; stack traces are stripped so internal implementation details are never leaked to the model
- **Immutable data** -- `Object.freeze()` on all returned structures to prevent accidental mutation
- **Zero dependencies** -- pure TypeScript with only `node:fs`, `node:path`, and `node:readline` for the CLI

The full set of accepted ADRs lives in [`docs/adr/`](./docs/adr/).

## 12+ Layer Reference Architecture

| Layer | Module | Purpose |
|-------|--------|---------|
| 1. Agent Loop | `core` | LLM calling, tool dispatch, safety valves, optional traceManager |
| 2. Prompt Engineering | `prompt` | Multi-layer assembly, KV-cache optimization, skills |
| 3. Context Engineering | `context` | Token budgets, packing, cache stability |
| 4. Tool System | `tools` | Definition, validation, registry, rate limiting |
| 5. Safety & Guardrails | `guardrails` | Input/output filtering, injection detection, auto-wired in createHarness() |
| 6. Observability | `observe` | Tracing, spans, cost tracking, budget alerts |
| 7. Session Management | `session` | TTL, LRU eviction, locking, garbage collection |
| 8. Memory & Persistence | `memory` | Graded storage, sessionId filter, atomic fs writes, cross-context relay |
| 9. Evaluation | `@harness-one/devkit` | Scorers, quality gates, generator-evaluator, flywheel |
| 10. Evolution | `@harness-one/devkit` + `harness-one/evolve-check` | Component registry, drift detection (devkit) + architecture rules (core) |
| 11. Multi-Agent Orchestration | `orchestration` | AgentPool, Handoff (sealed `SendHandle` + 64 KiB cap), MessageTransport, ContextBoundary (segment-aware), MessageQueue |
| 12. RAG Pipeline | `rag` + `runRagContext` | Document loading, chunking, embedding, retrieval, token estimates, per-chunk guardrail scanning |

For per-feature maturity (Production / Monitoring / Advisory / etc.), see
[`docs/feature-maturity.md`](./docs/feature-maturity.md).

## CLI

Scaffold harness-one boilerplate or audit existing usage:

```bash
npx harness-one init --modules core,tools,guardrails    # scaffold starter files
npx harness-one audit                                    # print per-module usage stats
```

Full command reference: [`packages/cli/README.md`](./packages/cli/README.md).

## Troubleshooting

See [`docs/guides/troubleshooting.md`](./docs/guides/troubleshooting.md)
for the full error-code table and common foot-guns. Highlights:

- **Fallback adapter never recovers to primary** — by design. The breaker advances one-way. See [`docs/guides/fallback.md`](./docs/guides/fallback.md) for periodic-reset and active-health-check patterns.
- **Fallback switched but I have no logs** — there is no `adapter_switched` event on `AgentLoop`. Wrap each inner adapter to log via `categorizeAdapterError()`; see `examples/observe/error-handling.ts`.
- **All adapter errors classified as `ADAPTER_ERROR`** — `categorizeAdapterError()` inspects `err.message`, not `.code`. Ensure your provider SDK surfaces readable messages, or classify upstream.
- **Guardrails don't block in tests** — `createPipeline({ failClosed: true })` blocks *on error*; explicit `block` verdicts still require the guard to match. Use `sensitivity: 'high'` on `createInjectionDetector` to widen coverage.
- **Costs reported as 0** — the model has no registered pricing. Enable `warnUnpricedModels: true` (default) on `createCostTracker` and watch for the one-time warning.
- **Cache-hit metrics always 0** — the adapter isn't forwarding `cacheReadTokens` / `cacheWriteTokens`. Check the adapter's `toTokenUsage()` mapping.

More runbooks in [`docs/guides/`](./docs/guides/).

## Quality gates & supply chain

harness-one aims to be auditable end-to-end. The table below lists every
enforcement gate that runs on `main` and on pull requests — all wired
in `.github/workflows/` and surfaced through the badges above.

| Gate | When it runs | What it enforces |
|------|--------------|------------------|
| `ci.yml` | every PR + push to `main` | Lint, type-check, unit/integration/conformance tests, per-package coverage floor (80% lines/statements, 75% branches on `packages/core`) |
| `api-check.yml` | every PR | `api-extractor` snapshot diff — any public-API change must land with its regenerated `packages/*/etc/*.api.md` |
| `compat-matrix.yml` | every PR | Installs each adapter against the lowest, mid, and highest supported peer-dep version so declared ranges stay honest |
| `docs-links.yml` | PR + weekly schedule | `lychee` link-checks every Markdown file; no silent link rot |
| `audit.yml` | PR + weekly schedule | `pnpm audit --audit-level=high --prod` — any high/critical advisory against the production graph fails CI |
| `secret-scan.yml` | PR + push | `gitleaks` over the diff; no soft-warn — any finding fails the job |
| `scorecard.yml` | weekly + push to `main` | OpenSSF Scorecard, published as SARIF into GitHub code scanning (see badge) |
| `mutation.yml` | weekly + manual dispatch | Stryker mutation testing against `packages/core` (`src/infra/validate.ts`, `src/guardrails/pipeline.ts`, and the agent-loop trio) |
| `perf.yml` | every PR | `tinybench` p50/p99 regression gate for the five critical hot paths (baseline in `packages/core/perf/baseline/`) |
| `fuzz.yml` | nightly + manual dispatch | `fast-check` fuzz campaign across the four parser surfaces (tool-args, guardrail input, SSE, prompt template) |
| `cassette-drift.yml` | nightly | Re-records Anthropic + OpenAI contract cassettes against the live APIs; diff opens a tracking issue rather than auto-committing |
| `migrations.yml` | every PR | Executes every `tools/migrations/*/` fixture and asserts pre-snippets fail / post-snippets succeed against current code |
| `release-pack.yml` | every PR touching publishable code | `pnpm pack` reproducibility — same source with pinned `SOURCE_DATE_EPOCH` must produce byte-identical tarballs (precondition for SLSA provenance) |
| `release.yml` | GitHub Release tag | Builds, re-verifies pack reproducibility, attests SLSA build provenance via Sigstore, publishes via npm OIDC trusted publisher (no `NPM_TOKEN`) |
| `sbom.yml` | tagged release + manual dispatch | Generates CycloneDX SBOM + `npm audit` snapshot; attached as Release assets |

Supporting material — all reviewable in-repo:

- [`SECURITY.md`](./SECURITY.md) — supported versions, private disclosure flow, SLA, safe-harbor statement.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — Contributor Covenant v2.1.
- [`.github/CODEOWNERS`](./.github/CODEOWNERS) — review routing per package.
- [`docs/security/`](./docs/security/) — STRIDE threat models per subsystem (`core`, `prompt`, `context`, `tools`, `guardrails`, `observe`, `session`, `memory`, `rag`, `redact`) plus the OpenSSF Best Practices self-assessment.
- [`docs/adr/`](./docs/adr/) — Architecture Decision Records (ADR-0001 through ADR-0010, MADR 4.0 format).

## Docs

Start here:

| Topic | File |
|-------|------|
| Per-module public API reference | [`docs/modules.md`](./docs/modules.md) |
| Import-path cheatsheet | [`docs/guides/import-paths.md`](./docs/guides/import-paths.md) |
| Feature maturity matrix | [`docs/feature-maturity.md`](./docs/feature-maturity.md) |
| Architecture mental model | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| Per-module architecture (01-17) | [`docs/architecture/00-overview.md`](./docs/architecture/00-overview.md) |
| Testing layers (unit → chaos → fuzz) | [`docs/architecture/17-testing.md`](./docs/architecture/17-testing.md) |
| Architecture decisions | [`docs/adr/`](./docs/adr/) |
| Public roadmap | [`docs/ROADMAP.md`](./docs/ROADMAP.md) |
| Threat models + OSSF self-assessment | [`docs/security/`](./docs/security/) |
| `AgentAdapter` contract for provider authors | [`docs/provider-spec.md`](./docs/provider-spec.md) |
| RAG conformance specs | [`docs/retriever-spec.md`](./docs/retriever-spec.md), [`docs/embedding-spec.md`](./docs/embedding-spec.md), [`docs/chunking-spec.md`](./docs/chunking-spec.md) |
| Release engineering runbook | [`docs/release.md`](./docs/release.md) |
| i18n translation plan | [`docs/i18n-strategy.md`](./docs/i18n-strategy.md) |
| Breaking changes (pre-release) | [`MIGRATION.md`](./MIGRATION.md) |

## Contributing

The full contributor guide is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
Short version:

1. Fork, branch off `main`, keep changes focused (1 PR = 1 logical change).
2. Near-100% test coverage is the bar on `packages/core`. CI enforces 80% lines/statements and 75% branches.
3. Any user-visible change needs a [changeset](https://github.com/changesets/changesets): `pnpm changeset`.
4. Read [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) before posting. Report security issues privately per [`SECURITY.md`](./SECURITY.md) — **do not** open a public issue.

### Development

harness-one is a `pnpm` monorepo. `npm` / `yarn` will not work — the
`preinstall` hook rejects them, and `pnpm-workspace.yaml` is required
to resolve internal `workspace:*` links.

```bash
# Prerequisites: Node >= 20, pnpm >= 9.
corepack enable             # or: npm i -g pnpm@9

pnpm install                # workspace install (frozen lockfile on CI)
pnpm build                  # tsup — ESM + CJS + .d.ts for every package
pnpm test                   # full workspace test run (vitest)
pnpm test:coverage          # with coverage gate
pnpm typecheck              # tsc --noEmit across packages
pnpm lint                   # ESLint across packages
pnpm changeset              # required on any user-visible change
```

Track-level suites (optional, not on the PR critical path):

```bash
pnpm --filter harness-one bench                  # tinybench; baseline in packages/core/perf/
pnpm --filter harness-one fuzz                   # fast-check, ~10k iterations per target
pnpm --filter harness-one mutation               # Stryker (expensive — several minutes)
pnpm --filter harness-one typecheck:type-level   # expect-type compile-time suite
pnpm size                                        # size-limit bundle budget
pnpm check:tree-shake                            # root-bundle tree-shake assertions
pnpm docs:api                                    # TypeDoc public-API report
```

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
