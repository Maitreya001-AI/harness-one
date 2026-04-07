# Product Advocate Analysis: harness-one

**Version**: 1.0 | **Date**: 2026-04-07 | **Status**: Ready for Adversarial Review

---

## 1. Target Users & Pain Points

### Primary Users

**A. AI Agent Product Teams (70% of TAM)**
- Teams building production AI agents (coding assistants, customer support bots, data analysis agents)
- Pain point: Every team reinvents the same infrastructure from scratch.

**B. AI Platform Engineers (20% of TAM)**
- Engineers building internal AI platforms for their organizations

**C. AI Framework Authors & Researchers (10% of TAM)**
- Need composable, well-typed building blocks they can extend

### Core Pain Points (ranked)
1. No structured approach to context engineering — 10x cost difference from cache optimization
2. Guardrails are afterthoughts — bolted on late, causing production incidents
3. No eval-driven development loop — regressions from untested agent changes
4. Observability is logging, not tracing
5. Every Harness component eventually becomes tech debt

---

## 2. Value Proposition

**harness-one is the missing OS layer between your LLM API calls and your production AI agent.**

### Unique Differentiators
- Context Engineering: first-class (no competitor does this)
- KV-cache optimization: core primitive
- Safety guardrails: full pipeline with self-heal
- Build-to-Delete lifecycle: core philosophy
- Framework binding: Agnostic

---

## 3. Feature Priorities

### P0 (MVP): Layers 1-4
- Agent Loop, Context Engineering, Tool System, Safety & Guardrails

### P1: Layers 5, 7
- Memory & Persistence, Observability

### P2: Layers 6, 8, 9
- Evaluation, Continuous Evolution, Entropy Recovery

---

## 4. API Design: Composable Middleware Pipeline

```typescript
const pipeline = createPipeline()
  .use(inputGuardrails({ injection: true, pii: true }))
  .use(contextAssembler({ budget: 128_000, layout: 'head-mid-tail' }))
  .use(llmCall({ model: 'claude-opus-4-6' }))
  .use(outputGuardrails({ schema: responseSchema, selfHeal: { maxRetries: 2 } }))
```

### Package Structure
```
@harness-one/core        — Agent Loop + base types
@harness-one/context     — Context Engineering
@harness-one/tools       — Tool System
@harness-one/guardrails  — Safety & Guardrails
@harness-one/memory      — Memory & Persistence
@harness-one/eval        — Evaluation & Validation
@harness-one/observe     — Observability
@harness-one/evolve      — Continuous Evolution + Entropy Recovery
```

---

## 5. Quick Wins
1. Week 1-2: @harness-one/context standalone + @harness-one/tools standalone
2. Week 3-4: @harness-one/core + @harness-one/guardrails (full pipeline)
3. Week 5+: Integration guides + `npx harness-one audit` CLI

---

## 6. Risks
- "Too abstract" syndrome → Ship with 3+ real-world examples
- Rapid model evolution → Embrace Build-to-Delete
- LangChain lock-in → Provide adapters
- TypeScript-only → Right starting language; Python port later

**Confidence: 8/10**
