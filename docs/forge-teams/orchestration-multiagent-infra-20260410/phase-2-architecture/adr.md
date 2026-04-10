# ADR: Multi-Agent Infrastructure Architecture

**Status**: Approved
**Date**: 2026-04-10
**Deciders**: Lead Arbitrator (based on bakeoff between Architect A and Architect B, evaluated by Review Panel)
**Score**: Proposal A 7.60/10, Proposal B 5.90/10 → **Proposal A as baseline with targeted B adoptions**

---

## Decision Summary

Adopt Proposal A's "Flat Primitives" architecture as the foundation for all 7 capabilities. Each capability is a self-contained factory function file within its respective existing module. No shared abstractions, no branded types, no generic type parameters on public APIs. Two targeted improvements adopted from Proposal B: violation tracking on ContextBoundary and separate read/write policy semantics.

---

## Architecture Overview

### File Structure

```
packages/core/src/
├── core/
│   ├── agent-loop.ts          # MODIFIED: add status getter (~15 LOC)
│   ├── types.ts               # MODIFIED: add AgentLoopStatus type
│   └── ...                    # unchanged
├── orchestration/
│   ├── orchestrator.ts        # unchanged
│   ├── spawn.ts               # unchanged
│   ├── strategies.ts          # unchanged
│   ├── agent-pool.ts          # NEW (~200 LOC)
│   ├── handoff.ts             # NEW (~180 LOC)
│   ├── context-boundary.ts    # NEW (~150 LOC)
│   ├── types.ts               # MODIFIED: add new type exports
│   └── index.ts               # MODIFIED: add re-exports
├── context/
│   ├── budget.ts              # unchanged
│   ├── compress.ts            # unchanged
│   ├── checkpoint.ts          # NEW (~160 LOC)
│   ├── types.ts               # MODIFIED: add new type exports
│   └── index.ts               # MODIFIED: add re-exports
└── observe/
    ├── trace-manager.ts       # unchanged
    ├── cost-tracker.ts        # unchanged
    ├── failure-taxonomy.ts    # NEW (~250 LOC)
    ├── cache-monitor.ts       # NEW (~130 LOC)
    ├── types.ts               # MODIFIED: add new type exports
    └── index.ts               # MODIFIED: add re-exports
```

**Total new code**: ~1,070 LOC implementation + ~500 LOC tests = ~1,570 LOC
**Modified existing code**: ~40 LOC (agent-loop status + re-exports)

### Design Principles

1. **Self-contained factory files** — each capability is one file, one factory function, no shared abstractions
2. **Sync by default** — pool acquire is sync, checkpoint storage is sync, cache monitor is sync
3. **Frozen at boundaries, mutable internally** — return `Object.freeze()`, use `Map`/arrays internally
4. **Progressive adoption** — no capability requires another, no policy = full access
5. **Errors as data** — verify() returns results, classify() returns confidence scores
6. **Consistent with existing patterns** — matches createBudget, createCostTracker, createTraceManager

---

## ADR-01: Self-Contained Primitives (No Shared Abstractions)

**Context**: Proposal B introduced `Disposable`, `Subscribable<TEvent>`, and branded types as shared protocols. The Review Panel scored this approach lower on feasibility (5 vs 8), maintainability (6 vs 7), and tech debt risk (5 vs 8).

**Decision**: No shared abstractions. Each factory function defines its own dispose(), types, and behavior independently.

**Rationale**:
- The codebase has 3 existing event patterns (`onEvent`, `onAlert`, `bus.on`) that coexist fine
- Shared abstractions create coordination coupling — changing `Disposable` breaks all consumers
- Branded types are viral (infect all call sites) with zero runtime benefit
- harness-one's "independently usable modules" principle is better served by independent primitives

**Consequences**: Each primitive may evolve its event/dispose patterns independently. This is acceptable — consistency across 7 new primitives within this release is ensured by the same team building them all.

---

## ADR-02: Sync Pool Acquire

**Context**: `AgentLoop` constructor is synchronous. Pool acquire is a `Map.get()` + status flip.

**Decision**: `acquire()` returns `PooledAgent` synchronously, not `Promise<PooledAgent>`.

**Rationale**: No I/O in the acquire path. Async would add microtask overhead on every acquire in multi-agent workflows (10-50 agents). The factory callback is sync (it calls `new AgentLoop()`).

**Migration**: If factory ever becomes async, add `acquireAsync()` alongside sync `acquire()`.

---

## ADR-03: Sync CheckpointStorage

**Context**: 95%+ of use is in-memory. Persistent backends are out of scope for this release.

**Decision**: `CheckpointStorage` interface is synchronous. Methods return values directly, not Promises.

**Rationale**: Avoids Promise allocation overhead for every save/load. Simpler error handling (throw vs reject). In-memory `Map` operations are inherently synchronous.

**Migration**: If persistent storage demand emerges, introduce `AsyncCheckpointStorage` as a separate interface. The sync interface remains for in-memory. `createCheckpointManager` can accept either via overload.

---

## ADR-04: Handoff Serializes to JSON with Prefix

**Context**: `orchestrator.send()` expects `content: string`. Options: (a) broaden AgentMessage.content type, (b) serialize payload to string.

**Decision**: Serialize `HandoffPayload` to JSON with `__handoff__:` prefix in the content string. Do NOT modify `AgentMessage` type.

**Rationale**: Zero changes to orchestrator. Handoff is a pure layer. Existing message consumers continue to work. Prefix collision risk is negligible.

---

## ADR-05: Trace-Based Failure Detection (Not AgentEvent[])

**Context**: Proposal B used `AgentEvent[]` as failure detection input. This requires buffering the full event stream from `AgentLoop.run()`, which contradicts the AsyncGenerator streaming design.

**Decision**: `classify(trace: Trace)` accepts `Trace` objects from `TraceManager`. Users call `taxonomy.classify()` after `traceManager.endTrace()`.

**Rationale**: `Trace` objects are already aggregated by `TraceManager`. No event buffering needed. Natural integration point: classify after trace ends.

**Glue pattern** (4 lines, documented in examples):
```typescript
const taxonomyExporter: TraceExporter = {
  name: 'failure-taxonomy',
  async exportTrace(trace) { taxonomy.classify(trace); },
  async exportSpan() {},
  async flush() {},
};
traceManager = createTraceManager({ exporters: [taxonomyExporter] });
```

---

## ADR-06: Context Boundary with Violation Tracking (from Proposal B)

**Context**: Proposal A had basic prefix matching. Proposal B added violation tracking and configurable read/write behavior.

**Decision**: Adopt Proposal A's core design (prefix matching, fail-closed writes, undefined on denied reads) PLUS Proposal B's violation tracking.

**Additions from B**:
- `getViolations(): readonly BoundaryViolation[]` method on `BoundedContext`
- `BoundaryViolation` type with `{ type, agentId, key, timestamp }`
- Max 1000 violations stored (circular buffer)

**Rationale**: Violation tracking is ~15 lines of code and provides essential debugging visibility for multi-agent access control. No shared abstractions needed.

---

## ADR-07: Pool Drain Semantics

**Context**: Review Panel question: what happens to active agents during `drain()`?

**Decision**: `drain()` waits for all active agents to be released (via polling), then disposes all agents. It does NOT abort active agents.

**Rationale**: Aborting active agents risks corrupting in-flight work. The caller is responsible for ensuring agents complete before calling `drain()`. Timeout can be implemented by the caller via `Promise.race([pool.drain(), timeout(30_000)])`.

---

## ADR-08: Checkpoint Message Copying

**Context**: Review Panel question: shallow copy vs structuredClone?

**Decision**: Shallow copy (`[...messages]`). Messages are readonly interfaces with string/number fields — they are effectively immutable. `structuredClone` is unnecessary and would throw on non-serializable data.

**Rationale**: `Message` types (`SystemMessage | UserMessage | AssistantMessage | ToolMessage`) contain `role: string`, `content: string`, and optional readonly arrays (`toolCalls`, etc.). These are plain data objects. Shallow copy preserves immutability guarantees without deep-clone overhead.

---

## ADR-09: Cache Monitor Running Aggregates (Not Regression)

**Context**: Proposal B added linear regression trend analysis. Review Panel noted this is O(n) per `getMetrics()` call.

**Decision**: Use running aggregates (O(1) metrics) as default. No trend analysis in v1.

**Rationale**: Monitoring primitives should be constant-time. Linear regression on cache buckets is a nice feature but should be opt-in or added later. Users wanting trend analysis can compute it externally from `getTimeSeries()` output.

---

## Resolution of PRD Open Questions

| # | Question | Decision |
|---|---------|----------|
| 1 | HandoffPayload content typing | Serialize to string internally (ADR-04) |
| 2 | Pool warm-up strategy | Lazy on first acquire (ADR per Proposal A) |
| 3 | Context Boundary key matching | Prefix matching via `startsWith()` (ADR-04 of Proposal A) |
| 4 | Failure Taxonomy TraceExporter | No built-in adapter; document 4-line glue pattern (ADR-05) |
| 5 | CheckpointStorage async | Sync interface (ADR-03) |

---

## Implementation Specifications Per Capability

### 1. AgentLoop Status Getter (Prerequisite)

**File**: `packages/core/src/core/agent-loop.ts`
- Add `private _status: AgentLoopStatus = 'idle'`
- Add `get status(): AgentLoopStatus`
- Transitions: `idle→running` in `run()`, `running→completed` in `doneEvent()`, `any→disposed` in `dispose()`

**File**: `packages/core/src/core/types.ts`
- Add `export type AgentLoopStatus = 'idle' | 'running' | 'completed' | 'disposed'`

### 2. Agent Pool (`createAgentPool`)

**File**: `packages/core/src/orchestration/agent-pool.ts`
- Config: `{ factory, min?, max?, idleTimeout?, maxAge? }`
- Returns: `{ acquire, release, resize, drain, stats, dispose }`
- Internal: `Map<string, PoolEntry>` with `{agent, state, idleTimer}`
- Sync acquire, lazy warm-up, factory-based creation
- Recycle = dispose + create fresh
- `drain()` polls active count every 50ms, then disposes all

### 3. Handoff Protocol (`createHandoff`)

**File**: `packages/core/src/orchestration/handoff.ts`
- Config: takes `AgentOrchestrator` instance
- Returns: `{ send, receive, history, verify, dispose }`
- Internal: `Map<string, HandoffReceipt>`, `Map<string, HandoffPayload[]>` (inbox FIFO)
- Serializes payload to `__handoff__:` + JSON via `orchestrator.send()`
- `verify()` returns `{ passed, violations }`, never throws

### 4. Checkpoint Manager (`createCheckpointManager`)

**File**: `packages/core/src/context/checkpoint.ts`
- Config: `{ maxCheckpoints?, countTokens?, storage? }`
- Returns: `{ save, restore, list, prune, dispose }`
- Internal: in-memory storage default (Map + insertion-order array)
- Shallow copy on save (`[...messages]`), shallow copy on restore
- Auto-prune oldest when at capacity
- Sync storage interface

### 5. Failure Taxonomy (`createFailureTaxonomy`)

**File**: `packages/core/src/observe/failure-taxonomy.ts`
- Config: `{ detectors?, minConfidence? }`
- Returns: `{ classify, registerDetector, getStats, reset }`
- 5 built-in structural detectors: tool_loop, early_stop, budget_exceeded, timeout, hallucination
- `classify(trace: Trace)` returns confidence-sorted classifications
- Pluggable custom detectors via `registerDetector()`

### 6. Context Boundary (`createContextBoundary`)

**File**: `packages/core/src/orchestration/context-boundary.ts`
- Config: `(context: SharedContext, policies?: BoundaryPolicy[])`
- Returns: `{ forAgent, setPolicies, getPolicies, getViolations }`
- Prefix matching via `startsWith()`
- Deny > Allow precedence
- Reads return `undefined` (silent), writes throw (fail-closed)
- Violation tracking (max 1000, circular buffer)

### 7. Cache Monitor (`createCacheMonitor`)

**File**: `packages/core/src/observe/cache-monitor.ts`
- Config: `{ pricing?, maxBuckets? }`
- Returns: `{ record, getMetrics, getTimeSeries, reset }`
- Running aggregates for O(1) `getMetrics()`
- Raw data points bucketed on-demand by `getTimeSeries()`
- FIFO eviction with aggregate correction

---

## Estimated Effort

| Component | LOC (impl) | LOC (test) | Days |
|-----------|-----------|-----------|------|
| AgentLoop status | 15 | 40 | 0.5 |
| Agent Pool | 200 | 150 | 1.5 |
| Handoff Protocol | 180 | 120 | 1.0 |
| Checkpoint Manager | 160 | 100 | 1.0 |
| Failure Taxonomy | 250 | 150 | 1.5 |
| Context Boundary | 150 | 100 | 0.5 |
| Cache Monitor | 130 | 80 | 0.5 |
| **Total** | **~1,085** | **~740** | **~6.5** |
