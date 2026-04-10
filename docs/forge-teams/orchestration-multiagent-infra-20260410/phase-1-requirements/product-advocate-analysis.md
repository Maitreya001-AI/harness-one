# Product Advocate Analysis: Multi-Agent Infrastructure for harness-one

**Version**: 1.0
**Created**: 2026-04-10
**Author**: product-advocate

---

## Key Positions

### Capabilities Assessment

| # | Capability | Original Priority | Recommended Priority | Verdict |
|---|-----------|-------------------|---------------------|---------|
| 1 | Agent Pool | P0 | P0 | Agree — foundational lifecycle management |
| 2 | Handoff | P0 | P0 | Agree — structured inter-agent communication |
| 3 | Isolation | P1 | **P0** | Upgrade — safety prerequisite for multi-trust deployments |
| 4 | Contract | P1 | **MERGE into #2** | Standalone protocol is over-engineered |
| 5 | Router | P1 | P1 | Agree — useful but not blocking |
| 6 | Checkpoint | P0 | P0 | Strongly agree — #1 production failure mode solution |
| 7 | Failure Taxonomy | P0 | P0 | Agree — essential for debugging |
| 8 | Cache Monitor | P1 | P1 | Agree — nice to have |

### Key Arguments

1. **7 capabilities, not 8**: Contract should be merged into Handoff via `acceptanceCriteria` field
2. **Isolation is P0**: Without it, pool+handoff are unsafe for multi-trust-level deployments
3. **Checkpoint is highest single value**: Solves #1 production failure (context cliff-edge)
4. **All APIs follow existing patterns**: Factory functions, frozen returns, zero deps

### Proposed Merge: Contract → Handoff

```ts
interface HandoffPayload {
  readonly summary: string;
  readonly artifacts?: readonly Artifact[];
  readonly concerns?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];  // ← absorbs contract
  readonly context?: Record<string, unknown>;
}
```

### Implementation Order

1. Checkpoint Manager (context module, no deps)
2. Failure Taxonomy (observe module, no deps)
3. Agent Pool (orchestration, no deps)
4. Isolation (orchestration, wraps SharedContext)
5. Handoff (orchestration, benefits from pool + isolation)
6. Router (orchestration, benefits from pool)
7. Cache Monitor (observe, lower priority)

### Missing Capability Identified

Agent Lifecycle Events/Hooks — extend `OrchestratorEvent` types rather than a new capability.

### API Surface Sketches

(See full analysis for detailed API sketches per capability)

### Risk Summary

- Highest API risk: HandoffPayload schema rigidity vs flexibility
- Highest memory risk: Checkpoint storage at scale
- Lowest risk: Cache Monitor, Failure Taxonomy (read-only analysis)
