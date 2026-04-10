# P5 Arbitration: Red Team + Code Review Synthesis

## Combined Findings (deduplicated)

| # | Finding | Red Team | Code Review | Severity | Verdict |
|---|---------|----------|-------------|----------|---------|
| 1 | Context boundary bypass (unregistered agent → raw context) | #1 CRITICAL | — | **BLOCKER** | Must fix |
| 2 | drain() infinite loop (no timeout) | #2 HIGH | CQ-002 MAJOR | **BLOCKER** | Must fix |
| 3 | Handoff unbounded memory (receipts/inbox) | #3 HIGH | — | **BLOCKER** | Must fix |
| 4 | Module-level counters shared across instances | #8 MEDIUM | CQ-001 MAJOR | **BLOCKER** | Must fix |
| 5 | Stale cached policy bypass (held references) | #5 MEDIUM | — | **BLOCKER** | Must fix |
| 6 | maxAge declared but not implemented | — | CQ-003 MAJOR | **BLOCKER** | Must fix |
| 7 | Cache monitor float drift | #4 HIGH | CQ-006 MINOR | Non-blocker | Fix recommended |
| 8 | Checkpoint shallow copy corruption | #6 MEDIUM | CQ-005 MINOR | Non-blocker | Document limitation |
| 9 | Type safety on custom detector modes | #7 MEDIUM | CQ-004 MAJOR | Non-blocker | Fix recommended |
| 10 | PooledAgent not frozen | — | CQ-009 MINOR | Non-blocker | Fix recommended |
| 11 | Violation log O(n) shift | #9 LOW | — | Non-blocker | Fix recommended |
| 12 | Missing test coverage (resize, serialization error) | — | CQ-010/011/012 | Non-blocker | Add tests |

## BLOCKERS (6 items → Phase 6)

1. **Context boundary bypass** — forAgent() must NEVER return raw context. Fix: always return scoped view, even for unknown agents. Unknown agents get empty-access view (default-deny for writes, full-read for backward compat).
2. **drain() timeout** — Add timeoutMs parameter (default 30s), force-dispose after timeout.
3. **Handoff memory caps** — Add MAX_RECEIPTS (10,000) and MAX_INBOX_PER_AGENT (1,000) with FIFO eviction.
4. **Module-level counters** — Move inside factory closures.
5. **Stale policy bypass** — Scoped views must look up current policy dynamically, not close over captured policy.
6. **maxAge implementation** — Implement force-recycling in release() when agent exceeds maxAge.

## NON-BLOCKERS (6 items → fix recommended, not blocking P7)

7-12: Fix after P6 blockers are resolved, or in follow-up.

## P5 Result: **HAS BLOCKERS → Proceed to P6**
