# Product Advocate Report: Core Primitives Gaps Analysis

**Version**: 1.0
**Date**: 2026-04-09
**Status**: Draft (Adversarial Review Pending)
**Author**: product-advocate

---

## Executive Summary

Four gaps have been identified in harness-one's core primitives. This report evaluates each from a **user value, feasibility, and delivery** perspective. The priority ranking is:

1. **Gap 3: Parallel Tool Execution** — highest impact-to-effort ratio; unblocks real-world performance
2. **Gap 1: Sub-Agent / Nested Loop Primitives** — critical for agentic workflows, but orchestration module partially addresses it
3. **Gap 2: Auto-Compaction Trigger Strategy** — essential for long-running agents; moderate effort
4. **Gap 4: MCP Client** — important for ecosystem, but lower urgency; fits existing integration pattern

---

## Gap 1: Sub-Agent / Nested Loop Primitives

### 1. User Value

**Who benefits**: Agent builders creating multi-step research agents, coding agents with sub-tasks, customer service agents with handoff/escalation flows, and any workflow requiring "delegate then resume."

**How critical**: **High**. Modern agent architectures (ReAct + delegation, hierarchical planning, tool-as-agent patterns) require the ability to spawn a child agent with isolated context. Without this, builders either:
- Pollute parent context with child work (token waste, confusion)
- Build custom orchestration outside the framework (framework leakage)
- Use the existing `AgentOrchestrator` module, which provides multi-agent coordination but at a higher abstraction level than what many users need

**Real-world scenarios**:
- Research agent spawns a sub-agent to deep-dive a specific topic, gets back a summary
- Coding agent delegates file analysis to a focused sub-agent with only relevant files in context
- Customer service agent hands off to specialist, receives resolution summary

### 2. Feasibility

**Complexity**: Medium-High

**Current state**: AgentLoop is a self-contained class. No nesting support. The `AgentOrchestrator` at `/packages/core/src/orchestration/orchestrator.ts` provides multi-agent coordination with hierarchical/peer modes and delegation strategies, but it operates at a higher level — users want a simple "spawn, run, collect" primitive at the AgentLoop level.

**Blast radius**: Low-Medium. The primitive can be additive:
- AgentLoop itself doesn't need modification if we implement `spawnSubAgent()` as a utility that creates a new AgentLoop instance with isolated config
- Tool registry isolation is straightforward (create child registry or share read-only)
- Context isolation is the main design challenge: parent shouldn't see child's intermediate steps, only the final summary
- AbortSignal propagation (parent abort should cascade to children) is well-supported by existing AbortController pattern

**Key technical considerations**:
- Token budget partitioning: child needs a budget slice, not unlimited access
- Cost tracking: child usage must roll up to parent's CostTracker
- Observability: child spans should nest under parent trace (existing Span.parentId supports this)

### 3. Priority

**Must-have for v1**: No, but strongly recommended. The `AgentOrchestrator` module provides a workaround, but the gap between "I want to spawn a quick sub-agent in a tool call" and "I need to set up a full orchestrator" is significant. A lightweight primitive bridges this gap.

**Recommendation**: P1 — include in v1 as a convenience API layered on top of AgentLoop + orchestration primitives.

### 4. Scope Risk

**Where scope creep happens**:
- Shared memory/state between parent and child (keep it summary-only for v1)
- Complex lifecycle management (child retry, child timeout separate from parent)
- Inter-agent communication channels (message passing, streaming child events to parent)
- Dynamic child spawning (agent decides at runtime how many children to spawn)

**Explicit exclusions for v1**:
- No shared mutable state between parent and child
- No child-to-child communication (only parent-child)
- No dynamic fan-out (spawn N children based on runtime data) — use orchestrator for that
- No persistent child sessions (child is ephemeral, runs to completion)

### 5. Proposed API Surface

```typescript
// Option A: Utility function (preferred — aligns with factory-function philosophy)
import { spawnSubAgent } from 'harness-one/core';

const result = await spawnSubAgent({
  adapter,                          // Required: LLM adapter (can share parent's)
  messages: [                       // Initial context for child
    { role: 'system', content: 'You are a research specialist...' },
    { role: 'user', content: 'Analyze the impact of X on Y' },
  ],
  tools?: childTools,               // Optional: child's available tools
  onToolCall?: childToolHandler,    // Optional: child's tool handler
  maxIterations?: 10,               // Default: 10 (lower than parent default of 25)
  maxTotalTokens?: 4000,            // Budget slice
  signal?: parentSignal,            // Cascade abort from parent
  summarize?: (messages) => string, // Optional: how to extract summary from child conversation
});

// result: { messages: Message[], summary: string, usage: TokenUsage }
```

```typescript
// Option B: AgentLoop method (if we want tighter integration)
const childResult = await parentLoop.spawnChild({
  // ... same config minus adapter (inherits parent's)
  budgetFraction?: 0.2,  // Use 20% of parent's remaining budget
});
```

**Recommendation**: Option A. It's a pure function, testable, composable, and doesn't bloat AgentLoop. Users can call it inside their `onToolCall` handler to make any tool "agentic."

---

## Gap 2: Auto-Compaction Trigger Strategy

### 1. User Value

**Who benefits**: Any agent builder running long conversations (customer support, iterative coding, research, tutoring). Currently, developers must manually call `compress()` — this means they need to:
1. Track token usage themselves
2. Decide when to compress
3. Wire up the compression call at the right point in the loop

**How critical**: **Medium-High**. Long-running agents without auto-compaction either:
- Hit context window limits and crash
- Accumulate cost from sending bloated context to the LLM
- Require manual plumbing that every user reinvents

This is a "table stakes" feature for production agent frameworks. LangChain, CrewAI, and similar frameworks all provide automatic context management.

**Real-world scenarios**:
- Customer support agent handling a 45-minute session with 200+ messages
- Coding agent iterating through test-fix cycles over 50+ iterations
- Research agent accumulating findings across many tool calls

### 2. Feasibility

**Complexity**: Low-Medium

**Current state**: All building blocks exist:
- `compress()` is a pure function with 4 strategies at `/packages/core/src/context/compress.ts`
- `estimateTokens()` / `countTokens()` exists in `_internal/token-estimator.ts`
- CostTracker has budget alerts with configurable thresholds at `/packages/core/src/observe/cost-tracker.ts`
- AgentLoop yields events including `TokenUsage` on every iteration

**What's missing**: The glue. A component that monitors token usage per iteration and triggers compression when a threshold is crossed.

**Blast radius**: Very Low. This is purely additive:
- New factory function `createAutoCompactor()` in the context module
- No changes to AgentLoop required if implemented as middleware or event listener
- Alternatively, a small hook point in AgentLoop's iteration loop (before LLM call, check context size)

### 3. Priority

**Must-have for v1**: Yes. Without this, every user building a non-trivial agent must implement their own compaction logic. This is the single most common "boilerplate" complaint in agent frameworks.

**Recommendation**: P0 — ship in v1 core.

### 4. Scope Risk

**Where scope creep happens**:
- Adaptive strategy selection (auto-choose between truncate/summarize based on content) — defer
- ML-based importance scoring for which messages to keep — defer
- Multi-model token counting (different models have different tokenizers) — partially addressed by `registerTokenizer()`
- Compaction history / audit trail — defer

**Explicit exclusions for v1**:
- No adaptive strategy selection (user picks one strategy)
- No importance scoring beyond the existing `preserve` predicate
- No compaction-aware caching (re-caching after compaction is a separate concern)
- No "undo compaction" capability

### 5. Proposed API Surface

```typescript
import { createAutoCompactor } from 'harness-one/context';

const compactor = createAutoCompactor({
  threshold: 0.75,                     // Trigger when context hits 75% of budget
  budget: 100_000,                     // Total token budget (or derive from model)
  strategy: 'sliding-window',          // Which compression strategy to use
  windowSize?: 20,                     // Strategy-specific config
  preserve?: (msg) => msg.role === 'system',  // Never compress these
  summarizer?: async (msgs) => '...',  // Required if strategy is 'summarize'
  onCompact?: (before, after) => {},   // Callback for observability
});

// Usage Option A: Wrap messages before each LLM call
const compactedMessages = await compactor.compact(messages);

// Usage Option B: Integration with AgentLoop via middleware
const loop = new AgentLoop({
  adapter,
  middleware: [compactor.middleware()],  // Auto-compacts before each LLM call
});

// Usage Option C: Event-driven (listen to AgentLoop events)
for await (const event of loop.run(messages)) {
  if (event.type === 'iteration_start') {
    messages = await compactor.compactIfNeeded(messages, event);
  }
}
```

**Recommendation**: Option A as the core primitive (pure function, easy to test), with Option B as a convenience for AgentLoop users. The middleware pattern already exists in the codebase at `/packages/core/src/core/middleware.ts`.

---

## Gap 3: Parallel Tool Execution

### 1. User Value

**Who benefits**: Every agent builder whose tools have I/O latency (API calls, file operations, database queries, web searches). This is virtually all real-world agent use cases.

**How critical**: **Very High**. This is the single highest-impact performance improvement possible:
- Modern LLMs (Claude, GPT-4) routinely emit 2-5 parallel tool calls per turn
- Sequential execution means a turn with 3 API-calling tools that each take 2s = 6s total
- Parallel execution: same turn = ~2s (3x speedup)
- For agents with many iterations, this compounds dramatically

**Real-world impact**:
- Coding agent: `read_file` + `list_directory` + `search_code` in parallel = 3x faster exploration
- Research agent: `web_search` + `fetch_url` + `database_query` in parallel = 3x faster research
- Data agent: `query_table_a` + `query_table_b` + `query_table_c` = 3x faster analysis

**Competitive context**: This is standard in LangChain, Vercel AI SDK, and other frameworks. Not supporting it is a notable gap.

### 2. Feasibility

**Complexity**: Low

**Current state**: The sequential `for...of` loop at agent-loop.ts line 237 is the only blocker:
```typescript
for (const toolCall of toolCalls) {
  // ... await this.onToolCall(toolCall) ...
}
```

Changing this to `Promise.all()` / `Promise.allSettled()` is mechanically simple.

**Considerations**:
- **Rate limiting**: The tool registry already has per-turn and per-session limits. These need to account for concurrent calls (decrement atomically or pre-check batch size).
- **Error isolation**: One tool failure shouldn't abort other in-flight tools. `Promise.allSettled()` handles this naturally.
- **Event ordering**: Tool call/result events will interleave. Consumers must handle non-sequential events. This is a minor contract change.
- **Resource contention**: If tools share resources (file handles, DB connections), parallel execution could cause conflicts. This is the tool author's responsibility, not the framework's.
- **Opt-in**: Should be opt-in to avoid breaking existing users who depend on sequential execution order.

**Blast radius**: Low. Changes are contained to AgentLoop's tool execution block (~30 lines). Event consumers need to handle interleaved tool events, but this is a natural expectation for parallel execution.

### 3. Priority

**Must-have for v1**: Yes. This is table stakes for a production agent framework. The performance difference is too significant to defer.

**Recommendation**: P0 — ship in v1 core.

### 4. Scope Risk

**Where scope creep happens**:
- Dependency analysis between tool calls (tool B depends on tool A's output) — defer, LLMs don't emit dependent parallel calls
- Configurable concurrency limits (max 3 parallel) — simple to add, include in v1
- Tool-level parallelism annotations (tool declares "I'm safe to parallelize") — unnecessary, all tools should be safe
- Streaming results as tools complete (progressive rendering) — nice-to-have, defer

**Explicit exclusions for v1**:
- No dependency graph analysis between tool calls
- No tool-level parallelism opt-out (use sequential mode instead)
- No partial-result streaming (all results collected before next iteration)

### 5. Proposed API Surface

```typescript
// AgentLoopConfig addition
const loop = new AgentLoop({
  adapter,
  onToolCall: registry.handler(),
  tools: registry.schemas(),
  parallel: true,                    // Enable parallel tool execution (default: false)
  maxParallelToolCalls?: 5,          // Optional concurrency limit
});
```

**Internal implementation sketch**:
```typescript
// In AgentLoop.run(), replace sequential loop with:
if (this.parallel) {
  const results = await Promise.allSettled(
    toolCalls.map(async (toolCall) => {
      yield { type: 'tool_call', toolCall, iteration };
      const result = await this.onToolCall(toolCall);
      yield { type: 'tool_result', toolCallId: toolCall.id, result };
      return { toolCall, result };
    })
  );
  // Add all tool results to conversation
  for (const r of results) { /* ... */ }
} else {
  // Existing sequential loop (unchanged)
}
```

Note: The `yield` inside `Promise.allSettled` won't work directly in an async generator. The actual implementation will need to collect events and yield them after all tools complete, or use a channel/queue pattern. This is a known implementation detail, not a design concern.

---

## Gap 4: MCP Client (Optional Sub-Package)

### 1. User Value

**Who benefits**: Agent builders who want to connect to MCP-compatible tool servers (IDE integrations, enterprise tool systems, third-party tool marketplaces). MCP is gaining traction as the standard protocol for tool interoperability.

**How critical**: **Medium**. MCP adoption is growing but not yet universal:
- Claude Desktop, Cursor, Windsurf, and other IDE tools use MCP
- Enterprise tool providers are starting to publish MCP servers
- However, most agent builders today still define tools directly in code
- MCP's value increases as the ecosystem grows — early support positions harness-one well

**Real-world scenarios**:
- Agent connects to a company's internal MCP tool server (database queries, ticketing, etc.)
- Agent uses MCP to access tools from multiple IDE extensions
- Agent builder publishes their harness-one tools as an MCP server (bidirectional value)

### 2. Feasibility

**Complexity**: Medium

**Current state**: No MCP support exists. However, the integration package pattern is well-established:
- `@harness-one/anthropic`, `@harness-one/openai` use peer dependencies
- `@harness-one/langfuse`, `@harness-one/redis` show the optional-dependency pattern
- Tool registry's `ToolDefinition` interface maps cleanly to MCP's tool schema

**What's needed**:
- JSON-RPC 2.0 client (small, can be implemented without dependencies or use a lightweight dep)
- Transport layer: stdio (for local MCP servers) and SSE/HTTP (for remote servers)
- Tool discovery: MCP `tools/list` → harness-one `ToolDefinition[]` mapping
- Tool execution: harness-one `ToolCallRequest` → MCP `tools/call` → harness-one `ToolResult`

**Blast radius**: Zero on core. This is a completely separate package (`@harness-one/mcp`) with explicit dependencies, following the established integration pattern.

### 3. Priority

**Must-have for v1**: No. MCP is important for ecosystem positioning but not required for core agent functionality. Users can build agents without MCP and add it later.

**Recommendation**: P2 — plan for v1.1 or as a community contribution. However, ensure the tool registry interface is MCP-compatible so that future integration is seamless.

### 4. Scope Risk

**Where scope creep happens**:
- MCP Server (exposing harness-one tools as MCP) — defer, start with client only
- Resource management (MCP resources, prompts, sampling) — defer, start with tools only
- Multi-server management (connecting to N MCP servers simultaneously) — include basic support
- Authentication/authorization for remote MCP servers — defer to transport layer
- MCP protocol evolution (spec is still evolving) — risk of API churn

**Explicit exclusions for v1**:
- No MCP server implementation (client only)
- No MCP resources or prompts support (tools only)
- No MCP sampling support
- No custom transport plugins (stdio + SSE only)

### 5. Proposed API Surface

```typescript
import { createMCPClient } from '@harness-one/mcp';

// Connect to a local MCP server
const client = await createMCPClient({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
});

// Or connect to a remote MCP server
const client = await createMCPClient({
  transport: 'sse',
  url: 'https://mcp.example.com/sse',
  headers: { 'Authorization': 'Bearer ...' },
});

// Discover tools and register with harness-one
const tools = await client.listTools();           // MCP tools/list
const registry = createRegistry();
for (const tool of tools) {
  registry.register(client.toToolDefinition(tool)); // MCP → harness-one ToolDefinition
}

// Use with AgentLoop as normal
const loop = new AgentLoop({
  adapter,
  onToolCall: registry.handler(),
  tools: registry.schemas(),
});

// Cleanup
await client.close();
```

---

## Overall Priority Ranking

| Rank | Gap | Priority | Rationale |
|------|-----|----------|-----------|
| 1 | **Gap 3: Parallel Tool Execution** | P0 | Highest impact-to-effort ratio. Low complexity, massive performance gain for every user. Table stakes for production frameworks. |
| 2 | **Gap 2: Auto-Compaction Trigger** | P0 | Essential for long-running agents. All building blocks exist; just needs the glue. Eliminates the most common boilerplate. |
| 3 | **Gap 1: Sub-Agent Primitives** | P1 | High value for advanced use cases. Orchestrator provides partial coverage. Careful scoping needed to avoid over-engineering. |
| 4 | **Gap 4: MCP Client** | P2 | Strategic for ecosystem positioning. Zero core impact (separate package). Can ship post-v1 without blocking anyone. |

### Key Arguments

1. **Ship P0s together**: Parallel tools + auto-compaction are force multipliers. Parallel tools make agents faster; auto-compaction makes them run longer. Together, they unlock production-grade agent performance.

2. **Sub-agent primitive should be lean**: The biggest risk is over-engineering. A simple `spawnSubAgent()` function that creates a new AgentLoop, runs it, and returns the result is 90% of the value. Don't build a full agent lifecycle manager.

3. **MCP can wait, but plan for it**: Ensure `ToolDefinition` and `ToolRegistry` interfaces don't accidentally make MCP integration harder. The current interfaces look MCP-compatible — preserve this.

4. **User value metric**: If we ship all four gaps, a harness-one user can build a multi-agent system with parallel tool execution, automatic context management, and external tool integration — all with zero runtime dependencies in core. That's a compelling v1 story.

---

## Open Questions

1. **Parallel tool execution + rate limiting**: Should the rate limiter pre-check the entire batch, or check per-tool-call (potentially failing mid-batch)?
2. **Auto-compaction + streaming**: When compaction triggers mid-stream, should we re-send the compacted context or wait for the current iteration to complete?
3. **Sub-agent budget**: Fixed allocation (e.g., 4000 tokens) or fractional (e.g., 20% of parent's remaining budget)?
4. **MCP protocol version**: Which MCP spec version to target? The protocol is still evolving.

---

## Confidence Assessment

| Gap | Confidence in Analysis | Key Uncertainty |
|-----|----------------------|-----------------|
| Gap 1: Sub-Agent | 7/10 | Scope boundary with existing orchestrator module |
| Gap 2: Auto-Compaction | 9/10 | Low uncertainty; building blocks are well understood |
| Gap 3: Parallel Tools | 9/10 | Low uncertainty; main question is event ordering contract |
| Gap 4: MCP Client | 6/10 | MCP spec evolution; unclear adoption trajectory |
