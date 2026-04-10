# Architecture Evaluation Report

## Scores

| Criterion | Weight | Proposal A | Proposal B | A (Weighted) | B (Weighted) |
|-----------|--------|-----------|-----------|-------------|-------------|
| Feasibility | 25% | 8 | 5 | 2.00 | 1.25 |
| Maintainability | 25% | 7 | 6 | 1.75 | 1.50 |
| Performance | 20% | 8 | 6 | 1.60 | 1.20 |
| Safety | 15% | 7 | 8 | 1.05 | 1.20 |
| Tech Debt Risk | 15% | 8 | 5 | 1.20 | 0.75 |
| **TOTAL** | **100%** | | | **7.60** | **5.90** |

## Recommendation: Proposal A as baseline + 2 surgical adoptions from B

### Adopt from B
1. Violation tracking on ContextBoundary (getViolations())
2. Separate read/write policies (already in PRD's BoundaryPolicy)

### Reject from B
1. Branded types — viral, no runtime benefit, removal is breaking change
2. Shared Disposable + Subscribable — coupling tax across all primitives
3. Generic HandoffPayload<TMeta> — over-engineered for metadata use case
4. Async CheckpointStorage — Promise overhead for 95% in-memory case
5. FailureDetectionContext with AgentEvent[] — contradicts streaming design
6. Linear regression in CacheMonitor — should be opt-in

### Key Questions for Implementation
1. Pool drain: wait for active agents or abort?
2. Checkpoint copy: structuredClone vs shallow copy?
3. Handoff + orchestrator lifecycle coupling?
4. Cache monitor reset vs dispose distinction?
