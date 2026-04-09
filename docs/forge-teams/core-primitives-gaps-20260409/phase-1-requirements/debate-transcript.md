# P1 Debate Transcript — Core Primitives Gaps

## Participants
- **Product Advocate**: User value, feasibility, delivery perspective
- **Technical Skeptic**: Risk, edge cases, hidden complexity perspective  
- **Lead (Arbitrator)**: Final synthesis

## Pre-Debate Discovery
- **Gap #1 (Streaming AgentLoop)** was found to be already implemented (`agent-loop.ts:165-175`, `streaming` config + `handleStream()`). Removed from scope.

## Round 0: Initial Positions

| Gap | Advocate | Skeptic |
|-----|----------|---------|
| Gap 1 (Sub-Agent) | P1 — utility function | DEFER — orchestrator covers 80% |
| Gap 2 (Auto-Compaction) | P0 — ship in v1 | KILL — module boundary violation |
| Gap 3 (Parallel Tools) | P0 — ship in v1 | DEFER — premature optimization |
| Gap 4 (MCP) | P2 — post-v1 | BUILD P2 — only one worth building |

## Round 1: Challenge & Response

### Gap 2 (Auto-Compaction) — KILLED
- Skeptic issued TC-006 (crosses 4 module boundaries), TC-009 (5-line userland pattern), TC-010 (precedent erosion)
- Advocate **accepted all 3 challenges**: module isolation is an architectural invariant, not a constraint to override for convenience
- **Consensus**: Documentation recipe only. No core primitive.

### Gap 1 (Sub-Agent) — WITHDRAWN FROM CORE  
- Skeptic issued TC-001 (orchestrator exists), TC-002 (ContextRelay exists)
- Advocate verified both modules, **accepted**: the gap is ergonomics, not capability
- **Consensus**: Documentation recipe + optional `harness-one-full` convenience

### Gap 3 (Parallel Tools) — BUILD WITH CONDITIONS
- Skeptic conceded performance argument for I/O-bound tools
- Skeptic issued TC-011 (rate limiter TOCTOU) — Advocate **accepted**, proposed pre-claim fix
- Skeptic issued TC-012 (per-tool parallelSafe flag) — Advocate **disputed** (LLM's responsibility)
- Skeptic issued TC-014 (no benchmarks) — Advocate **mitigated** (downgraded P0 → P1)
- **Lead arbitration on TC-012**: Hybrid — loop-level `parallel: true` + per-tool `sequential: true` opt-out
- **Consensus**: BUILD P1 with rate limiter fix, opt-in, event batching, concurrency cap

### Gap 4 (MCP) — BUILD P2
- No disagreement on approach or priority
- Both agree: `@harness-one/mcp`, tools-only v0.1, separate package
- Skeptic added: dot-notation namespace strategy (`server.toolName`)
- **Consensus**: BUILD P2

## Key Insight from Debate
> "The architecture IS the product. Module isolation isn't a constraint to work around — it's the core value proposition."

Both analysts independently converged on this principle after the advocate's initial proposals would have violated it.

## Debate Statistics
- Challenges issued by skeptic: 18
- Challenges accepted by advocate: 5/7 critical
- Challenges disputed by advocate: 1/7
- Challenges mitigated by advocate: 1/7
- Positions changed: Advocate moved 3 of 4 positions; Skeptic moved 2 of 4 positions
- Rounds needed: 1 (strong convergence)
