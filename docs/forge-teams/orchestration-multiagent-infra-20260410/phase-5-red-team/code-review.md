# Code Quality Review Report

**Score**: 7.5/10 | **Findings**: 4 MAJOR, 5 MINOR, 3 SUGGESTION

## MAJOR Findings (must fix)

| ID | Issue | File | Impact |
|----|-------|------|--------|
| CQ-001 | Module-level counters leak across instances | agent-pool.ts:17, checkpoint.ts:51 | Non-deterministic IDs |
| CQ-002 | drain() has no timeout — can busy-wait forever | agent-pool.ts:169-185 | Liveness hazard |
| CQ-003 | maxAge config declared but never implemented | types.ts:99, agent-pool.ts | Dead API surface |
| CQ-004 | Unsafe type cast on failure mode key | failure-taxonomy.ts:163 | Runtime string vs FailureMode union mismatch |

## MINOR Findings

| ID | Issue | File |
|----|-------|------|
| CQ-005 | Checkpoint messages shallow-copied not deep-frozen | checkpoint.ts:88 |
| CQ-006 | Cache monitor FP aggregate drift on eviction | cache-monitor.ts:46-54 |
| CQ-007 | Handoff nextId resets on dispose | handoff.ts:127 |
| CQ-008 | Boundary view cache edge case with new agents | context-boundary.ts:115-119 |
| CQ-009 | PooledAgent not frozen (inconsistent with HandoffReceipt) | agent-pool.ts:45-49 |

## Test Gaps (SUGGESTION)

| ID | Missing Test |
|----|-------------|
| CQ-010 | resize() not tested in agent-pool |
| CQ-011 | Serialization error not tested in handoff |
| CQ-012 | Cached view identity not tested in context-boundary |

## Recommendation: Ship with fixes for CQ-001, CQ-002, CQ-003
