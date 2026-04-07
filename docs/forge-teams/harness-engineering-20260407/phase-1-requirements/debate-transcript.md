# Phase 1: Requirements Debate Transcript

## Participants
- **Product Advocate** (PA): User value, feasibility, rapid delivery
- **Technical Skeptic** (TS): Risk, complexity, technical debt
- **Lead Arbitrator**: Synthesis and final judgment

---

## Round 0: Initial Positions

### PA Initial Analysis
- 9-layer architecture as library, 8-package monorepo
- Middleware pipeline API (`createPipeline().use(...)`)
- MVP = Layers 1-4, ship context engineering first as unique wedge
- Growth hack: `npx harness-one audit` CLI
- Confidence: 8/10

### TS Initial Analysis (9 Challenges)
- TC-001 (Critical): Agent Loop is honeycomb-shaped, not generic
- TC-002 (Critical): Context Engineering is deepest rabbit hole
- TC-003 (High): Guardrails need plugin model
- TC-004 (High): Tool system locked to pi-agent-core
- TC-005 (High): Memory layer is an entire product
- TC-006-009 (Medium/Low): Observability, Skills, Eval, Entropy
- Recommendation: 30% extractable, ship as primitives not pipeline
- Feasibility: High risk, proceed with significant scope reduction

---

## Round 1: Cross-Examination

### PA Responses to TS Challenges

**TC-001 (Agent Loop)**: PARTIALLY ACCEPTED
- Conceded: 8-step pipeline is app-specific. Dropped middleware pipeline pattern.
- Maintained: Generic kernel is real — typed AsyncGenerator with safety valves (~200 lines)
- Revised API: `AgentLoop<TState>` interface with `IterationHandler`, not pipeline builder

**TC-002 (Context Engineering)**: PARTIALLY ACCEPTED — pivoted to primitives
- Conceded: Budget tables, query classifiers, serializers are domain-specific
- Maintained: 5 primitives ARE the product (token counting, budget allocation, context packing, compression strategies, cache stability analysis)
- Key argument: "No competitor ships cache stability analysis"

**TC-005 (Memory)**: ACCEPTED — defer and redefine
- Moved Memory from P1 to P2
- Redefine as interface + patterns document + filesystem reference impl
- Only novel primitive: value-graded writes (critical/useful/ephemeral)

**Meta-challenge ("30% extractable")**: ACCEPTED as a feature
- Reframe: "The hard 30% you shouldn't have to build"
- Revised scope: ~3,800 lines across 4 packages

### TS Challenges to PA Proposals

**Claim 1 ("Context Engineering unique wedge")**: CHALLENGED
- LangChain has ConversationBufferMemory, SummaryMemory for 2+ years
- Vercel AI SDK has built-in message management and token counting
- The value proposition may collapse to `sections.join('\n\n')`
- Counter-proposal: Ship as two small utilities, not a layer/package

**Claim 2 (Middleware Pipeline)**: CRITICALLY CHALLENGED
- Agent loops are cyclical, middleware is linear
- Self-healing retry creates nested loops within the pipeline
- Tool execution creates inner loops inside the LLM call step
- Counter-proposal: Don't abstract the LLM call; define AgentAdapter interface

**Claim 3 (8 packages)**: CHALLENGED
- Honeycomb is monolith for good reasons (18 cross-cutting imports)
- Cross-package type sharing creates version lock
- Counter-proposal: Single package with subpath exports, split after v1.0

**Claim 4 (Audit CLI)**: CHALLENGED
- Checklist is subjective; auto-detection limited to existence not quality
- Counter-proposal: Replace with `npx harness-one init` scaffolding tool

---

## Lead Arbitrator: Convergence Analysis

### Areas of Strong Convergence (both sides agree)
1. ✅ The 9-layer architecture is a mental model, not all library code
2. ✅ Primitives over opinionated pipelines
3. ✅ Memory should be deferred (P2+)
4. ✅ Agent loop should be minimal (~200-500 lines)
5. ✅ Don't abstract the LLM call — users bring their own
6. ✅ Middleware pattern is wrong — need loop-aware architecture
7. ✅ ~30% of harness patterns are extractable as library code
8. ✅ Framework-agnostic is correct positioning

### Areas of Remaining Divergence
1. ⚠️ Is Context Engineering a standalone package or two utilities?
   - PA: 5 primitives justify a package (~1,500 lines)
   - TS: May collapse to trivial helpers; LangChain already covers basics
   → **Arbitration**: PA's 5 primitives (token counting, budget, packing, compression, cache analysis) ARE more than LangChain offers. LangChain's memory types manage conversation history, not token budgets or position-aware packing. Cache stability analysis is genuinely novel. VERDICT: Ship as a package, but scope to primitives only.

2. ⚠️ Single package vs multi-package?
   - PA: 4 packages for MVP (core, context, tools, guardrails)
   - TS: Single package with subpath exports
   → **Arbitration**: TS is right about premature splitting risks. Ship as single package `harness-one` with subpath exports. Split after API stabilizes at v1.0. VERDICT: Single package.

3. ⚠️ Audit CLI vs Init scaffolding?
   - PA: Audit as growth hack
   - TS: Audit is subjective; scaffolding is more useful
   → **Arbitration**: TS wins. An init/scaffolding tool provides immediate value. Audit can come later with objective criteria. VERDICT: Init tool, defer audit.

4. ⚠️ Schema validation: TypeBox vs Zod vs JSON Schema?
   - Not debated deeply. Need to decide.
   → **Arbitration**: Support both via adapter pattern. Use JSON Schema as the interchange format internally. Provide TypeBox and Zod helpers. VERDICT: JSON Schema core, TypeBox/Zod adapters.

---

## Final Consensus Points (13 items)

1. **Scope**: Universal primitives toolkit (~3,800 lines), not a framework
2. **Positioning**: "The hard 30% of harness engineering, done once and done right"
3. **Architecture**: Composable primitives, not opinionated pipeline
4. **Agent Loop**: Typed AsyncGenerator with safety valves, user provides iteration logic
5. **Context Engineering**: 5 primitives (token count, budget, pack, compress, cache analysis)
6. **Tool System**: Declarative definitions with JSON Schema core, structured error types
7. **Guardrails**: Pipeline interface with plugin system, reference implementations
8. **LLM Abstraction**: None. Users bring their own LLM client. Library defines AgentAdapter interface.
9. **Memory**: Deferred to P2. Interface + filesystem reference impl only.
10. **Observability**: TraceManager interface + NoOp impl. P1 priority.
11. **Package Structure**: Single package `harness-one` with subpath exports
12. **CLI Tool**: `npx harness-one init` scaffolding, not audit
13. **Eval/Evolution/Entropy**: Documentation and patterns, not library code (for now)
