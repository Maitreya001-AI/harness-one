# Pipeline Summary: Multi-Agent Infrastructure for harness-one

**Feature**: orchestration-multiagent-infra
**Date**: 2026-04-10
**Status**: PASS
**Team Size**: medium

---

## What Was Built

harness-one evolved from single-agent primitives to multi-agent infrastructure. 7 capabilities implemented across 3 modules:

### Orchestration Module (3 new factories)
| Factory | Purpose | LOC |
|---------|---------|-----|
| `createAgentPool()` | AgentLoop lifecycle: acquire/release, idle timeout, maxAge recycling, drain | ~180 |
| `createHandoff()` | Structured inter-agent messaging with JSON prefix, verify, receipt/inbox caps | ~120 |
| `createContextBoundary()` | Advisory ACL on SharedContext, prefix matching, fail-closed writes, violation tracking | ~135 |

### Context Module (1 new factory)
| Factory | Purpose | LOC |
|---------|---------|-----|
| `createCheckpointManager()` | Message array snapshots, sync pluggable storage, auto-prune | ~150 |

### Observe Module (2 new factories)
| Factory | Purpose | LOC |
|---------|---------|-----|
| `createFailureTaxonomy()` | 5 built-in heuristic detectors, pluggable custom detectors | ~250 |
| `createCacheMonitor()` | KV-cache hit rate aggregation, time-series, savings estimation | ~130 |

### Core Module (1 enhancement)
| Change | Purpose |
|--------|---------|
| `AgentLoop.status` getter | Lifecycle status: idle → running → completed/disposed |

---

## Phase Results

| Phase | Status | Key Outcome |
|-------|--------|-------------|
| P1 Requirements Debate | PASS | 2-round debate, 7 capabilities (contract merged into handoff), isolation renamed to boundary |
| P2 Architecture Bakeoff | PASS | Proposal A wins 7.60 vs 5.90. Flat primitives, sync-first, no shared abstractions |
| P3 Planning + Risk | PASS | 9 tasks in 4 waves, 16 risks assessed (3 HIGH mitigated) |
| P4 Parallel Implementation | PASS | 4 parallel implementers, ~65 new tests, 1761 tests total, 0 failures |
| P5 Red Team Review | BLOCKERS | 1 CRITICAL + 3 HIGH + 4 MEDIUM + 1 LOW found |
| P6 Adversarial Debug | PASS | 6 blockers + 3 non-blockers fixed with TDD, 1770 tests, 0 regressions |
| P7 Cross Acceptance | PASS | 46/46 requirement checks passed, architecture docs updated |

---

## Key Architecture Decisions

| ADR | Decision |
|-----|----------|
| Self-contained primitives | No shared abstractions (Disposable/Subscribable rejected) |
| Sync-first | Pool acquire, checkpoint storage are sync |
| JSON prefix serialization | Handoff uses `__handoff__:` prefix, no AgentMessage type change |
| Trace-based detection | Failure taxonomy uses Trace objects, not AgentEvent[] |
| Prefix matching | Context boundary uses `startsWith()`, no glob/regex |
| Running aggregates → recompute | Cache monitor recomputes from raw data (fixed float drift) |
| Default-deny for unknown agents | Context boundary always returns scoped view |
| Drain with timeout | Agent pool drain defaults to 30s timeout |

---

## Blocker Fixes (P6)

| # | Blocker | Fix |
|---|---------|-----|
| 1 | Context boundary bypass | Always return scoped view, dynamic policy lookup |
| 2 | drain() infinite loop | Added timeoutMs parameter (default 30s) |
| 3 | Handoff unbounded memory | Receipt cap 10K, inbox cap 1K per agent |
| 4 | Module-level counters | Moved inside factory closures |
| 5 | Stale cached policy | Dynamic policy lookup on every get/set call |
| 6 | maxAge not implemented | isExpired() check in acquire() and release() |

---

## Test Coverage

- **New tests**: ~75 (across 7 test files)
- **Full suite**: 1770 tests, 0 failures
- **TypeScript**: clean compilation

---

## Files Changed

### New Files (6 implementations + 7 tests)
```
packages/core/src/orchestration/agent-pool.ts
packages/core/src/orchestration/handoff.ts
packages/core/src/orchestration/context-boundary.ts
packages/core/src/context/checkpoint.ts
packages/core/src/observe/failure-taxonomy.ts
packages/core/src/observe/cache-monitor.ts
packages/core/src/core/__tests__/agent-loop-status.test.ts
packages/core/src/orchestration/__tests__/agent-pool.test.ts
packages/core/src/orchestration/__tests__/handoff.test.ts
packages/core/src/orchestration/__tests__/context-boundary.test.ts
packages/core/src/context/__tests__/checkpoint.test.ts
packages/core/src/observe/__tests__/failure-taxonomy.test.ts
packages/core/src/observe/__tests__/cache-monitor.test.ts
```

### Modified Files
```
packages/core/src/core/agent-loop.ts        (status getter)
packages/core/src/core/types.ts             (AgentLoopStatus)
packages/core/src/orchestration/types.ts    (Pool/Handoff/Boundary types)
packages/core/src/context/types.ts          (Checkpoint types)
packages/core/src/observe/types.ts          (Taxonomy/CacheMonitor types)
packages/core/src/orchestration/index.ts    (re-exports)
packages/core/src/context/index.ts          (re-exports)
packages/core/src/observe/index.ts          (re-exports)
```

### Architecture Docs Updated
```
docs/architecture/00-overview.md
docs/architecture/03-context.md
docs/architecture/06-observe.md
docs/architecture/12-orchestration-multi-agent.md (NEW)
```

---

## Artifacts

| Artifact | Path |
|----------|------|
| PRD | `docs/forge-teams/orchestration-multiagent-infra-20260410/phase-1-requirements/prd.md` |
| ADR | `docs/forge-teams/orchestration-multiagent-infra-20260410/phase-2-architecture/adr.md` |
| Plan | `docs/forge-teams/orchestration-multiagent-infra-20260410/phase-3-planning/plan.json` |
| Red Team Report | `docs/forge-teams/orchestration-multiagent-infra-20260410/phase-5-red-team/arbitration.md` |
| Fix Report | `docs/forge-teams/orchestration-multiagent-infra-20260410/phase-6-debugging/fixes.md` |
| Acceptance | `docs/forge-teams/orchestration-multiagent-infra-20260410/phase-7-delivery/acceptance.md` |
| Summary | `docs/forge-teams/orchestration-multiagent-infra-20260410/summary.md` |
