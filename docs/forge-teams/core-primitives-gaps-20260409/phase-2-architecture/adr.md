# ADR: Core Primitives Gaps — Architecture Decision Record

**Date**: 2026-04-09  
**Status**: Accepted (Post-bakeoff hybrid)  
**Proposals Evaluated**: A (Simplicity) scored 8.18, B (Extensibility) scored 6.86  
**Decision**: Hybrid — A's foundation + specific B improvements

---

## Decision Summary

| Item | Source | Approach |
|------|--------|----------|
| P0: Rate Limiter TOCTOU | **A** | Inline pre-claim, no release on execute failure, no new abstractions |
| P1: Parallel Execution | **Hybrid** | B's `ExecutionStrategy` + worker pool + sugar flags; A's `isSequentialTool` callback |
| P1: spawnSubAgent | **A + B** | A's message collection (correct); B's `doneReason` field |
| P1: compactIfNeeded | **B** | With `countTokens` pluggable parameter |
| P2: MCP Client | **A** | Direct `@modelcontextprotocol/sdk` usage, no custom transport layer |

---

## ADR-01: Rate Limiter Pre-Claim Without Release on Execute Failure

**Context**: `registry.ts` rate limiter has TOCTOU race. Fix requires moving counter increment before async operations.

**Decision**: Pre-claim pattern. Decrement on pre-execution failures (not-found, parse, validate, permission). Do NOT decrement on `tool.execute()` failure.

**Rationale**: A tool that reached `execute()` consumed a slot — it may have had side effects. Releasing on failure would allow rate limit bypass via intentional failures. Conservative stance is correct for a security boundary.

**Rejected**: B's `RateLimitPolicy` interface — scope creep on a P0 bug fix. Pluggable rate limiting can be a separate future PR.

---

## ADR-02: ExecutionStrategy Pattern with Sugar Flags

**Context**: Parallel tool execution needs a correct concurrency cap and tool-level opt-out.

**Decision**: 
- B's `ExecutionStrategy` interface with `createSequentialStrategy()` and `createParallelStrategy()` 
- B's `promiseAllSettledWithConcurrency` worker pool (correct concurrency, unlike A's buggy chunking)
- Sugar flags on AgentLoopConfig: `parallel?: boolean`, `maxParallelToolCalls?: number`
- A's `isSequentialTool?: (name: string) => boolean` callback (clean module boundary, unlike B's `(schema as any).sequential`)

**Rationale**: 
- A's chunk-based concurrency cap is buggy (batch processing ≠ true concurrency limiting)
- B's worker pool correctly drains work with N concurrent workers
- Sugar flags make the simple case (`{ parallel: true }`) zero-cost
- `isSequentialTool` callback preserves core↔tools module boundary without type-unsafe casts

**Key types**:
```typescript
interface ExecutionStrategy {
  execute(
    calls: readonly ToolCallRequest[],
    handler: (call: ToolCallRequest) => Promise<unknown>,
    options?: { getToolMeta?: (name: string) => { sequential?: boolean } | undefined; signal?: AbortSignal },
  ): Promise<readonly ToolExecutionResult[]>;
}

interface AgentLoopConfig {
  parallel?: boolean;                    // sugar → createParallelStrategy()
  maxParallelToolCalls?: number;         // sugar → maxConcurrency
  executionStrategy?: ExecutionStrategy; // advanced: full control
  isSequentialTool?: (name: string) => boolean;  // metadata bridge
}
```

---

## ADR-03: Minimal spawnSubAgent with doneReason

**Context**: Need a "spawn child, run to completion, get results" utility.

**Decision**: A's implementation with event-stream-based message collection + B's `doneReason` field.

**Return type**:
```typescript
interface SpawnSubAgentResult {
  readonly messages: readonly Message[];
  readonly usage: TokenUsage;
  readonly doneReason: DoneReason;  // from B: 'end_turn' | 'max_iterations' | 'aborted' | ...
}
```

**Rationale**: 
- A correctly captures both `message` and `tool_result` events to reconstruct full conversation
- B has a message completeness bug (missing `tool_result` messages)
- `doneReason` is genuinely useful (3 LOC cost) — callers need to distinguish normal exit from max_iterations/abort
- B's `events` array and `SpawnHooks` are YAGNI — debugging belongs in a wrapper, not the core utility

**Rejected**: B's hooks (`SpawnHooks`) and events accumulation.

---

## ADR-04: compactIfNeeded with Pluggable Token Counter

**Context**: Auto-compaction helper wraps `compress()` with a threshold check.

**Decision**: B's version with optional `countTokens` parameter.

```typescript
interface CompactOptions {
  readonly budget: number;
  readonly threshold?: number;       // default: 0.75
  readonly strategy: string | CompressionStrategy;
  readonly countTokens?: (messages: readonly Message[]) => number;  // from B
  // ... other strategy-specific options
}
```

**Rationale**: The built-in heuristic has ~20-40% margin. `registerTokenizer()` is global mutable state — contrary to harness-one's "explicit parameters" philosophy. Per-call injection via `countTokens` parameter costs one optional field and prevents a future breaking change.

---

## ADR-05: MCP Client via Direct SDK Usage

**Context**: MCP client needs transport handling (stdio, SSE).

**Decision**: A's approach — use `@modelcontextprotocol/sdk` directly. No custom transport abstraction.

**Rationale**:
- The SDK already provides transport abstraction via its `Transport` interface
- B's custom `MCPTransport` re-implements protocol handling (initialize, capability negotiation) that the SDK handles automatically
- When new transports (WebSocket) arrive, they'll be implemented in the SDK first — A gets them for free
- Matches existing integration package pattern (`@harness-one/anthropic`, `@harness-one/openai`)

**Rejected**: B's `MCPTransport` / `MCPTransportFactory` — duplicates SDK functionality, creates parallel maintenance burden.

---

## Critical Bugs Found During Review

1. **A's concurrency cap**: Chunk-based `Promise.allSettled` ≠ true concurrency limiting. Worker pool required.
2. **B's spawnSubAgent**: Missing `tool_result` events in message collection. Incomplete conversation.
3. **B's MCP transport**: Re-implements SDK protocol handling. Fragile under SDK version changes.

---

## Files Changed Summary (Hybrid)

| File | Change | Source |
|------|--------|--------|
| `tools/registry.ts` | Pre-claim TOCTOU fix | A |
| `tools/types.ts` | Add `sequential?: boolean` to ToolDefinition | Both |
| `core/types.ts` | Add `ToolExecutionResult`, `ExecutionStrategy` | B |
| `core/execution-strategies.ts` | New: `createSequentialStrategy()`, `createParallelStrategy()` | B |
| `core/agent-loop.ts` | Integrate `ExecutionStrategy`, add config fields | Hybrid |
| `orchestration/spawn.ts` | New: `spawnSubAgent()` | A (+ doneReason) |
| `orchestration/types.ts` | Add `SpawnSubAgentConfig`, `SpawnSubAgentResult` | Hybrid |
| `context/compress.ts` | Add `compactIfNeeded()` with `countTokens` | B |
| `packages/mcp/` | New package: MCP client | A |

**Estimated effort**: ~6.5 days
