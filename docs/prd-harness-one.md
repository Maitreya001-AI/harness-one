# PRD: Harness-One — Universal Harness Engineering Library

**Version**: 1.0
**Created**: 2026-04-07
**Status**: Draft (Adversarial Review Pending)
**Author**: product-advocate

---

## 1. Executive Summary

Harness-One is a generic, framework-agnostic TypeScript/Node.js library that provides the foundational building blocks for Harness Engineering — the discipline of designing environments, constraints, and feedback loops around AI Agents. It codifies the 9-layer reference architecture, 18 design patterns, and maturity model into composable, production-ready primitives, so that teams building AI Agent products can skip from L0 ("bare LLM calls") to L2+ within days instead of months.

## 2. Problem Statement

### 2.1 User Pain Points

1. **Reinventing the wheel**: Every team building an AI Agent product independently implements the same core infrastructure — agent loops, context management, guardrails, tool systems, memory, observability. This wastes 4-8 weeks per project.
2. **Knowledge gap**: The Harness Engineering body of knowledge (Anthropic, OpenAI, Manus, Martin Fowler) is scattered across 16+ blog posts, papers, and open-source projects. Teams don't know what they don't know until production failures teach them.
3. **Quality cliff**: Most agent products work in demos (L0) but fail in production. The gap between "it works on my laptop" and "it works reliably at scale" is dominated by harness concerns — not model capabilities.
4. **Cost blindness**: Without KV-cache optimization, context budget management, and cost-aware behavior, teams routinely 5-10x overspend on LLM API costs.
5. **No upgrade path**: Teams hard-code harness assumptions (e.g., model-specific workarounds) with no mechanism to retire them when models improve, accumulating technical debt at compound interest.

### 2.2 Current Solutions & Their Gaps

| Solution | Gap |
|----------|-----|
| **LangChain / LlamaIndex** | Focus on chain orchestration, not harness engineering. Weak on context engineering, guardrail pipelines, entropy recovery, cost optimization. Opinionated about model providers. |
| **Vercel AI SDK** | Frontend-focused. Good streaming UX, but no structured context management, no guardrail pipeline, no memory system, no evaluation framework. |
| **Claude Agent SDK** | Claude-specific. Excellent patterns but locked to Anthropic API. Not composable as standalone harness primitives. |
| **Roll your own** | Every team does this. Results are inconsistent, undocumented, and rarely reach L2 maturity. |

### 2.3 Business Impact

- Teams waste **4-8 weeks** rebuilding harness infrastructure per project
- Production agent reliability sits at **60-70%** without proper harness (vs 90%+ with)
- LLM API costs are **5-10x higher** without context/cache optimization
- Knowledge stays siloed — lessons from one project don't transfer to the next

## 3. Target Users

### Primary: AI Agent Product Engineers (IC)

- **Profile**: Senior engineers building AI-powered products (coding assistants, customer service agents, data analysis agents, content generation tools)
- **Context**: TypeScript/Node.js stack, using OpenAI/Anthropic/other LLM APIs
- **Pain**: Spending more time on harness plumbing than on product logic
- **Goal**: Ship reliable, cost-efficient agents faster

### Secondary: AI Platform Teams

- **Profile**: Teams building internal AI platforms for their organization
- **Context**: Need to standardize patterns across multiple agent products
- **Pain**: Each team makes different (often wrong) harness decisions
- **Goal**: Provide a shared, battle-tested foundation

### Tertiary: AI Consultants & Educators

- **Profile**: People teaching or implementing harness engineering practices
- **Context**: Need reference implementations of documented patterns
- **Pain**: Theory exists (reference architecture) but no runnable code
- **Goal**: Demonstrate best practices with real code

## 4. Core Value Proposition

**Why a library, not project-specific code?**

1. **Composable primitives, not a framework**: Import only what you need. Use the context manager without the guardrail pipeline. Use the tool system without the agent loop. No lock-in.
2. **Encode institutional knowledge**: The 18 design patterns and 10 anti-patterns become runtime-enforced defaults, not tribal knowledge.
3. **Built-in maturity ladder**: Start at L1 with `createAgentLoop()` + `createToolSystem()`. Incrementally adopt context engineering (L2), evaluation (L3), and continuous evolution (L4) as your product matures.
4. **Model-agnostic**: Works with any LLM provider. Harness concerns (context layout, guardrails, memory, observability) are orthogonal to model choice.
5. **Build to Delete**: Every component encodes its own retirement condition. When models improve, the library tells you what to remove.

## 5. User Stories

### US-001: Bootstrap Agent Loop
**As a** product engineer starting a new AI agent project
**I want** a production-ready agent loop with tool execution, streaming, and safety limits
**So that** I can focus on my product logic instead of reimplementing ReAct from scratch

**Acceptance Criteria**:
- [ ] `createAgentLoop(config)` returns an AsyncGenerator yielding events (tool_call, tool_result, text_delta, done)
- [ ] Configurable max iterations, timeout, and token budget
- [ ] Tool calls are automatically validated against schema before execution
- [ ] Errors from tools are returned to the LLM as structured feedback (not thrown)

### US-002: Manage Context Window
**As a** product engineer building a long-conversation agent
**I want** automatic context window management with HEAD/MID/TAIL layout
**So that** my agent maintains high-quality responses without exceeding token limits or wasting KV-cache

**Acceptance Criteria**:
- [ ] Composable context primitives: `createBudget(config)` allocates per-segment token budgets; `packContext(layout)` assembles messages in HEAD/MID/TAIL order; `compactIfNeeded(messages, options)` triggers compression when the budget is near exhaustion
- [ ] Supports HEAD (stable prefix, system prompt), MID (compressible history), TAIL (recent turns + high-attention zone) layout
- [ ] Configurable token budget per zone
- [ ] Multiple compression strategies: truncation, summarization (pluggable), failure-trace preservation
- [ ] Append-only message state by default (anti-pattern: modifying existing context)

### US-003: Define & Validate Tools
**As a** product engineer adding capabilities to my agent
**I want** a declarative tool definition system with runtime validation and structured error feedback
**So that** my agent reliably uses tools and self-corrects on errors

**Acceptance Criteria**:
- [ ] Tools defined with name, description, JSON Schema parameters, and handler function
- [ ] Automatic parameter validation before handler execution
- [ ] Failed tool calls return structured `ToolResult` with error details and `suggestedAction`
- [ ] Tool namespace consistency enforced (configurable prefix convention)
- [ ] Per-turn and per-session call limits configurable

### US-004: Add Input/Output Guardrails
**As a** product engineer shipping an agent to production
**I want** a configurable guardrail pipeline for both input and output
**So that** my agent doesn't process malicious input or produce harmful/invalid output

**Acceptance Criteria**:
- [ ] `createPipeline(config)` (from `harness-one/guardrails`) accepts ordered lists of guardrail entries (`{name, guard}`) for input/output
- [ ] Input guardrails: injection detection, PII detection, toxicity, rate limiting (all pluggable)
- [ ] Output guardrails: safety check, schema validation, hallucination detection (all pluggable)
- [ ] Output self-heal retry mechanism (configurable max retries)
- [ ] Fail-closed by default (blocked if any guardrail errors)
- [ ] Guardrails emit observability events

### US-005: Persist Memory Across Sessions
**As a** product engineer building a personalized agent
**I want** a structured memory system that persists across sessions with value-based filtering
**So that** my agent remembers important context without bloating its context window

**Acceptance Criteria**:
- [ ] Pluggable backends via `createInMemoryStore(config)` (default), `createFileSystemStore(config)` (filesystem), and third-party adapters for KV stores / databases
- [ ] Memory entries have type, relevance score, and TTL
- [ ] Write-side: value assessment before storage (don't save what can be derived)
- [ ] Read-side: relevance-ranked retrieval with token budget
- [ ] Cross-session relay support (progress files, handoff artifacts)

### US-006: Observe Agent Behavior
**As a** a platform engineer operating agents in production
**I want** built-in tracing, cost tracking, and actionable alerts
**So that** I can debug issues, optimize costs, and detect quality regressions

**Acceptance Criteria**:
- [ ] Every pipeline step (input guardrail → context assembly → LLM call → output guardrail → tool execution) emits trace spans
- [ ] Per-turn and per-session cost tracking (input/output tokens, cache hits)
- [ ] Pluggable trace exporters (console, OpenTelemetry, Langfuse, custom)
- [ ] Cost threshold alerts that can inject warnings into agent context (cost-aware behavior pattern)

### US-007: Evaluate Agent Quality
**As a** a product engineer improving my agent over time
**I want** a built-in evaluation framework with generator-evaluator separation
**So that** I can measure quality, set CI gates, and catch regressions before production

**Acceptance Criteria**:
- [ ] `createEvalRunner(config)` (from `harness-one/eval`) supports multiple scoring dimensions via pluggable `Scorer`s
- [ ] Generator-evaluator separation: evaluator runs as independent process/prompt
- [ ] Sprint contract pattern: define acceptance criteria before generation
- [ ] Eval results exportable as dataset for regression testing
- [ ] Low-score traces automatically flagged for review (data flywheel)

### US-008: Adopt Incrementally
**As a** product engineer with an existing agent codebase
**I want** to adopt harness-one primitives one at a time without rewriting my entire system
**So that** I can improve my agent's reliability incrementally with minimal risk

**Acceptance Criteria**:
- [ ] Each module (agent-loop, context, tools, guardrails, memory, observability, eval) is independently importable
- [ ] No required peer dependencies between modules (optional integration points)
- [ ] Can wrap existing tool definitions, existing memory stores, existing LLM clients
- [ ] Migration guide for common patterns (LangChain tools → harness-one tools, etc.)

## 6. Functional Requirements

### P0 — Must Have (MVP)

| ID | Requirement | User Value | Acceptance Test |
|----|------------|------------|-----------------|
| REQ-001 | **Agent Loop** — AsyncGenerator-based ReAct loop with streaming, max iterations, token budget | Foundation for any agent product | Loop executes tools, streams text, respects limits |
| REQ-002 | **Tool System** — Declarative definition, JSON Schema validation, structured error feedback, namespacing | Reliable tool usage, self-correction | Invalid params rejected; errors returned as ToolResult |
| REQ-003 | **Context Manager** — HEAD/MID/TAIL layout, token budgeting, append-only state, basic truncation compression | Context doesn't explode; cache-friendly | 100-turn conversation stays within budget |
| REQ-004 | **Guardrail Pipeline** — Input/output pipeline, fail-closed default, self-heal retry, pluggable guards | Production safety from day one | Injection attempts blocked; invalid output retried |
| REQ-005 | **Observability Core** — Trace spans per pipeline step, cost tracking (tokens + cache hits), console exporter | Debug and cost-optimize from day one | Every LLM call has a trace with token counts |
| REQ-006 | **TypeScript-first API** — Full type safety, TypeBox/Zod schema support, zero runtime dependencies on LLM providers | Best-in-class DX | All public APIs have complete type definitions |

### P1 — Should Have

| ID | Requirement | User Value | Acceptance Test |
|----|------------|------------|-----------------|
| REQ-007 | **Memory System** — Pluggable backends, value filtering, cross-session relay | Personalization and long-running tasks | Memory persists across sessions; irrelevant entries filtered |
| REQ-008 | **Advanced Compression** — LLM-based summarization, failure-trace preservation, external-state-aware compression | Better context utilization in long conversations | Compression preserves failure traces; removes externally-persisted info |
| REQ-009 | **Evaluation Framework** — Generator-evaluator separation, multi-dimension scoring, sprint contracts | Quality measurement and CI gates | Eval scores computed; regressions caught in CI |
| REQ-010 | **OpenTelemetry Exporter** — OTLP trace export, Langfuse integration | Production observability stack integration | Traces visible in Jaeger/Langfuse |
| REQ-011 | **Cost-Aware Behavior** — Budget thresholds, prompt injection of cost warnings, automatic response trimming | Prevent cost overruns | Agent reduces verbosity when approaching budget |
| REQ-012 | **Progressive Disclosure** — Skill/knowledge loading by relevance, 3-tier metadata→full→attachment loading | Efficient context usage in capability-rich agents | Only relevant skills loaded into context |

### P2 — Nice to Have

| ID | Requirement | User Value | Acceptance Test |
|----|------------|------------|-----------------|
| REQ-013 | **Entropy Recovery** — Lint rule integration, architectural constraint enforcement, pedagogical error messages | Long-term codebase health | Lint errors include fix guidance; Agent self-repairs |
| REQ-014 | **Build-to-Delete Tracking** — Component retirement conditions, model capability assertions, deprecation alerts | Prevent harness over-engineering | Alert when model improves past component's assumption |
| REQ-015 | **Ralph Wiggum Loop** — Outer retry loop with fresh context, file/git state persistence | Resilience for complex multi-step tasks | Failed task retried with clean context; progress preserved |
| REQ-016 | **Multi-Agent Coordination** — Sub-agent spawning, context firewall isolation, parallel execution | Complex workflows with specialized agents | Sub-agents run in isolated contexts; results merged |
| REQ-017 | **Maturity Audit CLI** — Partially implemented: scans a project for harness-one imports and lists used/unused modules; maturity scoring (L0–L4) across the 9-layer checklist is deferred to a future release | Self-assessment and improvement planning | CLI enumerates module coverage today; gap analysis with maturity levels is on the roadmap |
| REQ-018 | **Harness-as-Dataset Export** — Execution trace export for model fine-tuning | Long-term competitive moat via data flywheel | Traces exported in fine-tuning-compatible format |

## 7. Non-Functional Requirements

### Performance
- Context manager operations (assemble, compress) complete in < 50ms for 128K token windows
- Guardrail pipeline adds < 100ms latency per turn (excluding LLM-based guards)
- Memory retrieval returns in < 200ms for stores with 10K+ entries
- Zero-copy streaming: agent loop doesn't buffer full responses

### Security
- No credentials stored in library state; all LLM API keys passed via client injection
- Guardrail pipeline is fail-closed by default — cannot be accidentally misconfigured to fail-open
- Input sanitization helpers provided but not mandated (composable, not prescriptive)
- No `eval()`, no dynamic code execution. No network calls from the core execution primitives; adapter and RAG submodules delegate all I/O to user-injected clients (LLM SDKs, vector stores, retrievers).

### Reliability
- All async operations have configurable timeouts
- Graceful degradation: if observability backend is down, agent still works
- Append-only state enables recovery from any crash point
- All state transitions are serializable for persistence/replay

### Developer Experience
- < 5 minutes from `npm install` to running first agent loop
- Every public API has JSDoc with usage examples
- Error messages follow "pedagogical lint error" pattern: what went wrong + how to fix it
- Tree-shakeable: unused modules don't increase bundle size

### Compatibility
- Node.js 18+ (LTS)
- ESM and CJS dual-publish
- Zero hard runtime dependencies (LLM SDKs, databases, etc. are peer/optional)
- Works in edge runtimes (Cloudflare Workers, Vercel Edge) for core modules

## 8. Success Metrics (SMART)

| Metric | Current (Baseline) | Target | Timeframe |
|--------|--------------------|--------|-----------|
| Time to first working agent | 4-8 weeks (from scratch) | < 1 day with harness-one | 3 months post-launch |
| npm weekly downloads | 0 (new library) | 2,000 | 6 months post-launch |
| GitHub stars | 0 | 1,000 | 6 months post-launch |
| Production deployments (self-reported) | 0 | 20 | 6 months post-launch |
| Avg maturity level of adopters | L0-L1 (industry norm) | L2+ | 6 months post-adoption |
| LLM cost reduction (adopter-reported) | Baseline | 30-50% reduction via context/cache optimization | 3 months post-adoption |
| Contributor count | 1 (core team) | 10+ | 12 months post-launch |

## 9. Technical Considerations

Based on codebase analysis (currently greenfield — no existing source code):

### Architecture Decisions Needed
1. **Schema validation**: TypeBox (lightweight, JSON Schema native) vs Zod (ecosystem popularity) — recommend TypeBox for JSON Schema alignment with tool definitions
2. **Module boundary**: Each of the 9 layers as a separate npm package (monorepo) vs single package with subpath exports — recommend single package with subpath exports for simplicity at this stage
3. **LLM abstraction**: Define a minimal `LLMClient` interface (chat completion + streaming) that users implement for their provider — not a full abstraction layer
4. **State management**: Append-only message array as the canonical state representation, per Manus/Claude Code patterns

### Key Technical Risks
1. **Context compression quality**: LLM-based summarization is provider-dependent; need pluggable strategy with good defaults
2. **KV-cache optimization**: Library can enforce append-only and stable prefixes, but actual cache behavior is provider-specific and opaque
3. **Guardrail latency**: Computational guardrails are fast; LLM-based guardrails (hallucination detection) add significant latency — need async/parallel execution

## 10. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Scope creep into framework territory | High — becomes LangChain competitor instead of composable primitives | Medium | Strict "library not framework" principle; no orchestration opinions |
| Model-specific behavior differences | Medium — patterns optimized for one model fail on another | High | Abstract model-specific concerns behind interfaces; document known model differences |
| Rapid model improvement obsoletes components | Medium — library shrinks faster than expected | Medium | Build-to-Delete is a feature, not a bug; track component retirement conditions |
| Low adoption due to "NIH syndrome" | High — teams prefer to roll their own | Medium | Exceptional DX, incremental adoption path, clear value demonstration |
| Over-engineering before real usage data | High — building what we think users need vs what they actually need | Medium | Ship P0 MVP fast; iterate based on real adoption feedback |

## 11. Out of Scope

| Excluded | Reason |
|----------|--------|
| **LLM provider SDK wrappers** | Users bring their own client (OpenAI SDK, Anthropic SDK, etc.). We define interfaces, not implementations. |
| **UI components** | This is a backend/runtime library. Streaming UX is the user's responsibility. |
| **Specific domain skills** | No built-in coding skills, search skills, etc. The tool system enables them; it doesn't provide them. |
| **Model fine-tuning pipeline** | Harness-as-Dataset (P2) exports data, but the training pipeline is out of scope. |
| **Deployment infrastructure** | No opinions on hosting, scaling, or containerization. |
| **Prompt engineering templates** | The library manages context structure, not prompt content. Users write their own system prompts. |
| **Multi-language support** | TypeScript/Node.js only for v1. Python port is a separate future initiative. |

## 12. Open Questions

1. **Naming**: Is "harness-one" the right package name? Alternatives: `@harness-eng/core`, `agent-harness`, `harness-kit`
2. **Minimum viable guardrails**: Should P0 ship with any built-in guardrail implementations (e.g., basic injection detection), or only the pipeline framework?
3. **Testing strategy**: How do we test context compression quality? Need synthetic benchmarks.
4. **Versioning & breaking changes**: Given "Build to Delete" philosophy, how do we handle semver when removing components?
5. **Reference implementation**: Should we ship a complete example agent (like honeycomb) as a separate package?

---

## Appendix: Maturity Ladder Mapping

How harness-one modules map to the 5-level maturity model:

| Level | What You Get | harness-one Modules |
|-------|-------------|---------------------|
| **L0 → L1** | Basic agent loop + tools | `core` (AgentLoop), `tools` |
| **L1 → L2** | Context engineering + guardrails + memory + observability | `context` (`createBudget`, `packContext`, `compactIfNeeded`), `guardrails` (`createPipeline`), `memory` (`createInMemoryStore` / `createFileSystemStore`), `observe` |
| **L2 → L3** | Evaluation + cost optimization + progressive disclosure | `eval` (`createEvalRunner`), `observe` (cost tracker / budget alerts), `prompt` (progressive disclosure) |
| **L3 → L4** | Evolution + entropy recovery + data flywheel | `evolve`, `eval` (flywheel extraction) |

Each level is independently adoptable. No level requires all modules from the previous level.
