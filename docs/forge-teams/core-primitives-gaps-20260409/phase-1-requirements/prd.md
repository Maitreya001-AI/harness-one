# PRD: harness-one Core Primitives — Post-Debate Consensus

**Version**: 2.0 (Post-adversarial debate)  
**Date**: 2026-04-09  
**Status**: Consensus PRD  
**Debate rounds**: 1 (strong convergence)

---

## Executive Summary

After adversarial debate between Product Advocate and Technical Skeptic, the original 5-gap proposal was refined to:

- **1 pre-existing**: Streaming AgentLoop (already implemented)
- **1 bug fix**: Rate limiter TOCTOU race condition (P0)
- **1 core feature**: Parallel tool execution (P1)  
- **1 separate package**: MCP client (P2)
- **2 documentation recipes**: Auto-compaction pattern, sub-agent pattern

The debate's key insight: **module isolation is harness-one's architectural moat**. Features requiring cross-module imports belong in `harness-one-full` or userland, not core.

---

## What Ships

> **Late revision**: Advocate's final submission restored `spawnSubAgent()` and `compactIfNeeded()` as lightweight helpers within their respective modules (no cross-module imports). Both sides agreed on this framing. PRD updated to include them as P1 items.

### 1. Rate Limiter TOCTOU Fix (P0 — Bug Fix)

**Problem**: `registry.ts` rate limiter uses non-atomic check-then-increment. Under concurrent `execute()` calls (already possible in userland), `maxPerTurn` and `maxPerSession` limits can be silently exceeded.

**Fix**: Pre-claim pattern — move counter increment before the first `await`, decrement on failure.

```typescript
// Before (vulnerable):
if (turnCalls >= maxPerTurn) return error;  // CHECK
// ... async validation, permission, execution ...
turnCalls++;  // INCREMENT (after async gap = TOCTOU)

// After (safe):
if (turnCalls >= maxPerTurn) return error;
turnCalls++; sessionCalls++;  // CLAIM before async
try {
  // ... async validation, permission, execution ...
} catch {
  turnCalls--; sessionCalls--;  // RELEASE on failure
}
```

**Scope**: ~15 lines changed in `registry.ts`. No API changes. No new tests beyond TOCTOU regression test.

**Rationale**: This is a correctness bug independent of the parallel execution feature. Should ship even if parallel execution is deferred.

---

### 2. Parallel Tool Execution (P1 — Core Feature)

**Problem**: AgentLoop processes tool calls sequentially (`agent-loop.ts:237-269`). For I/O-bound tools (API calls, database queries, web search), this causes unnecessary latency. 3 tools × 2s each = 6s sequential vs ~2s parallel.

**Solution**: Opt-in parallel execution with safety guardrails.

#### API Surface

```typescript
// AgentLoopConfig addition
interface AgentLoopConfig {
  // ... existing fields ...
  parallel?: boolean;              // Enable parallel tool execution (default: false)
  maxParallelToolCalls?: number;   // Concurrency cap (default: 5)
}

// ToolDefinition addition (optional)
interface ToolDefinition<T> {
  // ... existing fields ...
  sequential?: boolean;  // Force sequential execution even in parallel mode (default: false)
}
```

#### Behavior

1. When `parallel: false` (default): No change. Sequential execution as today.
2. When `parallel: true`:
   - Partition tool calls into two groups:
     - **Parallel group**: tools where `sequential !== true`
     - **Sequential group**: tools where `sequential === true`
   - Execute parallel group with `Promise.allSettled()` (concurrency capped by `maxParallelToolCalls`)
   - Execute sequential group one-by-one after parallel group completes
   - **Event batching**: Collect all `tool_call` events, yield them, then collect all `tool_result` events and yield them in original tool-call order (deterministic)
   - **Conversation ordering**: Tool result messages pushed in original tool-call order regardless of completion order

#### Constraints

- Rate limiter must be fixed first (P0 dependency)
- Default is `false` — zero breaking changes for existing users
- `sequential: true` on ToolDefinition is opt-out safety valve for tools with side effects
- Maximum 5 concurrent tool calls by default (configurable)

#### Files Changed

- `packages/core/src/core/agent-loop.ts` — parallel execution path (~40 lines)
- `packages/core/src/tools/types.ts` — `sequential?: boolean` on ToolDefinition
- `packages/core/src/tools/registry.ts` — rate limiter TOCTOU fix (P0)

#### Out of Scope

- Dependency analysis between tool calls
- Streaming/progressive results as tools complete
- Per-tool concurrency limits
- Automatic parallelism detection

---

### 3. MCP Client (P2 — Separate Package)

**Problem**: No MCP (Model Context Protocol) support. MCP is the emerging standard for tool interoperability (Claude Desktop, Cursor, enterprise tool servers).

**Solution**: `@harness-one/mcp` as an independent package with explicit dependencies, following the established integration pattern (`@harness-one/anthropic`, `@harness-one/openai`).

#### API Surface

```typescript
import { createMCPClient } from '@harness-one/mcp';

// Connect to MCP server
const client = await createMCPClient({
  transport: 'stdio',           // or 'sse'
  command: 'npx',               // stdio: command to spawn
  args: ['-y', '@mcp/server'],  // stdio: command args
  // url: 'https://...',        // sse: server URL
  // headers: {},               // sse: auth headers
});

// Discover tools → harness-one ToolDefinition[]
const tools = await client.listTools();
const definitions = tools.map(t => client.toToolDefinition(t));

// Register with existing tool registry
const registry = createRegistry();
definitions.forEach(d => registry.register(d));

// Use with AgentLoop as normal
const loop = new AgentLoop({
  adapter,
  onToolCall: registry.handler(),
  tools: registry.schemas(),
});

// Cleanup
await client.close();
```

#### Scope — v0.1 (Tools Only)

| In Scope | Out of Scope |
|----------|-------------|
| MCP `tools/list` discovery | MCP Resources |
| MCP `tools/call` execution | MCP Prompts |
| stdio transport | MCP Sampling |
| SSE/HTTP transport | Custom transport plugins |
| Tool → ToolDefinition mapping | MCP Server (exposing tools) |
| Dot-notation namespacing (`server.toolName`) | Authentication/authorization |
| Server lifecycle (spawn, connect, close) | Multi-server orchestration |
| Error mapping to ToolResult | Dynamic tool list change notifications |

#### Dependencies

- `@modelcontextprotocol/sdk` (peer dependency)
- Core package remains zero-dependency

#### Namespace Strategy

MCP tools registered with dot-notation namespace: `{serverName}.{toolName}`. Leverages existing `registry.list(namespace)` support. Prevents collision with locally-registered tools.

#### Files Created

- `packages/mcp/` — new package directory
- `packages/mcp/src/client.ts` — MCP client factory
- `packages/mcp/src/transport/` — stdio and SSE transports
- `packages/mcp/src/mapping.ts` — MCP schema ↔ ToolDefinition conversion

---

### 4. `spawnSubAgent()` Utility (P1 — Orchestration Module)

**Problem**: "Spawn child agent, run to completion, get summary" is a universal pattern. The orchestrator + ContextRelay provide the primitives, but the boilerplate is ~15 lines. A convenience utility bridges the ergonomics gap.

**Solution**: Pure utility function in `orchestration/` module. No changes to AgentLoop, no new event types, no cross-module imports.

#### API Surface

```typescript
import { spawnSubAgent } from 'harness-one/orchestration';

const result = await spawnSubAgent({
  adapter,                          // Required: LLM adapter
  messages: [                       // Initial context for child
    { role: 'system', content: 'You are a research specialist...' },
    { role: 'user', content: 'Analyze the impact of X on Y' },
  ],
  tools?: childTools,               // Optional: child's available tools
  onToolCall?: childToolHandler,    // Optional: child's tool handler
  maxIterations?: 10,               // Default: 10
  maxTotalTokens?: 4000,            // Budget slice
  signal?: parentSignal,            // Cascade abort from parent
});

// result: { messages: Message[], usage: TokenUsage }
// result is frozen (Object.freeze)
```

#### Constraints

- Child conversation is fully isolated — no shared mutable state
- Return value is frozen (consistent with project conventions)
- `signal` parameter links child abort to parent
- Child's `usage` is returned for caller to aggregate into parent budget (if desired)
- Lives in `orchestration/` module (coordination logic, not core)

#### Files Changed

- `packages/core/src/orchestration/spawn.ts` — new file (~40 LOC)
- `packages/core/src/orchestration/index.ts` — re-export

---

### 5. `compactIfNeeded()` Helper (P1 — Context Module)

**Problem**: Auto-compaction is a 5-line pattern, but every user writes it. A thin helper in the context module reduces boilerplate without violating module boundaries.

**Solution**: One-liner wrapper around existing `compress()` + `estimateTokens()` in `context/compress.ts`.

#### API Surface

```typescript
import { compactIfNeeded } from 'harness-one/context';

// Returns messages unchanged if under threshold, compressed if over
const result = await compactIfNeeded(messages, {
  budget: 100_000,                    // Total token budget
  threshold?: 0.75,                   // Trigger at 75% (default)
  strategy: 'sliding-window',         // Compression strategy
  windowSize?: 20,                    // Strategy-specific config
  preserve?: (msg) => msg.role === 'system',  // Never compress these
  summarizer?: async (msgs) => '...', // Required if strategy is 'summarize'
});
```

#### Constraints

- Lives in `context/compress.ts` alongside `compress()` — no new files
- Takes explicit parameters only — no implicit state, no imports from `observe/` or `core/`
- Uses existing `estimateTokens()` from `_internal/` (already imported by context module)
- Documentation includes the manual 5-line pattern for users who want full control
- Documents token estimation accuracy margin (~20-40%) — users wanting precision should register a real tokenizer via `registerTokenizer()`

#### Files Changed

- `packages/core/src/context/compress.ts` — add `compactIfNeeded()` (~15 LOC)

---

### 6. Documentation Recipes (Docs Only)

Full manual patterns documented for users who want complete control:

#### Recipe: Manual Auto-Compaction Loop

```typescript
for await (const event of loop.run(messages)) {
  if (event.type === 'iteration_start') {
    messages = await compactIfNeeded(messages, {
      budget: 100_000,
      strategy: 'sliding-window',
    });
  }
}
```

#### Recipe: Advanced Sub-Agent with ContextRelay

For users needing persistence, checkpointing, or multi-agent coordination beyond `spawnSubAgent()`, the full orchestrator + ContextRelay pattern is documented with working examples.

---

## Priority & Sequencing

| Priority | Item | Type | Estimated Scope |
|----------|------|------|-----------------|
| P0 | Rate limiter TOCTOU fix | Bug fix | ~15 LOC in registry.ts |
| P1 | Parallel tool execution | Feature | ~80 LOC across 3 files |
| P1 | `spawnSubAgent()` utility | Feature | ~40 LOC in orchestration/ |
| P1 | `compactIfNeeded()` helper | Feature | ~15 LOC in context/compress.ts |
| P2 | MCP client package | New package | ~400 LOC new package |
| Docs | Advanced recipes | Documentation | Recipes in docs |

**Dependencies**: 
- P1 (Parallel Tools) depends on P0 (Rate Limiter Fix)
- P1 (spawnSubAgent) and P1 (compactIfNeeded) are independent — can ship in parallel

---

## Acceptance Criteria

### P0: Rate Limiter Fix
- [ ] `turnCalls` and `sessionCalls` increment before first async operation
- [ ] Counters decrement on execution failure
- [ ] Test: concurrent `execute()` calls respect `maxPerTurn` limit
- [ ] No API changes

### P1: Parallel Tool Execution
- [ ] `parallel: boolean` config on AgentLoopConfig (default `false`)
- [ ] `maxParallelToolCalls: number` config (default 5)
- [ ] `sequential: boolean` on ToolDefinition (default `false`)
- [ ] Tools with `sequential: true` execute after parallel group completes
- [ ] `Promise.allSettled()` for parallel group
- [ ] Tool result conversation messages in original call order
- [ ] AgentEvents in deterministic order (all tool_calls, then all tool_results)
- [ ] Existing sequential behavior unchanged when `parallel: false`
- [ ] Tests: parallel execution, sequential fallback, mixed mode, rate limit compliance, error isolation

### P2: MCP Client
- [ ] `createMCPClient()` factory function
- [ ] stdio transport (spawn child process)
- [ ] SSE transport (HTTP connection)
- [ ] `listTools()` → ToolDefinition[] mapping
- [ ] Tool execution via MCP `tools/call`
- [ ] Dot-notation namespace (`server.toolName`)
- [ ] `close()` for cleanup
- [ ] Zero impact on core package dependencies
- [ ] Tests: connection, discovery, execution, error handling, cleanup

### P1: spawnSubAgent()
- [ ] Pure utility function in `orchestration/spawn.ts`
- [ ] Creates new AgentLoop, runs to completion, returns `{ messages, usage }`
- [ ] Return value frozen with `Object.freeze()`
- [ ] `signal` parameter for abort cascade from parent
- [ ] Child conversation fully isolated — no shared mutable state
- [ ] Tests: basic spawn, abort propagation, token usage aggregation, tool calls in child

### P1: compactIfNeeded()
- [ ] Helper function in `context/compress.ts`
- [ ] Returns messages unchanged if under threshold, compressed if over
- [ ] No imports from `observe/` or `core/` — only uses existing `_internal/` and `context/` code
- [ ] Threshold default 0.75
- [ ] Documentation includes accuracy margin warning for token heuristic
- [ ] Documentation includes manual 5-line pattern for full control
- [ ] Tests: under-threshold passthrough, over-threshold compression, preserve predicate

### Docs: Recipes
- [ ] Advanced sub-agent pattern with orchestrator + ContextRelay
- [ ] Manual auto-compaction loop pattern

---

## Architectural Principles Upheld

1. **Zero cross-module imports** — no new inter-module dependencies introduced
2. **Zero runtime dependencies in core** — MCP deps isolated to `@harness-one/mcp`
3. **Opt-in complexity** — parallel execution defaults to off
4. **Errors as data** — parallel tool failures returned as ToolResult, not thrown
5. **Composability** — recipes show how to compose existing primitives
