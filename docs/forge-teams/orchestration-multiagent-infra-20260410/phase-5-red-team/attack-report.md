# Red Team Attack Report

**Findings**: 1 CRITICAL, 3 HIGH, 4 MEDIUM, 1 LOW

## CRITICAL
1. **Context boundary bypass** — unregistered agents get raw SharedContext (context-boundary.ts:113)

## HIGH
2. **drain() infinite loop** — no timeout, hangs forever on orphaned agents (agent-pool.ts:169)
3. **Handoff unbounded memory** — receipts/inbox never pruned (handoff.ts:31)
4. **Cache monitor float drift** — running aggregate subtraction causes drift (cache-monitor.ts:46)

## MEDIUM
5. Stale cached policy bypass — held references use old policy (context-boundary.ts:114)
6. Checkpoint shallow copy corruption — mutate after save corrupts checkpoint (checkpoint.ts:88)
7. Type safety lie on custom detector modes (failure-taxonomy.ts:163)
8. Module-level shared counters (agent-pool.ts:17, checkpoint.ts:51)

## LOW
9. Violation log O(n) shift (context-boundary.ts:44)
