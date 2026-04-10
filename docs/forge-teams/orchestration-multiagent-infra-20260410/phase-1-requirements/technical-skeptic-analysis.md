# Technical Skeptic Challenge Report: Multi-Agent Infrastructure

**Version**: 1.0
**Created**: 2026-04-10
**Author**: technical-skeptic

---

## Summary: 10 Challenges Issued

| # | Challenge | Severity | Capability | Core Issue |
|---|----------|----------|------------|------------|
| TC-001 | AgentLoop has no state introspection | HIGH | agent-pool | Requires core module changes |
| TC-002 | Duplicates orchestrator messaging | HIGH | handoff | API confusion risk |
| TC-003 | JS can't isolate without deps | CRITICAL | isolation | Misleading name, advisory-only |
| TC-004 | Negotiation = framework, not primitive | MEDIUM | contract | Philosophy violation |
| TC-005 | Routing = application logic | MEDIUM | router | Wrong abstraction layer |
| TC-006 | Budget state not serializable | CRITICAL | checkpointManager | Requires budget API breaking changes |
| TC-007 | No structured error data to classify | HIGH | failureTaxonomy | Requires span attribute conventions |
| TC-008 | Cache data depends on LLM provider | MEDIUM | cacheMonitor | Thin wrapper, not infrastructure |
| TC-009 | Module boundaries are wrong | HIGH | all new modules | Should extend orchestration |
| TC-010 | P0 items have hidden dependencies | MEDIUM | prioritization | Serial dependency disguised as parallel |

## Key Recommendations

1. Rename "isolation" to "boundaries" or "namespacing"
2. Retrofit TokenBudget with serialization support before checkpointManager
3. Extend orchestration module rather than creating separate modules
4. Downgrade "contract" to P2 or redefine as "typed channels"
5. Move "router" to examples/recipes
6. Define span attribute conventions before failureTaxonomy
7. Validate cacheMonitor value — may be a utility function, not a module

## Critical Challenges Detail

### TC-003: Isolation (CRITICAL)
JavaScript has no memory isolation without V8 isolates. "Isolation" is misleading — what's achievable is advisory namespacing/ACL on SharedContext. Must rename to set correct expectations.

### TC-006: Checkpoint Manager (CRITICAL)
TokenBudget stores state in closures with no serialization API. Segment names are not enumerable, `getState()`/`snapshot()` don't exist. Prerequisite: retrofit TokenBudget with serialization support (breaking change to budget.ts).

### TC-001: Agent Pool (HIGH)
AgentLoop has no public status getter, no restart semantics, no generator draining. Pool becomes a thin Map wrapper without core module changes.

### TC-002: Handoff (HIGH)
Orchestrator already has send/broadcast/getMessages with bounded queues. Handoff creates parallel competing API. Should extend orchestrator instead.

### TC-009: Module Boundaries (HIGH)
agent-pool, handoff, isolation all need orchestrator state. They're sub-features of orchestration, not independent modules.
