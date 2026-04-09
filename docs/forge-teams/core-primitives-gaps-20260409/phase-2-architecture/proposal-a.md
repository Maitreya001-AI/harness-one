# Architecture Proposal A: Minimal Change, Maximum Safety

**Architect**: Architect A (Simplicity)  
**PRD Reference**: `docs/forge-teams/core-primitives-gaps-20260409/phase-1-requirements/prd.md`  
**Date**: 2026-04-09  
**Status**: Competing (Round 1)

---

## Executive Summary

This proposal achieves all 5 PRD items with the **smallest possible diff** — roughly 150 LOC of new logic across 6 files, zero new dependencies, zero new abstractions. Every change follows an existing pattern already in the codebase. The guiding principle: if it fits in the existing function, don't create a new file; if it fits in one line, don't create a helper.

---

## 1. Rate Limiter TOCTOU Fix (P0)

### Problem

`registry.ts:96-111` checks `turnCalls >= maxPerTurn` and `sessionCalls >= maxPerSession`, then increments at line 158-159 — after multiple `await` points (JSON parse, validation, permission check, tool execution). Concurrent `execute()` calls pass the check before any increment.

### Design

**Pre-claim pattern**: Move increments to immediately after the rate-limit check, before any async operations. Decrement on early-return paths (validation failure, permission denial) and on execution error.

### Implementation

```typescript
// registry.ts — execute() function, lines ~96-184
async function execute(call: ToolCallRequest): Promise<ToolResult> {
  // Rate limiting — unchanged checks
  if (turnCalls >= maxPerTurn) {
    return toolError(
      `Exceeded max calls per turn (${maxPerTurn})`,
      'validation',
      'Wait for the next turn or reduce tool calls',
    );
  }
  if (sessionCalls >= maxPerSession) {
    return toolError(
      `Exceeded max calls per session (${maxPerSession})`,
      'validation',
      'Start a new session or reduce tool calls',
    );
  }

  // PRE-CLAIM: increment before any async gap
  turnCalls++;
  sessionCalls++;

  // Lookup
  const tool = tools.get(call.name);
  if (!tool) {
    turnCalls--; sessionCalls--;  // RELEASE — not a real call
    return toolError(
      `Tool "${call.name}" not found`,
      'not_found',
      'Check the tool name and ensure it is registered',
    );
  }

  // Parse arguments
  let params: unknown;
  try {
    params = JSON.parse(call.arguments);
  } catch {
    turnCalls--; sessionCalls--;  // RELEASE — invalid input
    return toolError(
      'Invalid JSON in tool call arguments',
      'validation',
      'Ensure arguments is valid JSON',
    );
  }

  // Validate
  const validation = customValidator
    ? customValidator.validate(tool.parameters, params)
    : validateToolCall(tool.parameters, params);
  if (!validation.valid) {
    turnCalls--; sessionCalls--;  // RELEASE — validation failed
    const messages = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    return toolError(
      `Validation failed: ${messages}`,
      'validation',
      'Fix the parameters according to the schema',
    );
  }

  // Permission check
  if (permissions && !permissions.check(call.name, { toolCallId: call.id, params })) {
    turnCalls--; sessionCalls--;  // RELEASE — permission denied
    return toolError(
      `Permission denied for tool "${call.name}"`,
      'permission',
      'Check that the caller has access to this tool',
    );
  }

  // Execute with optional timeout — counts are already claimed
  // (removed the turnCalls++; sessionCalls++; that was here at line 158-159)
  if (timeoutMs !== undefined) {
    // ... timeout logic unchanged ...
  }
  return tool.execute(params);
}
```

### Key Decision: Don't decrement on execution failure

The PRD suggests decrementing on execution failure (`catch { turnCalls--; }`). **I disagree.** A tool that was invoked and failed still consumed a rate-limit slot — it hit the tool's `execute()`, which may have side effects (network calls, writes). Only pre-execution failures (lookup, parse, validate, permission) release the claim.

### Files Changed

| File | Change | Lines Affected |
|------|--------|----------------|
| `packages/core/src/tools/registry.ts` | Move increment up, add decrements on pre-execution bailouts | ~20 lines modified in `execute()` |

### Test Strategy

1. **TOCTOU regression test**: Launch N concurrent `execute()` calls against a registry with `maxCallsPerTurn: 1`. Assert exactly 1 succeeds and N-1 return rate-limit errors.
2. **Decrement on validation failure**: Call with invalid JSON, verify the slot is released (next call succeeds).
3. **No decrement on execution failure**: Tool that throws during execute — verify counter is NOT decremented.
4. **Session limit**: Same pattern with `maxCallsPerSession`.

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Decrement imbalance (counter goes negative) | Low | Medium | All decrement paths are in synchronous code before any await; each has a matching increment |
| Breaking change for tools relying on the bug | Very Low | Low | The old behavior silently exceeded limits — no correct code depends on this |

---

## 2. Parallel Tool Execution (P1)

### Design

Add two optional fields to `AgentLoopConfig` and one to `ToolDefinition`. The parallel execution path is a ~40-line block that replaces the existing `for` loop when `parallel: true`.

#### Type Additions

```typescript
// core/types.ts — no changes needed (ToolCallRequest already has id, name, arguments)

// tools/types.ts — add to ToolDefinition
interface ToolDefinition<TParams = unknown> {
  // ... existing fields ...
  readonly sequential?: boolean;  // Force sequential even in parallel mode
}

// core/agent-loop.ts — AgentLoopConfig additions
interface AgentLoopConfig {
  // ... existing fields ...
  readonly parallel?: boolean;           // default: false
  readonly maxParallelToolCalls?: number; // default: 5
}
```

#### Implementation — agent-loop.ts

Replace lines 237-269 (the `for (const toolCall of toolCalls)` block) with:

```typescript
// Process tool calls — sequential or parallel
if (this.parallel && toolCalls.length > 1) {
  yield* this.executeToolsParallel(toolCalls, iteration, conversation);
} else {
  yield* this.executeToolsSequential(toolCalls, iteration, conversation);
}
```

Two new private methods on `AgentLoop`:

```typescript
private async *executeToolsSequential(
  toolCalls: readonly ToolCallRequest[],
  iteration: number,
  conversation: Message[],
): AsyncGenerator<AgentEvent> {
  // Exact same logic as current lines 237-269
  for (const toolCall of toolCalls) {
    yield { type: 'tool_call', toolCall, iteration };
    let result: unknown;
    try {
      result = this.onToolCall
        ? await this.onToolCall(toolCall)
        : { error: `No onToolCall handler registered for tool "${toolCall.name}"` };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    yield { type: 'tool_result', toolCallId: toolCall.id, result };
    this._totalToolCalls++;
    conversation.push({
      role: 'tool',
      content: typeof result === 'string' ? result : JSON.stringify(result),
      toolCallId: toolCall.id,
    });
  }
}

private async *executeToolsParallel(
  toolCalls: readonly ToolCallRequest[],
  iteration: number,
  conversation: Message[],
): AsyncGenerator<AgentEvent> {
  // Partition: sequential-flagged tools vs parallel-safe tools
  // We need tool definitions to check the sequential flag, but AgentLoop
  // only has onToolCall, not tool definitions. Solution: check via a new
  // optional callback, or simply execute ALL in parallel (the tool itself
  // opts out via ToolDefinition.sequential at the registry level).
  //
  // Simplest approach: AgentLoop doesn't know about ToolDefinition.sequential.
  // Instead, the registry's handler() wrapper can enforce sequential execution
  // internally. But this defeats the purpose — we need to partition at the
  // AgentLoop level.
  //
  // DECISION: Add an optional `isSequentialTool` callback to AgentLoopConfig.
  // The registry provides this via a new method. This keeps AgentLoop ignorant
  // of ToolDefinition internals.

  const sequentialTools: ToolCallRequest[] = [];
  const parallelTools: ToolCallRequest[] = [];

  for (const tc of toolCalls) {
    if (this.isSequentialTool?.(tc.name)) {
      sequentialTools.push(tc);
    } else {
      parallelTools.push(tc);
    }
  }

  // Emit all tool_call events first (deterministic ordering)
  for (const tc of toolCalls) {
    yield { type: 'tool_call', toolCall: tc, iteration };
  }

  // Execute parallel group with concurrency cap
  const results = new Map<string, unknown>();

  // Process in chunks of maxParallelToolCalls
  for (let i = 0; i < parallelTools.length; i += this.maxParallelToolCalls) {
    const chunk = parallelTools.slice(i, i + this.maxParallelToolCalls);
    const settled = await Promise.allSettled(
      chunk.map(async (tc) => {
        let result: unknown;
        try {
          result = this.onToolCall
            ? await this.onToolCall(tc)
            : { error: `No onToolCall handler registered for tool "${tc.name}"` };
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        return { id: tc.id, result };
      }),
    );
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        results.set(entry.value.id, entry.value.result);
      } else {
        // Promise.allSettled never rejects individual entries, but guard anyway
        results.set('unknown', { error: String(entry.reason) });
      }
    }
  }

  // Execute sequential group one-by-one
  for (const tc of sequentialTools) {
    let result: unknown;
    try {
      result = this.onToolCall
        ? await this.onToolCall(tc)
        : { error: `No onToolCall handler registered for tool "${tc.name}"` };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    results.set(tc.id, result);
  }

  // Yield tool_result events in ORIGINAL call order (deterministic)
  for (const tc of toolCalls) {
    const result = results.get(tc.id);
    yield { type: 'tool_result', toolCallId: tc.id, result };
    this._totalToolCalls++;
    conversation.push({
      role: 'tool',
      content: typeof result === 'string' ? result : JSON.stringify(result),
      toolCallId: tc.id,
    });
  }
}
```

#### Registry Addition — isSequential()

```typescript
// registry.ts — add to ToolRegistry interface and implementation
interface ToolRegistry {
  // ... existing methods ...
  isSequential(toolName: string): boolean;
}

// Implementation:
function isSequential(toolName: string): boolean {
  return tools.get(toolName)?.sequential === true;
}
```

#### AgentLoopConfig — additional field

```typescript
interface AgentLoopConfig {
  // ... existing ...
  readonly parallel?: boolean;
  readonly maxParallelToolCalls?: number;
  readonly isSequentialTool?: (name: string) => boolean;
}
```

The user wires it up:

```typescript
const registry = createRegistry();
const loop = new AgentLoop({
  adapter,
  parallel: true,
  onToolCall: registry.handler(),
  isSequentialTool: (name) => registry.isSequential(name),
  tools: registry.schemas(),
});
```

### Files Changed

| File | Change | Lines Affected |
|------|--------|----------------|
| `packages/core/src/core/agent-loop.ts` | Add `parallel`, `maxParallelToolCalls`, `isSequentialTool` to config; extract sequential/parallel methods; dispatch in `run()` | ~80 lines added/modified |
| `packages/core/src/tools/types.ts` | Add `sequential?: boolean` to `ToolDefinition` | 1 line |
| `packages/core/src/tools/registry.ts` | Add `isSequential()` to interface and implementation | ~5 lines |

### Test Strategy

1. **Parallel execution**: 3 tools with 100ms delay each. With `parallel: true`, total time < 200ms (not 300ms).
2. **Sequential fallback**: Same 3 tools with `parallel: false` — total time >= 300ms.
3. **Mixed mode**: 2 parallel + 1 sequential tool. Verify sequential runs after parallel completes.
4. **Concurrency cap**: 10 parallel tools with `maxParallelToolCalls: 2` — verify at most 2 run concurrently.
5. **Event ordering**: Verify all `tool_call` events emitted before `tool_result` events, in original order.
6. **Error isolation**: One parallel tool throws — others still complete and return results.
7. **Rate limit compliance**: With `maxPerTurn: 3` and 5 parallel calls — verify only 3 succeed.
8. **Single tool call**: With `parallel: true` but only 1 tool call — uses sequential path (no overhead).

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Race between parallel tools sharing external state | Medium | High | `sequential: true` opt-out valve; documented |
| Event ordering breaks consumers expecting interleaved call/result | Low | Medium | All tool_call events emitted first, then all tool_result — deterministic |
| `isSequentialTool` callback adds wiring burden | Medium | Low | Optional — defaults to all-parallel if not provided |

---

## 3. `spawnSubAgent()` Utility (P1)

### Design

A single pure function in a new file `orchestration/spawn.ts`. Creates a new `AgentLoop`, runs it to completion, collects all messages, returns frozen result. Zero shared mutable state.

#### Type Definition

```typescript
// orchestration/spawn.ts

import type { AgentAdapter, Message, TokenUsage, ToolCallRequest, ToolSchema } from '../core/types.js';
import { AgentLoop } from '../core/agent-loop.js';

/** Options for spawning a sub-agent. */
export interface SpawnSubAgentOptions {
  readonly adapter: AgentAdapter;
  readonly messages: Message[];
  readonly tools?: ToolSchema[];
  readonly onToolCall?: (call: ToolCallRequest) => Promise<unknown>;
  readonly maxIterations?: number;   // default: 10
  readonly maxTotalTokens?: number;  // budget slice
  readonly signal?: AbortSignal;     // cascade abort from parent
}

/** Result of a sub-agent execution. */
export interface SpawnSubAgentResult {
  readonly messages: readonly Message[];
  readonly usage: TokenUsage;
}
```

#### Implementation

```typescript
export async function spawnSubAgent(
  options: SpawnSubAgentOptions,
): Promise<SpawnSubAgentResult> {
  const loop = new AgentLoop({
    adapter: options.adapter,
    maxIterations: options.maxIterations ?? 10,
    maxTotalTokens: options.maxTotalTokens,
    signal: options.signal,
    tools: options.tools,
    onToolCall: options.onToolCall,
  });

  // Collect conversation messages from events
  const conversation = [...options.messages];

  for await (const event of loop.run(options.messages)) {
    if (event.type === 'message') {
      conversation.push(event.message);
    } else if (event.type === 'tool_result') {
      conversation.push({
        role: 'tool' as const,
        content: typeof event.result === 'string'
          ? event.result
          : JSON.stringify(event.result),
        toolCallId: event.toolCallId,
      });
    }
  }

  return Object.freeze({
    messages: Object.freeze(conversation),
    usage: loop.usage,
  });
}
```

### Key Decision: Use AgentLoop events, not internal conversation

We consume AgentLoop's public event stream to build the conversation. This avoids coupling to internal conversation management and ensures we only see what the loop explicitly yields.

### Files Changed

| File | Change | Lines Affected |
|------|--------|----------------|
| `packages/core/src/orchestration/spawn.ts` | New file | ~45 LOC |
| `packages/core/src/orchestration/index.ts` | Add export | 2 lines |

### Test Strategy

1. **Basic spawn**: Sub-agent with a simple adapter that returns a message. Verify result contains the messages.
2. **Abort propagation**: Pass an AbortSignal, abort it mid-execution. Verify loop terminates.
3. **Token usage**: Verify `result.usage` reflects the sub-agent's cumulative usage.
4. **Tool calls**: Sub-agent calls tools via onToolCall. Verify tool results appear in messages.
5. **Frozen result**: Verify `Object.isFrozen(result)` and `Object.isFrozen(result.messages)`.
6. **Isolation**: Two concurrent sub-agents don't interfere with each other.

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Message duplication (events + internal conversation) | Low | Low | We only use the event stream, not internal state |
| Missing assistant messages with tool calls | Low | Medium | `message` event includes assistant messages with `toolCalls`; we also capture `tool_result` events |

---

## 4. `compactIfNeeded()` Helper (P1)

### Design

A thin wrapper around existing `compress()` and `estimateTokens()` in `context/compress.ts`. Returns messages unchanged if estimated tokens are under `budget * threshold`.

#### Type Definition

```typescript
// In context/compress.ts — added alongside compress()

export interface CompactOptions {
  readonly budget: number;
  readonly threshold?: number;           // default: 0.75
  readonly strategy: string | CompressionStrategy;
  readonly windowSize?: number;
  readonly preserve?: (msg: Message) => boolean;
  readonly summarizer?: (messages: Message[]) => Promise<string>;
}
```

#### Implementation

```typescript
/**
 * Conditionally compress messages if estimated token count exceeds threshold.
 *
 * Returns messages unchanged if under `budget * threshold`. Otherwise,
 * compresses using the specified strategy.
 *
 * Note: The default token estimator is heuristic-based (~20-40% margin).
 * For precise counting, register a real tokenizer via `registerTokenizer()`.
 *
 * @example
 * ```ts
 * // Manual equivalent (5 lines):
 * // const tokens = countTokens('default', messages);
 * // if (tokens > budget * 0.75) {
 * //   messages = await compress(messages, { strategy: 'sliding-window', budget });
 * // }
 *
 * const result = await compactIfNeeded(messages, {
 *   budget: 100_000,
 *   strategy: 'sliding-window',
 *   windowSize: 20,
 * });
 * ```
 */
export async function compactIfNeeded(
  messages: readonly Message[],
  options: CompactOptions,
): Promise<Message[]> {
  const threshold = options.threshold ?? 0.75;
  const triggerAt = options.budget * threshold;

  // Estimate total tokens
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += msgTokens(msg);
  }

  // Under threshold — return unchanged (shallow copy for type consistency)
  if (totalTokens <= triggerAt) {
    return [...messages];
  }

  // Over threshold — compress
  return compress(messages, {
    strategy: options.strategy,
    budget: options.budget,
    preserve: options.preserve,
    summarizer: options.summarizer,
    windowSize: options.windowSize,
  });
}
```

### Key Decision: Reuse `msgTokens()` already in compress.ts

The `msgTokens()` helper (line 15-17 in compress.ts) already wraps `estimateTokens('default', msg.content)`. We use it directly — no need for a new import or utility.

### Files Changed

| File | Change | Lines Affected |
|------|--------|----------------|
| `packages/core/src/context/compress.ts` | Add `CompactOptions` type and `compactIfNeeded()` function | ~25 LOC added at bottom |
| `packages/core/src/context/index.ts` | Add exports for `compactIfNeeded` and `CompactOptions` | 2 lines |

### Test Strategy

1. **Under threshold**: 10 messages, budget 100K — returns unchanged array.
2. **Over threshold**: Many messages exceeding 75% of budget — returns compressed result.
3. **Custom threshold**: Set threshold to 0.5 — triggers compression earlier.
4. **Preserve predicate**: System messages preserved through compression.
5. **Strategy passthrough**: Verify the correct compression strategy is invoked.

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Token estimation inaccuracy triggers unnecessary compression | Medium | Low | Documented ~20-40% margin; users can register real tokenizer |
| Users assume exact token counts | Medium | Low | JSDoc warning + manual pattern documented |

---

## 5. MCP Client (P2)

### Design

New package `@harness-one/mcp` with zero impact on core. Follows the exact same pattern as `@harness-one/anthropic` and `@harness-one/openai` integration packages.

#### Package Structure

```
packages/mcp/
  package.json
  tsconfig.json
  src/
    index.ts           — public exports
    client.ts          — createMCPClient factory
    transport.ts       — stdio and SSE transport wrappers
    mapping.ts         — MCP schema ↔ ToolDefinition conversion
```

#### API Surface

```typescript
// packages/mcp/src/client.ts

export interface MCPClientConfig {
  readonly transport: 'stdio' | 'sse';
  // stdio options
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  // sse options
  readonly url?: string;
  readonly headers?: Record<string, string>;
  // common options
  readonly namespace?: string;        // prefix for tool names (default: server name)
  readonly timeout?: number;          // connection timeout ms (default: 30000)
}

export interface MCPClient {
  /** List available tools from the MCP server. */
  listTools(): Promise<MCPToolInfo[]>;
  /** Convert an MCP tool to a harness-one ToolDefinition. */
  toToolDefinition(tool: MCPToolInfo): ToolDefinition;
  /** Convert all discovered tools to ToolDefinitions. */
  toToolDefinitions(): Promise<ToolDefinition[]>;
  /** Close the connection and clean up resources. */
  close(): Promise<void>;
}

export interface MCPToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}
```

#### Implementation Sketch — client.ts

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolDefinition, ToolResult } from 'harness-one/tools';
import { toolSuccess, toolError } from 'harness-one/tools';

export async function createMCPClient(config: MCPClientConfig): Promise<MCPClient> {
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({ command: config.command!, args: config.args, env: config.env })
    : new SSEClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });

  const client = new Client({ name: 'harness-one', version: '1.0.0' }, {});
  await client.connect(transport);

  const namespace = config.namespace ?? 'mcp';

  return {
    async listTools(): Promise<MCPToolInfo[]> {
      const response = await client.listTools();
      return response.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as JsonSchema,
      }));
    },

    toToolDefinition(tool: MCPToolInfo): ToolDefinition {
      const qualifiedName = `${namespace}.${tool.name}`;
      return {
        name: qualifiedName,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(params: unknown): Promise<ToolResult> {
          try {
            const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> });
            return toolSuccess(result.content);
          } catch (err) {
            return toolError(
              err instanceof Error ? err.message : String(err),
              'internal',
              'Check MCP server logs',
              true,
            );
          }
        },
      };
    },

    async toToolDefinitions(): Promise<ToolDefinition[]> {
      const tools = await this.listTools();
      return tools.map(t => this.toToolDefinition(t));
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
```

#### Namespace Strategy

MCP tools are registered as `{namespace}.{toolName}` (e.g., `filesystem.readFile`). This leverages the existing `registry.list(namespace)` filtering in `registry.ts:80-84`.

### Files Changed

| File | Change | Lines Affected |
|------|--------|----------------|
| `packages/mcp/package.json` | New file | ~20 lines |
| `packages/mcp/tsconfig.json` | New file | ~15 lines |
| `packages/mcp/src/index.ts` | New file — public exports | ~10 lines |
| `packages/mcp/src/client.ts` | New file — client factory | ~80 lines |
| `packages/mcp/src/transport.ts` | New file — transport abstraction | ~30 lines |
| `packages/mcp/src/mapping.ts` | New file — schema conversion | ~40 lines |

### Test Strategy

1. **Stdio transport**: Spawn a mock MCP server process, connect, list tools, call a tool, close.
2. **SSE transport**: Mock HTTP server, connect via SSE, list tools.
3. **Tool mapping**: Verify MCP tool schema correctly converts to ToolDefinition.
4. **Namespace**: Verify tools are namespaced as `namespace.toolName`.
5. **Error handling**: Server returns error — verify ToolResult error shape.
6. **Cleanup**: Close client — verify process/connection is terminated.
7. **Zero core impact**: Verify core package.json has no new dependencies.

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MCP SDK breaking changes | Medium | Medium | Pin to specific SDK version; peer dependency |
| Stdio process leak on unclean shutdown | Medium | Medium | Close method + AbortController in transport |
| Schema incompatibility (MCP JSON Schema vs harness-one JsonSchema) | Low | Medium | Mapping layer with validation |

---

## Architecture Decision Records

### ADR-01: Pre-Claim Rate Limiting (Not Try/Finally)

**Status**: Proposed

**Context**: The PRD suggests `try { ... } catch { turnCalls--; }` wrapping the entire execution. This means failed executions release their rate-limit slot.

**Decision**: Pre-claim with decrements only for pre-execution failures (lookup, parse, validate, permission). Tool execution failures do NOT release the slot.

**Rationale**: A tool that reached `execute()` consumed a rate-limit slot. It may have made network calls, written to disk, or caused side effects. Releasing the slot on failure would allow an attacker to exceed limits by triggering intentional failures.

**Consequences**:
- Positive: Rate limits accurately reflect actual tool invocations
- Negative: A tool that fails at execute() "wastes" a slot
- Risk: None — this is strictly safer than the alternative

### ADR-02: isSequentialTool Callback (Not Introspection)

**Status**: Proposed

**Context**: AgentLoop needs to know which tools should run sequentially. Two options: (A) pass tool definitions to AgentLoop so it can check `sequential` directly, (B) provide a callback.

**Decision**: Option B — `isSequentialTool?: (name: string) => boolean` callback on AgentLoopConfig.

**Rationale**: AgentLoop currently knows nothing about `ToolDefinition`. It only receives `ToolSchema[]` for the LLM and an `onToolCall` handler. Adding `ToolDefinition` awareness would break the clean separation between core and tools modules. A callback keeps the boundary intact.

**Consequences**:
- Positive: No new coupling between `core/` and `tools/` modules
- Positive: Users without a registry can provide custom logic
- Negative: Slightly more wiring in user code
- Risk: If callback is not provided, all tools run in parallel — documented behavior

**Alternatives Considered**:
- **Pass ToolDefinition[] to AgentLoop**: Rejected — violates zero cross-module imports principle
- **Registry-level parallelism**: Rejected — registry shouldn't control execution order; that's the loop's responsibility

### ADR-03: spawnSubAgent Uses Event Stream (Not Internal State)

**Status**: Proposed

**Context**: `spawnSubAgent` needs to collect the full conversation. Two options: (A) access AgentLoop internal conversation array, (B) reconstruct from events.

**Decision**: Option B — consume the public `AsyncGenerator<AgentEvent>` from `loop.run()`.

**Rationale**: AgentLoop's internal conversation is not exposed (rightly so). The event stream is the public contract. Building from events also means spawnSubAgent is forward-compatible with any future AgentLoop changes that don't alter the event stream.

**Consequences**:
- Positive: No coupling to AgentLoop internals
- Positive: Forward-compatible
- Negative: Slightly more complex message reconstruction (handle `message` + `tool_result` events)
- Risk: If event stream changes shape, spawnSubAgent needs updating — but same is true for all consumers

### ADR-04: compactIfNeeded in compress.ts (Not New File)

**Status**: Proposed

**Context**: `compactIfNeeded` is ~15 LOC that wraps `compress()` + `msgTokens()`. Should it be a new file or added to `compress.ts`?

**Decision**: Add to `compress.ts` — same file as `compress()`.

**Rationale**: It uses `msgTokens()` (private to compress.ts) and `compress()`. Putting it in the same file avoids exporting `msgTokens()` or creating a new file for 15 lines. It's conceptually "compression with a guard condition."

**Consequences**:
- Positive: No new files, no new exports of internal helpers
- Positive: Co-located with the function it wraps
- Negative: compress.ts grows by ~25 lines (from ~249 to ~274)
- Risk: None

### ADR-05: MCP as Separate Package (Following Existing Pattern)

**Status**: Proposed

**Context**: MCP client needs `@modelcontextprotocol/sdk` as a dependency. Core package has zero runtime dependencies.

**Decision**: `@harness-one/mcp` as a separate package, same pattern as `@harness-one/anthropic` and `@harness-one/openai`.

**Rationale**: This is the established pattern. MCP SDK is a peer dependency. Core remains zero-dependency.

**Consequences**:
- Positive: Core remains zero-dependency
- Positive: Users who don't need MCP don't pay the cost
- Positive: MCP SDK version can evolve independently
- Negative: Users install an extra package
- Risk: MCP SDK is still evolving — version churn possible

---

## Migration Path

No migration needed. All changes are additive:

1. **P0 (Rate limiter)**: Internal bug fix. No API changes. No user action required.
2. **P1 (Parallel tools)**: New opt-in config fields. Default `false` = zero behavioral change.
3. **P1 (spawnSubAgent)**: New export from `orchestration/`. No changes to existing code.
4. **P1 (compactIfNeeded)**: New export from `context/`. No changes to existing code.
5. **P2 (MCP)**: New package. Install when needed.

---

## Estimated Effort

| Component | New LOC | Modified LOC | Dependencies | Effort |
|-----------|---------|-------------|--------------|--------|
| P0: Rate limiter fix | 0 | ~20 | None | 0.5 day |
| P1: Parallel tools | ~80 | ~10 | P0 | 1.5 days |
| P1: spawnSubAgent | ~45 | ~2 | None | 0.5 day |
| P1: compactIfNeeded | ~25 | ~2 | None | 0.5 day |
| P2: MCP client | ~200 | 0 | `@modelcontextprotocol/sdk` | 2 days |
| **Total** | **~350** | **~34** | | **5 days** |

---

## Design Principles Applied

1. **Smallest diff possible**: P0 is ~20 modified lines. P1 helpers are each under 50 LOC.
2. **Reuse existing patterns**: `spawnSubAgent` wraps `AgentLoop` — no new execution model. `compactIfNeeded` wraps `compress()` — no new compression logic.
3. **Zero new abstractions**: No new base classes, no new interfaces beyond what the PRD requires.
4. **Defensive defaults**: `parallel: false`, `threshold: 0.75`, `maxIterations: 10` for sub-agents.
5. **Module isolation preserved**: No new cross-module imports. `isSequentialTool` callback avoids core→tools coupling.
6. **Errors as data**: Parallel tool failures returned as `ToolResult` errors, not thrown exceptions.
7. **Frozen returns**: `spawnSubAgent` result is `Object.freeze()`-d, matching project convention.
