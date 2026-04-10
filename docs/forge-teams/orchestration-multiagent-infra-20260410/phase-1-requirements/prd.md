# PRD: Multi-Agent Infrastructure for harness-one

**Version**: 1.0 (Consensus)
**Created**: 2026-04-10
**Status**: Approved after 2-round adversarial debate
**Authors**: Product Advocate + Technical Skeptic + Lead Arbitrator

---

## 1. Executive Summary

harness-one evolves from single-agent primitives to multi-agent infrastructure. This PRD defines **7 capabilities** (original 8 minus contract, which is merged into handoff) across 3 existing modules. All capabilities follow harness-one's core principles: factory functions, zero dependencies, frozen returns, progressive adoption, primitives not frameworks.

---

## 2. Capability Summary

| # | Capability | Module | Priority | Factory Function |
|---|-----------|--------|----------|-----------------|
| 1 | Agent Pool | orchestration | P0 | `createAgentPool()` |
| 2 | Handoff Protocol | orchestration | P0 | `createHandoff()` |
| 3 | Context Boundary | orchestration | P1 (same-release) | `createContextBoundary()` |
| 4 | ~~Contract~~ | ~~orchestration~~ | ~~DROPPED~~ | Merged into Handoff |
| 5 | Router | orchestration | P2 (recipe only) | Deferred |
| 6 | Checkpoint Manager | context | P0 | `createCheckpointManager()` |
| 7 | Failure Taxonomy | observe | P0 | `createFailureTaxonomy()` |
| 8 | Cache Monitor | observe | P1 (same-release) | `createCacheMonitor()` |

**P0** = Must ship, high value, clearly in scope
**P1** = Ships in same release, built after P0 items
**P2** = Future release, document as recipe/example for now

---

## 3. Architecture Constraints

### Module Placement
All new orchestration capabilities live as **files within the existing `orchestration/` module**, exported from the single `orchestration/index.ts` barrel. Same for context and observe additions.

```
packages/core/src/
├── orchestration/
│   ├── orchestrator.ts      # existing — unchanged
│   ├── spawn.ts             # existing — unchanged
│   ├── strategies.ts        # existing — unchanged
│   ├── agent-pool.ts        # NEW
│   ├── handoff.ts           # NEW
│   ├── context-boundary.ts  # NEW
│   ├── types.ts             # extended with new types
│   └── index.ts             # re-exports everything
├── context/
│   ├── budget.ts            # existing — unchanged
│   ├── compress.ts          # existing — unchanged
│   ├── checkpoint.ts        # NEW
│   ├── types.ts             # extended
│   └── index.ts             # re-exports
└── observe/
    ├── trace-manager.ts     # existing — unchanged
    ├── cost-tracker.ts      # existing — unchanged
    ├── failure-taxonomy.ts  # NEW
    ├── cache-monitor.ts     # NEW
    ├── types.ts             # extended
    └── index.ts             # re-exports
```

### Design Principles (unchanged from harness-one)
- Factory functions returning `Object.freeze()`-d objects
- Zero runtime dependencies
- Only type imports between modules
- Progressive adoption — each capability independently usable
- Provides primitives, not frameworks
- Stateful modules provide `dispose()`

### Prerequisite Work
Before implementation, one small additive change to `core`:
- Add `readonly status: 'idle' | 'running' | 'completed' | 'disposed'` getter to `AgentLoop` — non-breaking, additive, benefits entire ecosystem

---

## 4. Capability Specifications

---

### 4.1 Agent Pool (`createAgentPool`) — P0

#### User Story
As a developer building multi-agent workflows, I want to pre-create and reuse AgentLoop instances so that I avoid repeated setup/teardown overhead for 10-50 concurrent agents.

#### API Surface

```ts
interface PoolConfig {
  readonly factory: (role?: string) => AgentLoop;
  readonly min?: number;         // minimum warm instances (default: 0)
  readonly max?: number;         // hard cap (default: 10)
  readonly idleTimeout?: number; // ms before idle agents disposed (default: 60000)
  readonly maxAge?: number;      // ms before forced recycling
}

interface PoolStats {
  readonly idle: number;
  readonly active: number;
  readonly total: number;
  readonly created: number;
  readonly recycled: number;
}

interface PooledAgent {
  readonly id: string;
  readonly loop: AgentLoop;
  readonly createdAt: number;
  readonly role?: string;
}

interface AgentPool {
  acquire(role?: string): Promise<PooledAgent>;
  release(agent: PooledAgent): void;
  resize(target: number): void;
  drain(): Promise<void>;
  readonly stats: PoolStats;
  dispose(): void;
}

function createAgentPool(config: PoolConfig): AgentPool;
```

#### Key Design Decisions (from debate)
- **Pool tracks lifecycle externally** via acquire/release, not by querying AgentLoop status. This mirrors DB connection pool patterns.
- **"Recycle" = dispose old + create new via factory.** AgentLoop is run-once (generator pattern); no restart semantics.
- **Factory callback** avoids god-object: user controls AgentLoop construction (adapter, tools, guardrails). Pool only manages lifecycle.
- **AbortSignal hierarchy**: Pool abort → all child loop aborts. Individual loop abort doesn't affect siblings.

#### Scope
- **IN**: Create, warm, recycle, dispose lifecycle. Stats tracking. Role-based sub-pools. Idle timeout eviction.
- **OUT**: Auto-scaling heuristics. Distributed pools. Health checks (users can build on `stats`).

---

### 4.2 Handoff Protocol (`createHandoff`) — P0

#### User Story
As a developer chaining agents (planner → coder → reviewer), I want structured message payloads for what was done, found, and concerns, so downstream agents get actionable context instead of raw strings.

#### API Surface

```ts
interface Artifact {
  readonly type: string;       // e.g., 'code', 'plan', 'review'
  readonly content: string;
  readonly label?: string;
}

interface HandoffPayload {
  readonly summary: string;
  readonly artifacts?: readonly Artifact[];
  readonly concerns?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];  // absorbed from contract
  readonly context?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface HandoffReceipt {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly timestamp: number;
  readonly payload: HandoffPayload;
}

interface HandoffManager {
  send(from: string, to: string, payload: HandoffPayload): HandoffReceipt;
  receive(agentId: string): HandoffPayload | undefined;
  history(agentId: string): readonly HandoffReceipt[];
  verify(receiptId: string, output: unknown, verifier: (criterion: string, output: unknown) => boolean): {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
  dispose(): void;
}

function createHandoff(orchestrator: AgentOrchestrator): HandoffManager;
```

#### Key Design Decisions (from debate)
- **Layered on orchestrator, not competing.** `createHandoff(orchestrator)` uses `orchestrator.send()` internally for transport. Users who don't need structure keep using `orchestrator.send()` directly.
- **Contract merged into Handoff.** `acceptanceCriteria` field + `verify()` method covers 90% of contract use cases without a separate negotiation protocol.
- **`verify()` returns result, doesn't throw.** Caller decides retry/rejection logic. This keeps handoff as a primitive, not a framework.

#### Scope
- **IN**: Structured payload format. Send/receive. Receipt trail. Acceptance criteria verification.
- **OUT**: Payload validation schemas. Automatic conversation summarization. Retry/acknowledgment protocol. LLM-based negotiation.

---

### 4.3 Context Boundary (`createContextBoundary`) — P1 (same-release)

#### User Story
As a developer running multiple agents with different roles, I want to control which SharedContext keys each agent can read/write, so agents don't accidentally overwrite or read each other's intermediate state.

#### API Surface

```ts
interface BoundaryPolicy {
  readonly agent: string;
  readonly allowRead?: readonly string[];   // key prefix patterns
  readonly denyRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  readonly denyWrite?: readonly string[];
}

interface BoundedContext {
  forAgent(agentId: string): SharedContext;  // returns filtered view
  setPolicies(policies: readonly BoundaryPolicy[]): void;
  getPolicies(agentId: string): BoundaryPolicy | undefined;
}

function createContextBoundary(
  context: SharedContext,
  policies?: readonly BoundaryPolicy[]
): BoundedContext;
```

#### Key Design Decisions (from debate)
- **Renamed from "isolation" to "context boundary."** This is logical access control, not security isolation.
- **Advisory ACL, not security sandbox.** Documentation MUST state: "This provides logical access control, not security isolation. Agents in the same process share memory. For trust-boundary isolation, use separate processes."
- **No "isolation" anywhere in public API** — not in type names, JSDoc, or examples.
- **Fail-closed semantics**: `get()` returns `undefined` for out-of-scope keys (matches `Map.get()`). `set()` throws on out-of-scope writes (fail-closed, consistent with budget overflow behavior).
- **Prefix-based matching** for key patterns (e.g., `"agent-a:*"`) — simple and predictable.

#### Scope
- **IN**: Key-prefix-based read/write filtering. Policy CRUD. Filtered SharedContext views per agent.
- **OUT**: Encryption. Process isolation. Dynamic policy inference. Regex patterns.

---

### 4.4 Checkpoint Manager (`createCheckpointManager`) — P0

#### User Story
As a developer whose agents hit context limits mid-task, I want to snapshot conversation state at safe points and restore from checkpoints, so long-running agents recover gracefully instead of losing critical context.

#### API Surface

```ts
interface Checkpoint {
  readonly id: string;
  readonly label?: string;
  readonly messages: readonly Message[];
  readonly tokenCount: number;
  readonly timestamp: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface CheckpointStorage {
  save(checkpoint: Checkpoint): void;
  load(id: string): Checkpoint | undefined;
  list(): readonly Checkpoint[];
  delete(id: string): boolean;
}

interface CheckpointManager {
  save(messages: readonly Message[], label?: string, metadata?: Record<string, unknown>): Checkpoint;
  restore(checkpointId: string): readonly Message[];
  list(): readonly Checkpoint[];
  prune(options?: { maxCheckpoints?: number; maxAge?: number }): number;
  dispose(): void;
}

function createCheckpointManager(config?: {
  maxCheckpoints?: number;         // default: 5
  countTokens?: (msgs: readonly Message[]) => number;
  storage?: CheckpointStorage;     // default: in-memory
}): CheckpointManager;
```

#### Key Design Decisions (from debate)
- **Checkpoints snapshot messages, NOT budget state.** Messages are plain data objects (discriminated union) — trivially copyable. Budget state is derived and re-computed from restored messages via `countTokens()` + `budget.allocate()`. This eliminates the closure serialization problem entirely.
- **Pluggable storage** via `CheckpointStorage` interface. Default is in-memory. Users can implement persistent storage without harness-one taking a dependency.
- **`maxCheckpoints` + `prune()`** mitigate memory risk. Each checkpoint stores a full message array copy.
- **No automatic checkpoint triggers.** User calls `save()` explicitly before risky operations.

#### Restore Flow
```ts
// Save before risky operation
const cp = checkpointManager.save(currentMessages, 'before-large-tool-call');

// ... context overflow happens ...

// Restore
const restored = checkpointManager.restore(cp.id);
// Re-derive budget state (same as initial setup)
budget.reset('history');
budget.allocate('history', countTokens('default', restored));
```

#### Scope
- **IN**: Save/restore message snapshots. In-memory default storage. Pluggable storage interface. Automatic pruning.
- **OUT**: Diff-based storage optimization. Automatic checkpoint triggers. Budget state serialization. Distributed checkpoints.

---

### 4.5 Failure Taxonomy (`createFailureTaxonomy`) — P0

#### User Story
As a developer debugging agent failures, I want automatic classification of failure modes from trace data, so I can quickly identify early stops, tool loops, context forgetting, and other known patterns.

#### API Surface

```ts
type FailureMode =
  | 'early_stop'
  | 'tool_loop'
  | 'context_forgetting'
  | 'hallucination'
  | 'budget_exceeded'
  | 'timeout'
  | 'unrecoverable_error'
  | 'unknown';

interface FailureClassification {
  readonly mode: FailureMode;
  readonly confidence: number;     // 0-1
  readonly evidence: string;       // human-readable explanation
  readonly traceId: string;
  readonly spanIds?: readonly string[];
}

interface FailureDetector {
  detect(trace: Trace): { confidence: number; evidence: string } | null;
}

interface FailureTaxonomy {
  classify(trace: Trace): readonly FailureClassification[];
  registerDetector(mode: string, detector: FailureDetector): void;
  getStats(): Readonly<Record<string, number>>;
  reset(): void;
}

function createFailureTaxonomy(config?: {
  detectors?: Readonly<Record<string, FailureDetector>>;
  minConfidence?: number;  // default: 0.5
}): FailureTaxonomy;
```

#### Key Design Decisions (from debate)
- **Exporter-based trace feed.** The taxonomy accepts individual `Trace` objects via `classify()`. Users wire this into their trace pipeline — either manually after `endTrace()`, or via a custom `TraceExporter` that calls `taxonomy.classify()`. No changes to `TraceManager` needed.
- **Phase 1: 5 structural detectors** that work on trace structure (span count, timestamps, names, status), NOT on span attributes:
  - `tool_loop`: N consecutive spans with same name
  - `early_stop`: Trace completed with very few spans / low duration
  - `budget_exceeded`: Last span error + high token count
  - `timeout`: Duration exceeds threshold, last span still running
  - `hallucination`: Span with error status + tool call pattern in name
- **Phase 2 (future)**: Add `context_forgetting` and other attribute-dependent detectors once span attribute conventions are established.
- **Pluggable detectors** via `registerDetector()` — users add domain-specific classifiers.

#### Recommended Span Attribute Conventions (documented, not enforced)
```ts
// Recommended attributes for richer failure detection:
span.attributes = {
  'harness.type': 'llm_call' | 'tool_call' | 'guardrail_check',
  'harness.tool_name': string,
  'harness.error_code': string,      // from HarnessError.code
  'harness.prompt_tokens': number,
  'harness.completion_tokens': number,
};
```

#### Scope
- **IN**: 5 built-in heuristic detectors. Pluggable custom detectors. Stats aggregation. Convention docs.
- **OUT**: LLM-based classification. Root cause analysis. Auto-remediation. Enforced attribute schemas.

---

### 4.6 Cache Monitor (`createCacheMonitor`) — P1 (same-release)

#### User Story
As a developer optimizing LLM costs, I want to track KV-cache hit rates across calls, so I can measure whether my prompt structuring improves cache utilization.

#### API Surface

```ts
interface CacheMetrics {
  readonly totalCalls: number;
  readonly avgHitRate: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly estimatedSavings: number;
}

interface CacheMetricsBucket {
  readonly timestamp: number;
  readonly calls: number;
  readonly avgHitRate: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

interface CacheMonitor {
  record(usage: TokenUsage, prefixMatchRatio?: number): void;
  getMetrics(): CacheMetrics;
  getTimeSeries(bucketMs?: number): readonly CacheMetricsBucket[];
  reset(): void;
}

function createCacheMonitor(config?: {
  pricing?: { cacheReadPer1kTokens: number; inputPer1kTokens: number };
  maxBuckets?: number;  // default: 100
}): CacheMonitor;
```

#### Key Design Decisions (from debate)
- **Thin primitive with convention value.** ~80-100 lines of code, but provides a standard way to measure cache effectiveness across the ecosystem.
- **User calls `record()` explicitly.** No automatic hooking into adapters.
- **Provider-agnostic.** Works with any provider that returns `cacheReadTokens` in `TokenUsage` (currently Anthropic). For providers without cache data, metrics default to 0.

#### Scope
- **IN**: Usage recording. Aggregate metrics. Time-series bucketing. Savings estimation.
- **OUT**: Automatic recording. Provider-specific cache APIs. Cache optimization recommendations.

---

### 4.7 Router — P2 (Deferred)

Router is deferred to a future release. The current `DelegationStrategy` interface + user-defined factory functions cover the immediate need.

**Recipe (to be documented in examples/):**
```ts
// Model routing via factory function — no new primitive needed
function createModelRouter(rules: Map<string, AgentAdapter>, fallback: AgentAdapter) {
  return (role?: string): AgentAdapter => rules.get(role ?? '') ?? fallback;
}

const router = createModelRouter(
  new Map([['planner', opusAdapter], ['coder', sonnetAdapter]]),
  sonnetAdapter
);

const pool = createAgentPool({
  factory: (role) => new AgentLoop({ adapter: router(role), tools, maxIterations: 20 }),
  max: 10,
});
```

---

## 5. Priority & Implementation Order

### Within the release

| Order | Capability | Module | Priority | Dependencies |
|-------|-----------|--------|----------|-------------|
| 0 | AgentLoop status getter | core | Prerequisite | None |
| 1 | Checkpoint Manager | context | P0 | None |
| 2 | Failure Taxonomy | observe | P0 | None |
| 3 | Agent Pool | orchestration | P0 | Prerequisite #0 |
| 4 | Handoff Protocol | orchestration | P0 | None (benefits from pool) |
| 5 | Context Boundary | orchestration | P1 | None |
| 6 | Cache Monitor | observe | P1 | None |

Items 1-2 can be built in parallel. Items 3-4 can be built in parallel. Items 5-6 can be built in parallel.

### Dependency Graph

```
AgentLoop status (prerequisite)
    └──▶ Agent Pool (P0)
              └──▶ (benefits) Handoff (P0)
                        └──▶ (benefits) Context Boundary (P1)

Checkpoint Manager (P0) ──── independent
Failure Taxonomy (P0) ──── independent
Cache Monitor (P1) ──── independent
```

---

## 6. Debate Resolution Summary

| Topic | Product Advocate | Technical Skeptic | Arbitration |
|-------|-----------------|-------------------|-------------|
| Contract capability | MERGE into Handoff | AGREE | **MERGED** — acceptanceCriteria + verify() on Handoff |
| Isolation naming | Accept rename | Demanded rename | **RENAMED** to createContextBoundary |
| Isolation priority | P0 → conceded P1 | P1 → conceded P0 | **P1 with same-release guarantee** |
| Checkpoint budget dep | No dep (messages only) | Budget API needs retrofit | **No dep** — messages-only design is correct |
| Module boundaries | Extend existing modules | AGREE | **All in existing modules** |
| Handoff vs orchestrator | Protocol layer on transport | Duplication concern | **Layered** — handoff wraps orchestrator |
| Agent pool lifecycle | External tracking | AgentLoop needs status | **External tracking primary**, status getter as bonus |
| Failure taxonomy | 5 structural detectors | Needs attribute conventions | **Phase 1: structural, Phase 2: attribute-based** |
| Router | P1 | Application layer | **P2 — recipe only** |
| Cache monitor | P1 | Too thin | **P1 — thin but convention-valuable** |

---

## 7. Non-Goals

- **No workspace/process isolation** — violates zero-dependency principle
- **No task scheduler** — application layer concern
- **No LLM-based failure classification** — out of scope for primitives toolkit
- **No automatic checkpoint triggers** — users control save points
- **No enforced span attribute schemas** — document conventions, don't enforce
- **No distributed agent pools** — single-process only
- **No contract negotiation protocol** — merged into handoff verification

---

## 8. Success Metrics

| Metric | Target |
|--------|--------|
| Multi-agent workflow adoption (pool or handoff) | 30%+ of users within 3 months |
| Checkpoint restore latency | < 2s for 100k-token conversations |
| Failure classification accuracy (top 5 modes) | > 80% precision |
| Cache savings visibility | 100% of users can query hit rate at launch |
| Zero new runtime dependencies | 0 |
| Test coverage for new code | > 90% line coverage |

---

## 9. Open Questions for Architecture Phase

1. **HandoffPayload `content` typing**: Should `AgentMessage.content` be broadened from `string` to `string | HandoffPayload` or should handoff serialize to string internally?
2. **Agent Pool warm-up strategy**: Should `min` agents be pre-created at pool construction or lazily on first `acquire()`?
3. **Context Boundary key matching**: Prefix matching (`"agent-a:"`) vs glob (`"agent-a:*"`) — which is simpler and sufficient?
4. **Failure Taxonomy integration**: Should the taxonomy expose a `TraceExporter` adapter for seamless TraceManager integration?
5. **CheckpointStorage async**: Should `CheckpointStorage` methods be async (for persistent backends) or sync (for in-memory default)?
