# Technical Skeptic Report: Core Primitives Gap Analysis

**Date**: 2026-04-09
**Author**: Technical Skeptic
**Status**: Phase 1 — Adversarial Requirements Review

---

## Risk-Ranked Ordering (Highest Risk First)

| Rank | Gap | Risk Level | Verdict |
|------|-----|-----------|---------|
| 1 | Gap 2: Auto-Compaction Trigger | **Critical** | Kill it (as proposed) |
| 2 | Gap 1: Sub-Agent / Nested Loop | **High** | Defer — already 80% solved |
| 3 | Gap 3: Parallel Tool Execution | **High** | Defer — premature optimization |
| 4 | Gap 4: MCP Client | **Medium** | Build it (as separate package) |

---

## Gap 1: Sub-Agent / Nested Loop Primitives

### Hidden Complexity

**The orchestration module already exists.** Before writing a single line of sub-agent code, the proposer needs to explain what `createOrchestrator()` (`orchestration/orchestrator.ts`) doesn't already provide:

- Agent registration with parent-child hierarchy (`register(id, name, { parentId })` — line 147)
- Message passing between agents (`send()` — line 210)
- Delegation strategies (`delegate()` — line 256, with pluggable `DelegationStrategy`)
- Shared context store (`SharedContext` — `orchestration/types.ts:46-53`)
- Event system for coordination (`OrchestratorEvent` — 5 event types)

**ContextRelay also exists** (`memory/relay.ts`) — it already handles cross-context handoff with `save()`, `load()`, `checkpoint()`, and `addArtifact()`. This is literally the proposed "context isolation" feature.

The **real** complexity is in what the proposal glosses over:

1. **Abort propagation is a tree problem, not a chain problem.** AgentLoop links to an external `AbortSignal` via a one-time `addEventListener('abort', ...)` (line 71). But nested loops create a tree: aborting a parent must abort all children, but aborting a child must NOT abort the parent. The current signal linkage is one-directional — there's no "detach child" mechanism. If a child loop finishes normally but the parent's signal fires later, the child's abort handler still exists as a dangling listener (no cleanup).

2. **Token budget double-counting.** AgentLoop tracks `cumulativeUsage` (line 48-51). If a parent spawns a child, who owns the token budget? The child's tokens are also the parent's tokens (same API bill). But if the parent's `maxTotalTokens` is 100k and the child uses 60k, does the parent see that? Currently no — `cumulativeUsage` is private and per-instance. You'd need to aggregate across the tree, which means either shared mutable state (concurrency nightmare) or post-hoc merging (inaccurate mid-flight).

3. **Event type collision.** Both parent and child emit `AgentEvent` types. A consumer iterating `parent.run()` would see parent events but NOT child events. To bubble child events, you'd need a new event type (e.g., `{ type: 'sub_agent_event', ... }`) which changes the `AgentEvent` discriminated union — a **breaking change** to every event consumer.

4. **Conversation isolation is trivial; conversation *sharing* is not.** The proposal says "context isolation" like it's a feature. Separate `AgentLoop` instances already have separate `conversation` arrays (line 116). The hard part is sharing context — which messages should a child see? What happens when a child modifies its conversation and the parent needs those results? ContextRelay handles file/progress artifacts, but not live message passing.

### Blast Radius

- Changes `AgentEvent` union type → breaks all event consumers
- May require `AgentLoop.usage` to become externally settable → breaks immutability contract
- Orchestrator module already defines `AgentRegistration` with parent-child — two competing models would fragment the API

### Edge Cases

- Parent aborted while child is mid-LLM-call — child's adapter call is in flight, abort signal may or may not be respected by the HTTP layer
- Child exceeds its token budget — does the parent get an error event or silently continue?
- Recursive nesting: agent spawns sub-agent spawns sub-agent — unbounded depth with unbounded abort listeners
- Child finishes with tool results that the parent's LLM needs — how do those results enter the parent's conversation without violating message ordering?

### Alternatives

**Use the existing orchestration module.** `createOrchestrator({ mode: 'hierarchical' })` + `ContextRelay` already provides 80% of the functionality. The remaining 20% (aggregated token tracking, coordinated abort) can be a thin userland wrapper around two independent `AgentLoop` instances communicating via the orchestrator's `SharedContext`.

### Technical Debt Risk

Embedding nesting into `AgentLoop` itself would make the class responsible for both single-loop execution AND multi-loop coordination. This violates SRP and creates a god object. Every future change to AgentLoop would need to consider nesting implications.

### Verdict: **DEFER**

**Evidence**: The orchestration module (`orchestrator.ts:70-297`) and ContextRelay (`relay.ts:28-139`) already solve the coordination and handoff problems. What's missing is a recipe/example showing how to compose them, not a new primitive. If demand proves the existing modules insufficient, revisit — but do NOT bake nesting into AgentLoop.

---

## Gap 2: Auto-Compaction Trigger Strategy

### Hidden Complexity

**This proposal is architecturally illegal.** Let me be precise:

The proposed `createAutoCompactor({ threshold, strategy })` needs to:
1. Monitor token usage → lives in `observe/cost-tracker.ts`
2. Count message tokens → lives in `context/count-tokens.ts`
3. Trigger compression → lives in `context/compress.ts`
4. Inject into the agent loop → lives in `core/agent-loop.ts`

That's **four modules**. The harness-one architecture explicitly forbids inter-module dependencies (each module depends only on `core/types`). The grep confirms this: **zero cross-module imports exist today** (excluding `core/` and `_internal/`). This would be the first.

**The token counting accuracy problem is real and unsolvable without dependencies.**

The built-in estimator (`_internal/token-estimator.ts:58-78`) uses character-ratio heuristics:
- English text: ~4 chars/token
- CJK: ~1.5 chars/token  
- Code/punctuation: ~3 chars/token

For auto-compaction triggers, accuracy matters enormously. If the heuristic over-estimates by 20%, you compact too early (losing context unnecessarily). If it under-estimates by 20%, you hit the actual context window limit and get an API error. The heuristic has no way to account for:
- Subword tokenization patterns (BPE)
- Special tokens (tool call formatting adds significant overhead)
- Model-specific tokenizer differences

The `registerTokenizer()` escape hatch exists (`count-tokens.ts:71-73`), but it requires the user to bring their own tokenizer — which means adding a dependency like `tiktoken`. This contradicts the zero-dependency principle for anyone who wants accurate auto-compaction.

**The trigger timing is an unsolved problem.** When do you compact?

- Before the LLM call? You don't know how many tokens the response will use.
- After the LLM call? Too late — you already hit the limit.
- Based on the `maxTotalTokens` budget? That's cumulative cost, not context window size — they're different numbers.

AgentLoop already has a `maxConversationMessages` warning (line 152-157), but it counts messages, not tokens. Converting this to token-based would require injecting token counting into the loop — but `countTokens` is in the `context` module, which the loop cannot import.

### Blast Radius

- First cross-module dependency → precedent that erodes the entire architecture
- AgentLoop gains a compression hook → breaks the "simple loop" contract
- Token counting accuracy becomes a correctness concern (silent data loss via premature compaction)

### Edge Cases

- Compaction triggered mid-tool-call-sequence: assistant message references tool call IDs that are in the compacted portion → broken conversation
- `summarize` strategy requires an LLM call to summarize → recursive token usage that itself counts toward the budget
- Compaction removes a `system` message → behavioral drift
- Compaction on a conversation with `pinned` messages (`MessageMeta.pinned`) → preserved messages exceed the budget alone

### Alternatives

**This is an orchestration concern.** The user should wire it themselves:

```typescript
// Userland auto-compaction — no framework changes needed
for await (const event of loop.run(messages)) {
  if (event.type === 'message') {
    const tokens = countTokens('claude-3', messages);
    if (tokens > threshold) {
      messages = await compress(messages, { strategy: 'sliding-window', budget: target });
    }
  }
}
```

This is 5 lines of code. It doesn't need a primitive. It doesn't violate module boundaries. And it lets the user control the timing, strategy, and error handling.

### Technical Debt Risk

Creating `createAutoCompactor` establishes a precedent: "it's okay to create cross-module glue primitives." Next comes `createAutoRetry` (core + observe), then `createSmartRouter` (core + tools + observe). The module boundary erodes incrementally until you have a monolithic framework — exactly what harness-one was designed to avoid.

### Verdict: **KILL IT**

**Evidence**: Zero cross-module imports exist today (`grep` confirms). The functionality is trivially achievable in userland (5 lines). The token counting accuracy problem (`token-estimator.ts:58-78` heuristic) makes automated triggers unreliable without external dependencies. This proposal would be the first crack in the module isolation architecture.

---

## Gap 3: Parallel Tool Execution

### Hidden Complexity

**The sequential loop exists for good reasons.** Look at `agent-loop.ts:237-269`:

```typescript
for (const toolCall of toolCalls) {
  // ...
  result = await this.onToolCall(toolCall);
  // ...
  conversation.push(toolResultMsg);
}
```

The sequential execution guarantees:
1. **Deterministic conversation ordering** — tool results are pushed in the same order as tool calls. LLMs are sensitive to message ordering; reordering can change behavior.
2. **Rate limit compliance** — `registry.ts:98-110` tracks `turnCalls` and `sessionCalls` with simple increment. These are **not atomic** — concurrent `execute()` calls would race on the counters. `turnCalls >= maxPerTurn` with parallel execution means the check-and-increment is a TOCTOU race.
3. **Abort check granularity** — the current loop checks abort after ALL tool calls (line 272). With parallel execution, you'd want to cancel in-flight tools when one fails, but `Promise.all` doesn't cancel other promises when one rejects.

**Tool side effects create ordering dependencies the framework cannot detect.**

Consider tools that: write to the same file, modify shared state (database), depend on each other's output (tool A creates a resource, tool B queries it). The LLM may request both in a single response, expecting sequential execution. Parallel execution silently breaks this assumption.

The framework has no way to know which tools are safe to parallelize. Adding a `parallel: true` flag to `ToolSchema` would shift the burden to tool authors — who will invariably get it wrong.

**Error semantics change fundamentally.**

Sequential: tool 2 fails → tools 3-N never execute → LLM sees partial results and can adapt.
Parallel: tool 2 fails → tools 3-N may already be running → all results arrive, but one is an error. The LLM must handle a mixture of successes and failures, which is a different cognitive pattern.

With `Promise.all`, one rejection aborts the entire batch. With `Promise.allSettled`, you get all results but lose the fail-fast behavior. Neither matches the current sequential semantics.

### Blast Radius

- `ToolRegistry.execute()` rate limiting becomes non-thread-safe (lines 98-110, shared `turnCalls`/`sessionCalls`)
- `AgentEvent` ordering changes — `tool_call` and `tool_result` events currently alternate; parallel execution interleaves them unpredictably
- Every `onToolCall` consumer must become concurrency-safe

### Edge Cases

- LLM sends 5 tool calls; tool 3 takes 30 seconds while 1,2,4,5 complete instantly → conversation push order is non-deterministic
- Rate limiter: `maxCallsPerTurn = 3`, LLM sends 5 calls → with sequential, first 3 succeed, last 2 fail cleanly. With parallel, all 5 check `turnCalls < 3` simultaneously, all pass, all execute
- Tool timeout (`timeoutMs` in registry.ts:160-183): parallel tools each get their own timeout, but the aggregate wall-clock time is the max, not the sum — this changes budget calculations
- Streaming: `handleStream` accumulates tool calls incrementally (line 302-358). Parallel execution of partially-accumulated tool calls could cause races

### Alternatives

**Let userland opt in.** The `onToolCall` handler is already user-provided. A user who wants parallel execution can implement it:

```typescript
onToolCall: async (call) => {
  // User decides parallelism in their handler
  return registry.execute(call);
}
```

Or provide a `createParallelToolHandler(registry, { concurrency: 3 })` utility that wraps the registry — no changes to AgentLoop needed. This keeps the framework simple and lets users who understand their tools' concurrency properties opt in explicitly.

**Is there even a performance problem?** Most tool calls are fast (< 100ms). The bottleneck is the LLM call itself (1-10 seconds). Saving 200ms on parallel tool execution while waiting 5 seconds for the next LLM response is a 3% improvement. Where's the benchmark showing this matters?

### Technical Debt Risk

Parallel execution would require every tool author to think about concurrency, every event consumer to handle non-sequential events, and the rate limiter to use atomic operations. This is a complexity tax on the entire ecosystem for a marginal performance gain.

### Verdict: **DEFER**

**Evidence**: The sequential loop (`agent-loop.ts:237-269`) provides deterministic ordering that LLMs depend on. Rate limiting (`registry.ts:98-110`) uses non-atomic shared state. No benchmark data shows a performance bottleneck. Parallel execution is achievable in userland via a custom `onToolCall` wrapper without framework changes.

---

## Gap 4: MCP Client (Optional Sub-Package)

### Hidden Complexity

**MCP is not just "tools over JSON-RPC."** The Model Context Protocol defines three resource types:
1. **Tools** — map cleanly to `ToolSchema`/`ToolDefinition`
2. **Resources** — arbitrary data blobs (files, database rows) with URI-based addressing — harness-one has NO equivalent concept
3. **Prompts** — reusable prompt templates with arguments — harness-one's `prompt/` module has `PromptTemplate` but with different semantics (template variables, not MCP prompt arguments)

Only tools have a clean mapping. Resources and prompts would either be ignored (incomplete MCP support) or require new core types (scope creep).

**Server lifecycle management is the real beast.**

MCP servers are external processes. The client must:
- Spawn/connect to servers (stdio or HTTP transport)
- Handle server crashes and reconnection
- Manage server capability negotiation
- Track server-side state (some servers are stateful)
- Clean up on client disposal

This is a process management problem, not an API integration problem. It requires child process spawning, health checks, and retry logic — all of which are inherently platform-specific (Node.js `child_process`, Deno `Deno.Command`, etc.) and require runtime dependencies.

**Tool discovery is dynamic and conflicts with the static registry.**

MCP servers can add/remove tools at runtime (via `notifications/tools/list_changed`). The current `ToolRegistry` (`registry.ts`) is designed for static registration — `register()` throws on duplicates (line 67-73) and there's no `unregister()` method. Dynamic tool sets from MCP would need either:
- A separate registry (fragmenting tool lookup)
- Registry modifications to support dynamic add/remove (blast radius on existing code)

### Blast Radius

- As a **separate package** (`@harness-one/mcp`): minimal blast radius on core — this is the right approach
- Would need to depend on at least `@modelcontextprotocol/sdk` (the official MCP SDK) — acceptable for a sub-package
- Core types remain unchanged; MCP adapter translates between MCP tool schemas and `ToolSchema`

### Edge Cases

- MCP server provides a tool with the same name as a locally registered tool → name collision
- MCP server goes down mid-tool-call → error handling must produce a `ToolResult` compatible error
- MCP server returns resources (not tools) → client must decide: ignore, warn, or expose via a new API
- MCP protocol version mismatch → client may negotiate capabilities the server doesn't support
- Multiple MCP servers providing overlapping tool namespaces → need namespacing strategy (e.g., `server.toolName`)

### Alternatives

None — MCP is becoming the standard protocol for tool interop. The question isn't "should we support MCP" but "when and how." A separate package with explicit dependencies is the correct approach and aligns with harness-one's architecture.

### Technical Debt Risk

**Low**, if scoped correctly. The sub-package model means MCP complexity doesn't leak into core. The risk is scope creep: starting with "just tools" and gradually adding resources, prompts, sampling, etc. until the MCP package is larger than core itself.

**Mitigation**: Ship v0.1 with tools-only support. Document that resources and prompts are out of scope. Let demand drive expansion.

### Verdict: **BUILD IT** (as separate package, tools-only v0.1)

**Evidence**: MCP is the emerging standard. The sub-package model (`@harness-one/mcp`) preserves core's zero-dependency principle. Tool-to-ToolSchema mapping is clean. Server lifecycle and non-tool resource types are genuine complexity but can be deferred to later versions.

---

## Challenge Summary

| # | Challenge | Severity | Gap | Status |
|---|----------|----------|-----|--------|
| TC-001 | Orchestration module already provides sub-agent coordination | High | Gap 1 | Open |
| TC-002 | ContextRelay already handles cross-context handoff | High | Gap 1 | Open |
| TC-003 | AbortSignal tree propagation has no detach mechanism | High | Gap 1 | Open |
| TC-004 | Token budget double-counting across nested loops | Medium | Gap 1 | Open |
| TC-005 | AgentEvent union change is breaking | High | Gap 1 | Open |
| TC-006 | Auto-compaction crosses 4 module boundaries | **Critical** | Gap 2 | Open |
| TC-007 | Token heuristic is 20-40% inaccurate for trigger decisions | High | Gap 2 | Open |
| TC-008 | Compaction timing is unsolvable without loop integration | Medium | Gap 2 | Open |
| TC-009 | Achievable in 5 lines of userland code | High | Gap 2 | Open |
| TC-010 | Sets precedent for cross-module primitives | **Critical** | Gap 2 | Open |
| TC-011 | Rate limiter has TOCTOU race under concurrency | High | Gap 3 | Open |
| TC-012 | Tool ordering dependencies are undetectable | High | Gap 3 | Open |
| TC-013 | Error semantics change (fail-fast vs partial) | Medium | Gap 3 | Open |
| TC-014 | No benchmark showing performance bottleneck | High | Gap 3 | Open |
| TC-015 | AgentEvent ordering becomes non-deterministic | Medium | Gap 3 | Open |
| TC-016 | MCP resources/prompts have no core equivalent | Medium | Gap 4 | Open |
| TC-017 | Server lifecycle is process management complexity | Medium | Gap 4 | Open |
| TC-018 | Dynamic tool discovery vs static ToolRegistry | Medium | Gap 4 | Open |

## Final Assessment

**Overall Feasibility**: 1 of 4 gaps should be built. 2 should be deferred. 1 should be killed.

**Key Insight**: harness-one's greatest strength is its module isolation (zero cross-module imports confirmed via codebase grep). Two of these proposals (Gap 1 partially, Gap 2 entirely) would compromise this architecture. The framework should provide composable primitives and let users wire them together — not build cross-cutting orchestration into core.

**Recommendation**: PROCEED WITH CAUTION

**Conditions**:
1. Gap 4 (MCP) proceeds as `@harness-one/mcp` with tools-only scope
2. Gap 2 (Auto-Compaction) is killed — document the 5-line userland pattern instead
3. Gap 1 (Sub-Agent) is deferred — write a cookbook/example using existing orchestrator + ContextRelay
4. Gap 3 (Parallel Tools) is deferred — provide a `createParallelToolHandler` utility if benchmarks show need
