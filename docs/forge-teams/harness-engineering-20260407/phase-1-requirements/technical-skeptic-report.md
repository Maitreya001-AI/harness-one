# Technical Challenge Report: Universal Harness Engineering Library

## Overall Risk Assessment
**Risk Level**: High | **Feasibility**: Feasible with Significant Scope Reduction

---

## Critical Challenges

### TC-001: Agent Loop Is NOT Generic (Critical)
The 8-step pipeline in agent-runtime.ts is deeply coupled to honeycomb's workflow:
- Step 2: 8 hardcoded parallel data fetchers (getBrief, recall, getCanvasContent, etc.)
- Step 6.5: Entire Skill State Machine specific to honeycomb
- Step 6: Inngest event firing for async memory ingest
- Generic pipeline is likely just: guardrails → context → LLM → guardrails → side-effects

### TC-002: Context Engineering Is the Deepest Rabbit Hole (Critical)
- budget.ts: Token allocations hardcoded to 6 honeycomb content types
- query-classifier.ts: Chinese-language regex patterns
- mindmap-serializer.ts: Entirely project-specific
- memory-bridge.ts: Facade over specific library API

### TC-003: Guardrails Need Plugin Model (High)
- injection-detect.ts: 20+ regex with Chinese-specific variants
- pipeline.ts: Hardcoded constructor calls, no plugin system
- hallucination-check.ts: RAG-specific pattern

### TC-004: Tool System Locked to pi-agent-core (High)
- tool-registry.ts: Imports pi-agent-core types throughout
- agent-adapter.ts: Wraps entire pi-agent-core lifecycle
- TypeBox runtime validation tightly coupled

### TC-005: Memory Layer Is an Entire Product (High)
- 9 environment variables for memory alone
- agent-memory workspace package with embedding + LLM
- writer.ts: 3-level writing depends on Inngest

### TC-006-009: Medium/Low severity issues with Observability, Skill Engine, Eval, Entropy Recovery

---

## Recommended Minimum Viable Architecture

### Tier 1 — Ship as Code:
1. Agent Loop skeleton (5-step, not 8-step)
2. Guardrail Pipeline interface + plugin system + reference implementations
3. TraceManager interface + NoOp + OpenTelemetry adapter
4. Tool Registry with framework-agnostic ToolDefinition (JSON Schema, not TypeBox)
5. Session Manager (LRU + TTL + prompt locking)

### Tier 2 — Ship as Primitives:
6. Token budget allocator (generic)
7. Context window packer (position-aware)
8. Cost tracker (user-configurable pricing)

### Tier 3 — Ship as Documentation Only:
9-13. Memory patterns, Skill state machine, Eval guidance, Entropy checklists, Evolution playbook

**"The 9-layer architecture is a great mental model. But a mental model is not a library."**
