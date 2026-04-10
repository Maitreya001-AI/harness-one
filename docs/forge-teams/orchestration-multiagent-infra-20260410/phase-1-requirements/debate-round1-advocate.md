# Debate Round 1: Product Advocate Rebuttals

## Response Summary

| Challenge | Response | Key Argument |
|-----------|----------|-------------|
| TC-003 (Isolation) | PARTIAL ACCEPT | Rename to createContextBoundary, but keep value — solves accidental data leakage |
| TC-006 (Checkpoint) | REBUT | Checkpoint snapshots messages (plain data), not budget state. Budget is re-derived. No API retrofit needed. |
| TC-001 (Agent Pool) | PARTIAL ACCEPT | Pool tracks state externally via acquire/release, doesn't need AgentLoop status getter |
| TC-002 (Handoff) | REBUT | Handoff is protocol layer on top of orchestrator transport. Not competing — layered. |
| TC-009 (Module Boundaries) | PARTIAL ACCEPT | All new files inside orchestration/, single index.ts entry point |
| TC-007 (Failure Taxonomy) | PARTIAL ACCEPT | Phase 1: 5 structural detectors. Phase 2: attribute-dependent detectors |
| TC-004 (Contract) | ACCEPT | Already merged into handoff |
| TC-005 (Router) | PARTIAL ACCEPT | Downgrade to P2 |
| TC-008 (Cache Monitor) | PARTIAL ACCEPT | Keep as P1, thin but convention value |
| TC-010 (Dependencies) | REBUT | Each capability independently usable, not serial |

## PRD Changes After Round 1
1. Rename createIsolation → createContextBoundary
2. Add "logical ACL, not security sandbox" disclaimer
3. Checkpoint docs: snapshots messages, not budget state
4. Pool tracks state externally, not via AgentLoop query
5. Handoff layers on orchestrator, single import path
6. All new files inside orchestration/ module
7. Failure taxonomy Phase 1: 5 structural detectors only
8. Contract DROPPED (merged into handoff)
9. Router P1 → P2
