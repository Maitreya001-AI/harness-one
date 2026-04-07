# PRD: harness-one — Universal Harness Engineering Toolkit

**Version**: 1.0 | **Date**: 2026-04-07 | **Status**: Consensus (Post-Debate)
**Debate Rounds**: 1 (convergence achieved)

---

## 1. Vision

**harness-one** is a TypeScript toolkit of universal primitives for AI Agent harness engineering. It provides the ~30% of harness infrastructure that is identical across every production agent — done once, done right.

> **Agent = Model + Harness. harness-one IS the Harness.**

### What It Is
- A composable primitives toolkit (~4,000 lines)
- Framework-agnostic (works with Anthropic SDK, OpenAI, Vercel AI SDK, LangChain, or raw HTTP)
- The "hard 30%" that every team rebuilds from scratch

### What It Is NOT
- Not an agent framework (no chain/graph orchestration)
- Not an LLM abstraction layer (users bring their own model client)
- Not a full platform (no SaaS, no database, no deployment)
- Not an opinionated pipeline (no middleware builder pattern)

---

## 2. Target Users

| Segment | % | Pain Point |
|---------|---|-----------|
| **AI Agent Product Teams** | 70% | Rebuild identical infrastructure (guardrails, context management, tool validation) for every agent product |
| **AI Platform Engineers** | 20% | No reusable primitives; copy-paste from blog posts and reverse-engineering |
| **Framework Authors** | 10% | Need well-typed building blocks to extend, not compete with |

### Primary Persona: "The Production Agent Engineer"
- Building a production AI agent (coding assistant, customer support bot, data agent)
- Already has an LLM integration working (Anthropic SDK / OpenAI / Vercel AI SDK)
- Needs to go from "works in demo" to "works in production"
- Currently at L0-L1 maturity, wants to reach L2-L3

---

## 3. Feature Priorities

### P0 — MVP (Core Toolkit)

#### 3.1 Agent Loop Primitives (`harness-one/core`)
A typed AsyncGenerator-based agent loop with safety valves. The library handles loop mechanics; users provide iteration logic.

**Ships:**
- `AgentLoop<TState>` — core while-true loop with max iterations, abort signal, backpressure
- `IterationHandler<TState>` — user-implemented interface for context assembly, tool execution, stop conditions
- `AgentEvent` — typed event union (text_delta, tool_call, tool_result, error, done)
- `AgentAdapter` — interface contract for LLM integration (users implement for their SDK)
- Streaming support via AsyncGenerator (non-trivial to get right across providers)

**Does NOT ship:**
- LLM client implementations (no Anthropic/OpenAI wrappers)
- Prompt assembly or template systems
- Specific tool implementations

**Estimated scope:** ~500 lines

#### 3.2 Context Engineering Primitives (`harness-one/context`)
Five composable primitives for managing the context window as scarce RAM. No opinionated pipeline — users compose primitives as needed.

**Ships:**
1. **`countTokens(model, messages)`** — Accurate token counting across model families (Claude, GPT, etc.). Fast heuristic fallback.
2. **`TokenBudget`** — Budget allocation with user-defined segments, priority-based trimming, and reserved space for system/tools/response.
3. **`packContext({ head, mid, tail, budget })`** — Position-aware context assembly implementing Lost-in-the-Middle research. HEAD = KV-cache stable prefix, MID = compressible, TAIL = high-attention.
4. **`compress(messages, { strategy, budget, preserve })`** — Four compression strategies: sliding-window, summarize (LLM-based), extract-to-memory, truncate. Composable. Preserves failure traces by default.
5. **`analyzeCacheStability(v1, v2)`** — Unique differentiator. Compares two context versions and reports prefix match %, first divergence point, and optimization recommendations. Enables teams to measure and optimize KV-cache hit rates.

**Does NOT ship:**
- Query complexity classifiers (domain-specific)
- Prompt templates or assembly pipelines (domain-specific)
- Specific serialization formats (domain-specific)
- Decisions about what goes in HEAD/MID/TAIL (user's choice)

**Estimated scope:** ~1,500 lines

#### 3.3 Tool System Primitives (`harness-one/tools`)
Declarative tool definitions with runtime validation and structured error feedback.

**Ships:**
1. **`defineTool({ name, description, parameters, execute })`** — Declarative tool builder with JSON Schema parameters. Supports TypeBox and Zod via adapters.
2. **`ToolRegistry`** — Registry with namespace conventions (`namespace.action`), per-turn call limits, and tool listing/filtering.
3. **`ToolResult`** — Structured result type with `{ success, data, error? }`. Implements "Errors as Feedback" pattern — tool failures return as LLM-readable context, not thrown exceptions.
4. **`validateToolCall(schema, params)`** — Runtime parameter validation with structured error messages including suggested corrections (Poka-yoke pattern).

**Does NOT ship:**
- Tool Masking (requires logit-level access to LLM inference)
- Specific tool implementations
- response_format (model-specific)

**Estimated scope:** ~800 lines

#### 3.4 Guardrail Pipeline (`harness-one/guardrails`)
Plugin-based input/output guardrail pipeline with self-healing retry and Fail-Closed default.

**Ships:**
1. **`GuardrailPipeline`** — Configurable pipeline that runs input checks before LLM call and output checks after. Plugin architecture — users register custom guardrails.
2. **`InputGuardrail` / `OutputGuardrail`** — Interface contracts for custom guardrails.
3. **Reference implementations:**
   - `RateLimiter` — Configurable rate limiting (requests/window)
   - `InjectionDetector` — Pattern-based injection detection. Ships with base English patterns; users add language-specific patterns via config.
   - `SchemaValidator` — JSON Schema-based output validation
   - `ContentFilter` — Configurable keyword/pattern-based content filtering
4. **`SelfHealingRetry`** — When output guardrails fail, constructs feedback message and re-prompts LLM (max N retries). Implements the Generator-Evaluator separation pattern.
5. **`FailClosed`** — Default behavior: if a guardrail errors, block the request (not allow).

**Does NOT ship:**
- PII detection (requires NLP models — separate concern)
- Hallucination detection (requires RAG context comparison — domain-specific)
- Toxicity classification (requires ML models)
- Permission management UI

**Estimated scope:** ~1,000 lines

### P1 — Production Operations (4 weeks post-MVP)

#### 3.5 Observability (`harness-one/observe`)
- `TraceManager` interface + `NoOpTraceManager` + `ConsoleTraceManager`
- `CostTracker` with user-configurable pricing table (not hardcoded)
- OpenTelemetry-compatible span/trace model
- Cost-aware behavior hook: budget threshold → callback for agent to adjust behavior

#### 3.6 Session Management (`harness-one/session`)
- `SessionManager` with TTL, LRU eviction, max concurrent sessions
- Prompt locking (prevent concurrent requests to same session)
- Session lifecycle events (create, resume, expire, destroy)

### P2 — Ecosystem (8+ weeks post-MVP)

#### 3.7 Memory Interface (`harness-one/memory`)
- `MemoryStore` interface contract with value-graded writes (critical/useful/ephemeral)
- `FileSystemMemory` reference implementation
- Cross-context relay utility (`createRelay`)
- Documentation: memory integration patterns guide

#### 3.8 CLI Scaffolding Tool
- `npx harness-one init` — generates boilerplate for guardrails, observability, tool definitions
- Project templates for common agent types (coding assistant, customer support, data analysis)

### P3 — Documentation Only (shipped as guides, not code)

#### Eval & Validation Patterns
- Guide: Setting up Generator-Evaluator separation
- Guide: CI gate for agent quality
- Guide: Data flywheel (low-score traces → test cases)

#### Continuous Evolution Patterns
- Guide: Build-to-Delete discipline (tagging assumptions on each component)
- Guide: Taste-coding flywheel implementation
- Guide: AGENTS.md best practices

#### Entropy Recovery Patterns
- Guide: Architecture constraint linting
- Guide: Instructional lint errors for agents
- Guide: Background entropy scanning

---

## 4. Architecture Decisions

### AD-001: Single Package with Subpath Exports
**Decision:** Ship as `harness-one` with subpath exports (`harness-one/context`, `harness-one/guardrails`, etc.). Split into separate packages only after v1.0 API stabilization.
**Rationale:** Premature package splitting creates version lock and coordination overhead. Subpath exports provide the same DX (tree-shakeable imports) without the maintenance cost.

### AD-002: No LLM Abstraction
**Decision:** The library does NOT wrap LLM API calls. Users bring their own client (Anthropic SDK, OpenAI SDK, etc.) and implement the `AgentAdapter` interface.
**Rationale:** LLM abstraction is a solved problem (Vercel AI SDK, LiteLLM). Competing here wastes effort and creates unwanted lock-in. Our value is the harness, not the model call.

### AD-003: JSON Schema as Interchange Format
**Decision:** Tool definitions and validation use JSON Schema internally. TypeBox and Zod adapters provided as helpers.
**Rationale:** JSON Schema is the universal standard that all LLM providers use for tool definitions. TypeBox and Zod are popular but opinionated. Supporting both via adapters maximizes compatibility.

### AD-004: Composable Primitives, Not Pipeline Framework
**Decision:** Each primitive is independently usable. No required initialization order or pipeline orchestration.
**Rationale:** The middleware pipeline pattern fails for agent loops (which are cyclical, not linear). Forcing users into a pipeline prevents adoption by teams with existing agent architectures.

### AD-005: Fail-Closed Security Default
**Decision:** All guardrails default to blocking when they error (Fail-Closed, not Fail-Open).
**Rationale:** Production agents handling user data must default to safety. Users can explicitly opt into Fail-Open for specific guardrails.

### AD-006: Preserve Failure Traces
**Decision:** All compression strategies preserve failure/error traces by default (lowest compression priority).
**Rationale:** Per Manus research, failure traces are implicit learning signals for the LLM. Compressing them away degrades agent performance over long conversations.

---

## 5. User Stories

| # | Story | Priority |
|---|-------|----------|
| US-01 | As an agent developer, I want to count tokens accurately across Claude and GPT models so I can manage my context budget | P0 |
| US-02 | As an agent developer, I want to pack my context window with position-awareness (HEAD/MID/TAIL) so important information is in high-attention zones | P0 |
| US-03 | As an agent developer, I want to define tools with schema validation and get structured error feedback when parameters are invalid, so my agent can self-correct | P0 |
| US-04 | As an agent developer, I want input guardrails (injection detection, rate limiting) that run before my LLM call so I can prevent abuse | P0 |
| US-05 | As an agent developer, I want output guardrails with self-healing retry so my agent can recover from invalid outputs without user intervention | P0 |
| US-06 | As an agent developer, I want a typed agent loop with max iterations and abort support so my agent can't run away | P0 |
| US-07 | As an agent developer, I want to measure KV-cache prefix stability between context versions so I can optimize my cache hit rate | P0 |
| US-08 | As an agent developer, I want to compress conversation history with multiple strategies while preserving failure traces | P0 |
| US-09 | As an agent developer, I want trace/span instrumentation with cost tracking so I can monitor my agent's behavior and spending | P1 |
| US-10 | As an agent developer, I want session management with TTL and LRU eviction so I can run multiple concurrent agent sessions | P1 |
| US-11 | As an agent developer, I want a cross-context relay mechanism so my long-running agent can persist progress across context windows | P2 |

---

## 6. Success Metrics

| Metric | Target (6 months) |
|--------|-------------------|
| npm weekly downloads | > 1,000 |
| GitHub stars | > 500 |
| Package size (minified) | < 50KB |
| Test coverage | > 90% |
| Zero runtime dependencies for core | ✓ |
| Time to "Hello Harness" (developer onboarding) | < 10 minutes |
| Number of framework integration examples | >= 3 (Anthropic SDK, OpenAI, Vercel AI SDK) |

---

## 7. Scope Boundaries

### Explicitly IN Scope
- TypeScript/Node.js runtime
- Universal primitives for the 9-layer architecture
- JSON Schema-based tool definitions
- Plugin-based guardrail pipeline
- Position-aware context packing
- KV-cache stability analysis
- Framework integration examples and documentation

### Explicitly OUT of Scope
- LLM API wrappers or abstractions
- Database/storage implementations (beyond filesystem reference)
- ML-based guardrails (PII detection, toxicity classification, hallucination detection)
- UI components or frontend code
- Deployment infrastructure
- SaaS platform or hosted services
- Python implementation (future consideration)
- Specific agent implementations (coding agent, support agent, etc.)

---

## 8. Technical Constraints

| Constraint | Rationale |
|-----------|-----------|
| Zero runtime dependencies for core primitives | Minimize supply chain risk; maximize compatibility |
| Node.js >= 18 | Stable LTS with native fetch, AbortController, AsyncGenerator support |
| ESM-first with CJS fallback | Modern module system; backward compat for legacy toolchains |
| TypeScript strict mode | Type safety is a core value proposition |
| No class inheritance in public API | Composition over inheritance; easier to tree-shake |

---

## 9. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| "Too abstract" — primitives too generic to be useful | HIGH | MEDIUM | Ship with 3+ real-world examples; every API has concrete usage docs |
| Model evolution invalidates Harness assumptions | HIGH | HIGH | Every component declares its model-assumption; Build-to-Delete metadata |
| Competitors ship similar primitives | MEDIUM | HIGH | Move fast; context engineering + cache stability analysis is current unique wedge |
| Scope creep into framework territory | MEDIUM | MEDIUM | PRD scope boundaries enforced; "Does NOT ship" lists in every section |
| Low adoption due to small scope | MEDIUM | MEDIUM | Exceptional docs; scaffolding CLI; framework integration guides |

---

## 10. Delivery Plan

| Phase | Timeline | Deliverable |
|-------|----------|-------------|
| P0: Core Toolkit | Weeks 1-4 | `harness-one` with core, context, tools, guardrails subpaths |
| P1: Production Ops | Weeks 5-8 | observe, session subpaths added |
| P2: Ecosystem | Weeks 9-12 | memory interface, CLI scaffolding, framework adapters |
| P3: Patterns Library | Ongoing | Documentation for eval, evolution, entropy recovery patterns |

---

## Appendix: Debate Resolution Summary

| Topic | PA Position | TS Position | Consensus |
|-------|------------|-------------|-----------|
| Scope | 9-layer library | 30% extractable | **Primitives toolkit (~4K lines)** |
| Agent Loop | Middleware pipeline | AsyncGenerator loop | **AsyncGenerator + safety valves** |
| Context Eng. | Standalone package | Two small utilities | **5 primitives in single package** |
| Memory | P1 priority | Defer entirely | **P2, interface + docs only** |
| Package structure | 8 separate packages | Single package | **Single package, subpath exports** |
| LLM abstraction | Provider-agnostic wrapper | No wrapper | **No wrapper, AgentAdapter interface** |
| CLI tool | Audit CLI | Scaffolding CLI | **Scaffolding CLI (init)** |
| Schema library | TypeBox or Zod | JSON Schema | **JSON Schema core, adapters for both** |
