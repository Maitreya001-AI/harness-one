# Architecture Evaluation: Proposal A vs Proposal B

**Evaluator**: Technical Critic (Review Panel)  
**Date**: 2026-04-09  
**PRD Reference**: `phase-1-requirements/prd.md`  
**Status**: Final Evaluation

---

## Evaluation Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Feasibility | 25% | Can this be implemented as described? Are the code sketches correct? |
| Maintainability | 25% | Will this be easy to maintain, test, and evolve? |
| Performance | 20% | Any performance concerns? Memory, latency, throughput? |
| Security | 15% | Any security risks? Rate limiting correctness? |
| Tech Debt Risk | 15% | Does this create future problems? Over-engineering? Under-engineering? |

---

## Item 1: Rate Limiter TOCTOU Fix (P0)

### Proposal A — Inline Pre-Claim

Moves `turnCalls++; sessionCalls++` before the first `await`, with manual `turnCalls--; sessionCalls--` on every pre-execution bailout path (not-found, parse error, validation failure, permission denial). Does NOT release on execution failure.

**Code sketch accuracy**: Verified against `registry.ts:96-184`. The current increment is at lines 158-159, after multiple async gaps (JSON.parse is sync but the control flow between check at 98-111 and increment at 158 crosses validation and permission checks). A's sketch correctly identifies all pre-execution bailout paths and adds decrements. The counter fields (`turnCalls`, `sessionCalls`) are closure variables (lines 55-56) — A's direct manipulation is correct.

### Proposal B — RateLimitPolicy Interface

Extracts a `RateLimitPolicy` interface with `tryAcquire()` / `release()` / `resetTurn()` / `resetSession()`. Default implementation is the same counter logic. Also releases on unexpected execution failure (the `catch (err) { rateLimit.release(); throw err; }` at the end).

**Code sketch accuracy**: Correct. The policy interface maps cleanly onto existing `turnCalls`/`sessionCalls`/`resetTurn()`/`resetSession()` in registry.ts.

### Key Question: Release on execution failure?

**A says no.** Rationale: a tool that reached `execute()` may have had side effects (network calls, writes). Releasing the slot on failure would allow an attacker to exceed limits by triggering intentional failures. This is **the correct stance**. Once `tool.execute(params)` is called, the rate-limit slot is consumed regardless of outcome.

**B says yes (on unexpected throw).** B's `catch` block releases and re-throws. The distinction is between `ToolResult` errors (normal — slot consumed) and thrown exceptions (unexpected crash — slot released). This is reasonable in theory but dangerous in practice: a malicious tool could `throw` instead of returning a `toolError()` to reclaim its slot. Since the rate limiter is a security boundary, the conservative choice (A's) is correct.

### Scores

| Criterion | A | B | Notes |
|-----------|---|---|-------|
| Feasibility | 9 | 7 | A is a minimal diff. B adds a new interface + extraction refactor for a P0 bug fix — scope creep risk. |
| Maintainability | 8 | 7 | A: 5 manual decrement sites are slightly fragile but straightforward. B: cleaner abstraction but more indirection. |
| Performance | 9 | 9 | Both identical runtime cost. |
| Security | 9 | 7 | A's no-release-on-execute is strictly safer. B's release-on-throw creates a subtle bypass vector. |
| Tech Debt | 9 | 5 | B's `RateLimitPolicy` is premature abstraction. No user has asked for pluggable rate limiting. YAGNI. The ~10 LOC interface cost is real when you count docs, tests, and cognitive load. |
| **Weighted** | **8.85** | **6.90** | |

### Verdict: **Adopt A**

The P0 bug fix should be the smallest possible change. A's inline approach is correct, safe, and minimal. B's `RateLimitPolicy` extraction is a valid idea for a future refactoring PR, but bundling it with a P0 security fix increases review scope and risk.

---

## Item 2: Parallel Tool Execution (P1)

### Proposal A — `isSequentialTool` Callback + Private Methods

Adds `parallel`, `maxParallelToolCalls`, and `isSequentialTool` callback to `AgentLoopConfig`. Two new private methods on AgentLoop: `executeToolsSequential` (extracted current logic) and `executeToolsParallel` (partition + Promise.allSettled).

**Code sketch accuracy — CRITICAL BUG FOUND**: A's concurrency cap implementation is **incorrect**. Lines 241-264 use chunk-based processing:

```typescript
for (let i = 0; i < parallelTools.length; i += this.maxParallelToolCalls) {
  const chunk = parallelTools.slice(i, i + this.maxParallelToolCalls);
  const settled = await Promise.allSettled(chunk.map(...));
}
```

This processes tools in sequential **batches**, not with a true concurrency cap. If `maxParallelToolCalls = 2` and there are 4 tools taking [100ms, 10ms, 10ms, 10ms]: batch 1 runs tools 0+1 (completes at 100ms), then batch 2 runs tools 2+3 (completes at 110ms). A true concurrency limiter would start tool 2 at 10ms (when tool 1 finishes), completing all 4 by ~100ms. The chunked approach wastes ~80ms here and gets worse with uneven tool durations.

**Also**: A's `executeToolsParallel` has a defensive guard `results.set('unknown', ...)` for rejected entries in `Promise.allSettled`, but `allSettled` never rejects — it maps rejections to `{ status: 'rejected' }` entries. This dead code path also maps to the wrong key (`'unknown'` instead of the actual tool ID), which would silently lose results if somehow triggered.

### Proposal B — ExecutionStrategy Interface

Introduces `ExecutionStrategy` interface + `createSequentialStrategy()` / `createParallelStrategy()` factories. Uses a proper worker-pool pattern for concurrency:

```typescript
async function promiseAllSettledWithConcurrency<T>(
  factories: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  // N workers pull from a shared index
}
```

**Code sketch accuracy**: The worker pool is correct — `nextIndex++` is atomic in single-threaded JS, workers drain the queue properly. However, `getToolMeta` has a type safety issue: `(schema as any).sequential` casts through `any` because `ToolSchema` (from `core/types.ts`) doesn't have a `sequential` field. This works at runtime if the user spreads `ToolDefinition` fields into the schema, but it's fragile and type-unsafe.

**Also**: B provides sugar flags (`parallel` / `maxParallelToolCalls`) that map to strategies in the constructor, matching the PRD's simple API. This means simple users write `{ parallel: true }` and never see `ExecutionStrategy`.

### Scores

| Criterion | A | B | Notes |
|-----------|---|---|-------|
| Feasibility | 5 | 8 | A's concurrency implementation is buggy (chunking != concurrency cap). B's worker pool is correct. |
| Maintainability | 7 | 7 | A: simpler structure but wrong. B: more files but clean separation. Sugar flags keep simple cases simple. |
| Performance | 5 | 8 | A's batch processing wastes time on uneven workloads. B's worker pool is optimal. |
| Security | 8 | 7 | Both integrate with rate limiter. B's `(schema as any)` cast is a minor concern. |
| Tech Debt | 8 | 6 | A's callback is minimal. B's strategy pattern is more abstraction than currently needed, but the sugar flags mitigate this. |
| **Weighted** | **6.45** | **7.35** | |

### Verdict: **Hybrid — B's concurrency + A's metadata approach**

Adopt B's `ExecutionStrategy` pattern and `promiseAllSettledWithConcurrency` worker pool — the concurrency implementation is correct while A's is buggy. But replace B's fragile `getToolMeta: (name) => (schema as any).sequential` with A's cleaner `isSequentialTool?: (name: string) => boolean` callback on the config. This keeps AgentLoop ignorant of `ToolDefinition` internals while using the correct concurrency algorithm.

Specifically:
- **From B**: `ExecutionStrategy` interface, `createSequentialStrategy()`, `createParallelStrategy()`, `promiseAllSettledWithConcurrency`, sugar flags
- **From A**: `isSequentialTool` callback pattern (passed through to strategy as `getToolMeta` adapter)
- **Drop**: B's `(schema as any).sequential` lookup from `ToolSchema[]`

---

## Item 3: `spawnSubAgent()` Utility (P1)

### Proposal A — Minimal `{ messages, usage }`

~45 LOC. Collects conversation from event stream: captures `message` events (assistant messages) and `tool_result` events (tool result messages). Returns frozen `{ messages, usage }`.

**Code sketch accuracy**: A correctly captures both `message` and `tool_result` events to reconstruct the full conversation. The initial `const conversation = [...options.messages]` seeds with the input messages, then appends from events. This produces a complete conversation transcript.

### Proposal B — Rich `{ messages, usage, events, doneReason }` + Hooks

~75 LOC. Captures all events into an `events` array. Has lifecycle hooks (`onStart`, `onEvent`, `onComplete`). Returns `doneReason` for termination reason.

**Code sketch accuracy — BUG FOUND**: B's message collection only captures `message` events:

```typescript
if (event.type === 'message') {
  childMessages.push(event.message);
}
```

This **misses tool result messages**. Looking at `agent-loop.ts:262-268`, tool results are pushed to the internal `conversation` array but are NOT yielded as `message` events — they're yielded as `tool_result` events (line 259). B's `messages` array will contain the initial messages + assistant messages, but **not** tool result messages. The user would need to reconstruct tool results from the `events` array. This is a correctness bug — the primary `messages` field is incomplete.

**Other concerns**:
- `events` array stores ALL events (including potentially large `message` events with full content). For a child with 10 iterations, this is modest. For a long-running child with streaming enabled, `text_delta` events could accumulate significantly.
- `SpawnHooks` adds 3 hooks that could be achieved with a simple wrapper around `spawnSubAgent`. YAGNI.
- `doneReason` is genuinely useful — callers need to know if the child hit max_iterations vs ended normally vs was aborted. This should be adopted.

### Scores

| Criterion | A | B | Notes |
|-----------|---|---|-------|
| Feasibility | 9 | 5 | A's message collection is correct. B has a message completeness bug. |
| Maintainability | 9 | 6 | A: minimal, easy to understand. B: hooks + events + types add maintenance surface. |
| Performance | 9 | 7 | B's event accumulation adds memory overhead proportional to conversation length. |
| Security | 8 | 7 | Both freeze results. B's events may reference internal error objects. |
| Tech Debt | 9 | 5 | B's hooks are YAGNI. `events` is debugging convenience that belongs in a debug wrapper, not the core utility. |
| **Weighted** | **8.90** | **5.95** | |

### Verdict: **Adopt A + `doneReason` from B**

A's implementation is correct and minimal. Adopt A's approach but add `doneReason` to the result type — it's genuinely useful (3 lines of code). Do NOT adopt B's hooks or events array.

```typescript
export interface SpawnSubAgentResult {
  readonly messages: readonly Message[];
  readonly usage: TokenUsage;
  readonly doneReason: DoneReason;  // Added from B
}
```

---

## Item 4: `compactIfNeeded()` Helper (P1)

### Proposal A — Pure Wrapper

Uses existing `msgTokens()` directly from `compress.ts`. No new parameters beyond what the PRD specifies.

**Code sketch accuracy**: Correct. `msgTokens()` is defined at line 15-17 of `compress.ts` and wraps `estimateTokens('default', msg.content)`. A's loop `for (const msg of messages) { totalTokens += msgTokens(msg); }` correctly sums token estimates.

### Proposal B — With `countTokens` Parameter

Same as A, but adds `countTokens?: (messages: readonly Message[]) => number` for pluggable token counting.

**Code sketch accuracy**: Correct. Falls back to `messages.reduce((sum, msg) => sum + msgTokens(msg), 0)` when `countTokens` is not provided — functionally identical to A.

### Key Question: Is `countTokens` YAGNI?

**No — it's genuinely useful.** The PRD explicitly warns about ~20-40% margin on the heuristic estimator and mentions `registerTokenizer()` as the precision path. But `registerTokenizer()` is global mutable state, while `countTokens` is explicit per-call injection. This aligns with harness-one's design philosophy of "explicit parameters, no implicit state." The cost is one optional parameter — negligible.

### Scores

| Criterion | A | B | Notes |
|-----------|---|---|-------|
| Feasibility | 9 | 9 | Both correct, minimal implementation. |
| Maintainability | 9 | 8 | B adds one parameter. Trivial maintenance cost. |
| Performance | 8 | 9 | B allows precise counting, avoiding unnecessary compression from inaccurate heuristics. |
| Security | 8 | 8 | No security implications for either. |
| Tech Debt | 8 | 8 | B's `countTokens` is a clean extension point, not over-engineering. |
| **Weighted** | **8.55** | **8.50** | |

### Verdict: **Adopt B**

The scores are nearly identical, but B's `countTokens` parameter provides genuine value at negligible cost. It's the kind of extension point that prevents a future breaking change (adding the parameter later would be additive but adopting it now signals the right API contract).

---

## Item 5: MCP Client (P2)

### Proposal A — Direct SDK Usage

Uses `@modelcontextprotocol/sdk` classes directly: `StdioClientTransport`, `SSEClientTransport`, `Client`. ~200 LOC total package.

**Code sketch accuracy**: Correct. A imports from the SDK's documented paths (`@modelcontextprotocol/sdk/client/index.js`, `client/stdio.js`, `client/sse.js`). The `Client` class `connect()` method, `listTools()`, and `callTool()` match the SDK's public API. The namespace strategy (`${namespace}.${tool.name}`) correctly leverages `registry.list(namespace)` filtering at `registry.ts:80-84`.

### Proposal B — Custom Transport Abstraction

Defines `MCPTransport` interface with `request<T>(method, params)` / `close()` / `connected`. Creates `MCPTransportFactory` for injection. Implements the MCP protocol handshake manually (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).

**Code sketch accuracy — SIGNIFICANT CONCERN**: B re-implements MCP protocol handling that `@modelcontextprotocol/sdk` already provides. Specifically:

1. B manually sends `initialize` and `notifications/initialized` — the SDK's `Client.connect()` handles this automatically with proper capability negotiation.
2. B's `transport.request('tools/list')` assumes raw JSON-RPC — the SDK provides typed methods (`client.listTools()`).
3. B's custom `MCPTransport` interface (`request<T>(method, params)`) is essentially a JSON-RPC transport — but the SDK already has its own `Transport` interface with different semantics (event-based, not request-response).

This means B is **fighting the SDK** rather than leveraging it. If the SDK changes its protocol handling (e.g., adding capability negotiation in a future MCP version), B's manual implementation would break. A stays in sync automatically.

### Key Question: Is B's transport abstraction worth it?

**No.** The `@modelcontextprotocol/sdk` already provides transport abstraction via its own `Transport` interface. B's abstraction wraps the SDK's abstraction — a redundant layer. When/if a new transport (WebSocket) is needed, it will be implemented in the SDK first, and A's approach will get it for free. B would need to implement it twice (once in the SDK transport, once in the `MCPTransport` wrapper).

### Scores

| Criterion | A | B | Notes |
|-----------|---|---|-------|
| Feasibility | 9 | 6 | A leverages SDK correctly. B re-implements protocol handling, risking version incompatibility. |
| Maintainability | 8 | 5 | A: SDK handles complexity. B: custom transport layer must track SDK changes. |
| Performance | 8 | 7 | A: SDK-optimized. B: extra indirection, no benefit. |
| Security | 7 | 6 | A: SDK handles auth/TLS. B: custom transport must replicate security correctly. |
| Tech Debt | 8 | 4 | B's transport abstraction duplicates the SDK, creating a maintenance burden with zero current benefit. |
| **Weighted** | **8.15** | **5.60** | |

### Verdict: **Adopt A**

The SDK exists precisely to handle transport and protocol concerns. A's approach is the established pattern (matching `@harness-one/anthropic` and `@harness-one/openai` integration packages). B's transport abstraction creates a parallel maintenance burden for no current benefit.

---

## Overall Weighted Scores

| Item | Weight | A Score | B Score | Recommendation |
|------|--------|---------|---------|----------------|
| P0: Rate Limiter TOCTOU | Equal | **8.85** | 6.90 | A |
| P1: Parallel Tool Execution | Equal | 6.45 | **7.35** | Hybrid (B's concurrency + A's callback) |
| P1: spawnSubAgent() | Equal | **8.90** | 5.95 | A + doneReason from B |
| P1: compactIfNeeded() | Equal | 8.55 | **8.50** | B (countTokens) |
| P2: MCP Client | Equal | **8.15** | 5.60 | A |
| **Average** | | **8.18** | **6.86** | |

---

## Final Recommendation: **HYBRID**

Take specific pieces from each proposal:

| Item | Source | What to Take |
|------|--------|-------------|
| P0: Rate Limiter | **A** | Inline pre-claim pattern. No `RateLimitPolicy` interface. No release on execution failure. |
| P1: Parallel Execution | **Hybrid** | B's `ExecutionStrategy` interface + `promiseAllSettledWithConcurrency` worker pool + sugar flags. A's `isSequentialTool` callback for metadata access (replaces B's fragile `(schema as any).sequential`). |
| P1: spawnSubAgent | **A + B** | A's implementation (correct message collection). Add `doneReason` from B's result type. Drop B's hooks and events array. |
| P1: compactIfNeeded | **B** | B's version with `countTokens` parameter. Genuinely useful, minimal cost. |
| P2: MCP Client | **A** | Direct SDK usage. No custom transport abstraction. |

### Estimated Effort (Hybrid)

| Component | Effort |
|-----------|--------|
| P0: Rate limiter fix | 0.5 days |
| P1: Parallel execution (hybrid) | 1.5 days |
| P1: spawnSubAgent (A + doneReason) | 0.5 days |
| P1: compactIfNeeded (B) | 0.5 days |
| P2: MCP client (A) | 2 days |
| Tests (all items) | 1.5 days |
| **Total** | **~6.5 days** |

### Critical Issues Found During Review

1. **A's concurrency cap is buggy** (chunking != true concurrency limiting) — must use B's worker pool
2. **B's spawnSubAgent has a message completeness bug** (missing tool_result messages) — must use A's collection logic
3. **B's MCP transport fights the SDK** (re-implements protocol handling) — must use A's direct SDK approach
4. **B's RateLimitPolicy is scope creep on a P0 fix** — save for a future refactoring PR

### Strengths Worth Acknowledging

- **Proposal A**: Disciplined minimalism. Every change fits existing patterns. The rate limiter security reasoning (no release on execute failure) is correct and well-argued.
- **Proposal B**: The `ExecutionStrategy` pattern is genuinely well-designed — the sugar flags make it zero-cost for simple cases while enabling future extension. The `countTokens` parameter in `compactIfNeeded` shows good API design instincts. The `doneReason` field on `SpawnSubAgentResult` fills a real information gap.

### What to Watch For During Implementation

1. Wire `isSequentialTool` callback through `ExecutionStrategy.execute()` options cleanly — don't let it become a type-unsafe cast
2. Ensure `doneReason` is set correctly in all termination paths of `spawnSubAgent`
3. The `countTokens` parameter should be tested with both sync and async-like scenarios (even though the type is sync)
4. MCP client should pin `@modelcontextprotocol/sdk` to a specific minor version range given protocol instability
